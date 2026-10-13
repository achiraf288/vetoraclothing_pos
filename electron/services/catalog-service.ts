import type { Db } from '../db/connection';
import { writeAudit, type AuditActor } from '../db/audit';
import { assertMinor, formatMoney, MoneyError } from '../db/money';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type {
  ActivityEntry,
  CategoryDto,
  CreateProductRequest,
  Page,
  ProductDetail,
  ProductDto,
  ProductInput,
  ProductListItem,
  ProductListQuery,
  ProductSort,
  VariantDto,
  VariantInput,
} from '../shared/api';
import { recordMovement } from './inventory-core';
import { assertCan, can, type Actor } from './permissions';

export const IMAGE_URL_PREFIX = 'maison://app/product-images/';

const MAX_PAGE_SIZE = 100;
const SORT_SQL: Record<ProductSort, string> = {
  name: 'p.name COLLATE NOCASE',
  sku: 'p.sku COLLATE NOCASE',
  category: 'category_name COLLATE NOCASE',
  stock: 'total_stock',
  price: 'min_price',
  created: 'p.created_at',
};

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category_id: number | null;
  category_name: string | null;
  brand: string;
  description: string;
  image_path: string | null;
  default_cost_minor: number;
  default_price_minor: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  id: number;
  product_id: number;
  sku: string;
  barcode: string | null;
  size: string;
  colour: string;
  cost_minor: number;
  price_minor: number;
  stock_qty: number;
  reorder_threshold: number;
  is_active: number;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const variantLabel = (v: { size: string; colour: string }): string =>
  [v.size, v.colour].filter(Boolean).join(' / ') || 'Default';

function toAuditActor(actor: Actor): AuditActor {
  return { userId: actor.userId, username: actor.username };
}

function cleanText(value: string, label: string, max: number, required = false): string {
  const text = (value ?? '').trim();
  if (required && text.length === 0) throw new AppError('VALIDATION', `${label} is required.`, label.toLowerCase());
  if (text.length > max) throw new AppError('VALIDATION', `${label} must be at most ${max} characters.`, label.toLowerCase());
  return text;
}

function money(value: number, label: string, field: string): number {
  try {
    assertMinor(value, label);
  } catch (e) {
    if (e instanceof MoneyError) throw new AppError('VALIDATION', `${label} must be a valid amount.`, field);
    throw e;
  }
  if (value < 0) throw new AppError('VALIDATION', `${label} cannot be negative.`, field);
  if (value > 100_000_000_000) throw new AppError('VALIDATION', `${label} is too large.`, field);
  return value;
}

export class CatalogService {
  private readonly settings: SettingsRepo;

  constructor(private readonly db: Db) {
    this.settings = new SettingsRepo(db);
  }

  // ───────────── categories ─────────────
  listCategories(actor: Actor): CategoryDto[] {
    assertCan(actor, 'catalog.read');
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.is_active,
                (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
           FROM categories c ORDER BY c.name COLLATE NOCASE`,
      )
      .all() as Array<{ id: number; name: string; is_active: number; product_count: number }>;
    return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active === 1, productCount: r.product_count }));
  }

  saveCategory(actor: Actor, req: { id?: number; name: string; isActive?: boolean }): CategoryDto {
    assertCan(actor, 'catalog.write');
    const name = cleanText(req.name, 'Name', 60, true);
    const clash = this.db
      .prepare('SELECT id FROM categories WHERE name = ? AND id IS NOT ?')
      .get(name, req.id ?? null) as { id: number } | undefined;
    if (clash) throw new AppError('DUPLICATE', 'A category with that name already exists.', 'name');

    let id = req.id;
    this.db.transaction(() => {
      if (id === undefined) {
        id = Number(this.db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid);
        writeAudit(this.db, toAuditActor(actor), 'category.create', 'category', id, { name });
      } else {
        const existing = this.db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
        if (!existing) throw new AppError('NOT_FOUND', 'Category not found.');
        this.db
          .prepare('UPDATE categories SET name = ?, is_active = COALESCE(?, is_active) WHERE id = ?')
          .run(name, req.isActive === undefined ? null : req.isActive ? 1 : 0, id);
        writeAudit(this.db, toAuditActor(actor), 'category.update', 'category', id, { name, isActive: req.isActive });
      }
    })();
    return this.listCategories(actor).find((c) => c.id === id)!;
  }

  // ───────────── products: reading ─────────────
  listProducts(actor: Actor, query: ProductListQuery = {}): Page<ProductListItem> {
    assertCan(actor, 'catalog.read');
    const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 20), 1), MAX_PAGE_SIZE);
    const page = Math.max(Math.trunc(query.page ?? 1), 1);
    const where: string[] = [];
    const params: Array<string | number> = [];

    const status = query.status ?? 'active';
    if (status === 'active') where.push('p.is_active = 1');
    else if (status === 'archived') where.push('p.is_active = 0');

    if (query.categoryId !== undefined && query.categoryId !== null) {
      where.push('p.category_id = ?');
      params.push(query.categoryId);
    }

    const search = (query.search ?? '').trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push(
        `(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id
                      AND (v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\' OR v.colour LIKE ? ESCAPE '\\')))`,
      );
      params.push(like, like, like, like, like, like);
    }

    if (query.lowStockOnly) {
      where.push(
        `EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1 AND v.stock_qty <= v.reorder_threshold)`,
      );
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM products p ${whereSql}`).get(...params) as { n: number }
    ).n;

    // `sort` is looked up in a fixed map, never interpolated from user input.
    const orderBy = SORT_SQL[query.sort ?? 'name'] ?? SORT_SQL.name;
    const dir = query.dir === 'desc' ? 'DESC' : 'ASC';

    const rows = this.db
      .prepare(
        `SELECT p.id, p.sku, p.name, p.brand, p.category_id, c.name AS category_name, p.image_path,
                p.is_active, p.created_at,
                (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1) AS variant_count,
                (SELECT COALESCE(SUM(v.stock_qty), 0) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1) AS total_stock,
                (SELECT MIN(v.price_minor) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1) AS min_price,
                (SELECT MAX(v.price_minor) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1) AS max_price,
                (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1 AND v.stock_qty <= v.reorder_threshold) AS low_stock_variants
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           ${whereSql}
          ORDER BY ${orderBy} ${dir}, p.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Array<{
      id: number;
      sku: string;
      name: string;
      brand: string;
      category_id: number | null;
      category_name: string | null;
      image_path: string | null;
      is_active: number;
      created_at: string;
      variant_count: number;
      total_stock: number;
      min_price: number | null;
      max_price: number | null;
      low_stock_variants: number;
    }>;

    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        brand: r.brand,
        categoryId: r.category_id,
        categoryName: r.category_name,
        imageUrl: r.image_path ? IMAGE_URL_PREFIX + r.image_path : null,
        isActive: r.is_active === 1,
        variantCount: r.variant_count,
        totalStock: r.total_stock,
        minPriceMinor: r.min_price,
        maxPriceMinor: r.max_price,
        lowStockVariants: r.low_stock_variants,
        createdAt: r.created_at,
      })),
    };
  }

  getProduct(actor: Actor, id: number): ProductDetail {
    assertCan(actor, 'catalog.read');
    const detail = this.loadDetail(id);
    // Cost prices are business-sensitive: only roles that can see reports get them.
    if (!can(actor, 'reports.read')) {
      detail.product.defaultCostMinor = 0;
      detail.variants.forEach((v) => (v.costMinor = 0));
    }
    return detail;
  }

  checkSku(actor: Actor, sku: string, excludeProductId: number | null = null): boolean {
    assertCan(actor, 'catalog.read');
    const trimmed = sku.trim();
    if (!trimmed) return false;
    return !this.productSkuTaken(trimmed, excludeProductId);
  }

  // ───────────── products: writing ─────────────
  createProduct(actor: Actor, req: CreateProductRequest): ProductDetail {
    assertCan(actor, 'catalog.write');
    const product = this.validateProduct(req.product);
    const variants = req.variants.map((v) => this.validateVariant(v, true));
    this.assertVariantsUniqueWithinRequest(variants);

    if (this.productSkuTaken(product.sku, null)) {
      throw new AppError('DUPLICATE', 'That SKU is already used by another product.', 'sku');
    }

    const id = this.db.transaction((): number => {
      const productId = Number(
        this.db
          .prepare(
            `INSERT INTO products (sku, name, category_id, brand, description, default_cost_minor, default_price_minor)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            product.sku,
            product.name,
            product.categoryId,
            product.brand,
            product.description,
            product.defaultCostMinor,
            product.defaultPriceMinor,
          ).lastInsertRowid,
      );
      writeAudit(this.db, toAuditActor(actor), 'product.create', 'product', productId, {
        sku: product.sku,
        name: product.name,
      });
      for (const v of variants) this.insertVariant(actor, productId, v);
      return productId;
    })();
    return this.loadDetail(id);
  }

  updateProduct(actor: Actor, id: number, input: ProductInput): ProductDetail {
    assertCan(actor, 'catalog.write');
    const existing = this.requireProductRow(id);
    if (!existing.is_active) throw new AppError('CONFLICT', 'Restore this product before editing it.');
    const next = this.validateProduct(input);
    if (this.productSkuTaken(next.sku, id)) {
      throw new AppError('DUPLICATE', 'That SKU is already used by another product.', 'sku');
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const track = (field: string, from: unknown, to: unknown): void => {
      if (from !== to) changes[field] = { from, to };
    };
    track('sku', existing.sku, next.sku);
    track('name', existing.name, next.name);
    track('categoryId', existing.category_id, next.categoryId);
    track('brand', existing.brand, next.brand);
    track('description', existing.description, next.description);
    track('defaultCostMinor', existing.default_cost_minor, next.defaultCostMinor);
    track('defaultPriceMinor', existing.default_price_minor, next.defaultPriceMinor);

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE products SET sku = ?, name = ?, category_id = ?, brand = ?, description = ?,
                  default_cost_minor = ?, default_price_minor = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`,
        )
        .run(next.sku, next.name, next.categoryId, next.brand, next.description, next.defaultCostMinor, next.defaultPriceMinor, id);
      if (Object.keys(changes).length) {
        writeAudit(this.db, toAuditActor(actor), 'product.update', 'product', id, { changes });
      }
    })();
    return this.loadDetail(id);
  }

  setProductArchived(actor: Actor, id: number, archived: boolean): ProductDetail {
    assertCan(actor, 'catalog.write');
    this.requireProductRow(id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE products SET is_active = ?, archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(archived ? 0 : 1, archived ? new Date().toISOString() : null, id);
      writeAudit(this.db, toAuditActor(actor), archived ? 'product.archive' : 'product.unarchive', 'product', id);
    })();
    return this.loadDetail(id);
  }

  createVariant(actor: Actor, productId: number, input: VariantInput): ProductDetail {
    assertCan(actor, 'catalog.write');
    const product = this.requireProductRow(productId);
    if (!product.is_active) throw new AppError('CONFLICT', 'Restore this product before adding variants.');
    const v = this.validateVariant(input, true);
    this.db.transaction(() => this.insertVariant(actor, productId, v))();
    return this.loadDetail(productId);
  }

  updateVariant(actor: Actor, variantId: number, input: Omit<VariantInput, 'openingStock'>): ProductDetail {
    assertCan(actor, 'catalog.write');
    const existing = this.requireVariantRow(variantId);
    const next = this.validateVariant({ ...input, openingStock: 0 }, false);
    this.assertVariantUnique(next, existing.product_id, variantId);

    const label = variantLabel(next);
    const sym = this.moneyFormatter();
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const track = (field: string, from: unknown, to: unknown): void => {
      if (from !== to) changes[field] = { from, to };
    };
    track('sku', existing.sku, next.sku);
    track('barcode', existing.barcode, next.barcode);
    track('size', existing.size, next.size);
    track('colour', existing.colour, next.colour);
    track('reorderThreshold', existing.reorder_threshold, next.reorderThreshold);

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE product_variants SET sku = ?, barcode = ?, size = ?, colour = ?, cost_minor = ?, price_minor = ?,
                  reorder_threshold = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`,
        )
        .run(next.sku, next.barcode, next.size, next.colour, next.costMinor, next.priceMinor, next.reorderThreshold, variantId);

      if (Object.keys(changes).length) {
        writeAudit(this.db, toAuditActor(actor), 'variant.update', 'variant', variantId, { label, changes });
      }
      if (existing.price_minor !== next.priceMinor) {
        writeAudit(this.db, toAuditActor(actor), 'variant.price_change', 'variant', variantId, {
          label,
          from: existing.price_minor,
          to: next.priceMinor,
          summary: `${sym(existing.price_minor)} → ${sym(next.priceMinor)}`,
        });
      }
      if (existing.cost_minor !== next.costMinor) {
        writeAudit(this.db, toAuditActor(actor), 'variant.cost_change', 'variant', variantId, {
          label,
          from: existing.cost_minor,
          to: next.costMinor,
          summary: `${sym(existing.cost_minor)} → ${sym(next.costMinor)}`,
        });
      }
    })();
    return this.loadDetail(existing.product_id);
  }

  setVariantArchived(actor: Actor, variantId: number, archived: boolean): ProductDetail {
    assertCan(actor, 'catalog.write');
    const existing = this.requireVariantRow(variantId);
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE product_variants SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(archived ? 0 : 1, variantId);
      writeAudit(this.db, toAuditActor(actor), archived ? 'variant.archive' : 'variant.unarchive', 'variant', variantId, {
        label: variantLabel(existing),
      });
    })();
    return this.loadDetail(existing.product_id);
  }

  /** Called by the image store after a file has been safely copied into place. */
  setImagePath(actor: Actor, productId: number, fileName: string | null): { previous: string | null } {
    assertCan(actor, 'catalog.write');
    const existing = this.requireProductRow(productId);
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE products SET image_path = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(fileName, productId);
      writeAudit(this.db, toAuditActor(actor), fileName ? 'product.image_set' : 'product.image_remove', 'product', productId);
    })();
    return { previous: existing.image_path };
  }

  // ───────────── history ─────────────
  getHistory(actor: Actor, productId: number, limit = 200): ActivityEntry[] {
    assertCan(actor, 'audit.read');
    this.requireProductRow(productId);
    const sym = this.moneyFormatter();

    const audits = this.db
      .prepare(
        `SELECT created_at, username, action, entity_type, details FROM audit_logs
          WHERE (entity_type = 'product' AND entity_id = ?)
             OR (entity_type = 'variant' AND CAST(entity_id AS INTEGER) IN (SELECT id FROM product_variants WHERE product_id = ?))
          ORDER BY id DESC LIMIT ?`,
      )
      .all(String(productId), productId, limit) as Array<{
      created_at: string;
      username: string;
      action: string;
      entity_type: string;
      details: string;
    }>;

    const movements = this.db
      .prepare(
        `SELECT m.created_at, m.movement_type, m.quantity_delta, m.balance_after, m.reason, v.size, v.colour, u.username
           FROM stock_movements m
           JOIN product_variants v ON v.id = m.variant_id
           LEFT JOIN users u ON u.id = m.user_id
          WHERE v.product_id = ?
          ORDER BY m.id DESC LIMIT ?`,
      )
      .all(productId, limit) as Array<{
      created_at: string;
      movement_type: string;
      quantity_delta: number;
      balance_after: number | null;
      reason: string | null;
      size: string;
      colour: string;
      username: string | null;
    }>;

    const entries: ActivityEntry[] = [
      ...audits.map((a): ActivityEntry => {
        const d = JSON.parse(a.details) as Record<string, unknown>;
        return { at: a.created_at, kind: 'audit', actor: a.username || 'system', action: a.action, summary: summariseAudit(a.action, d, sym) };
      }),
      ...movements.map(
        (m): ActivityEntry => ({
          at: m.created_at,
          kind: 'stock',
          actor: m.username ?? 'system',
          action: `stock.${m.movement_type}`,
          summary:
            `${MOVEMENT_LABELS[m.movement_type] ?? m.movement_type}: ${m.quantity_delta > 0 ? '+' : ''}${m.quantity_delta} ` +
            `(${variantLabel(m)}), balance ${m.balance_after ?? '?'}` +
            (m.reason ? ` — ${m.reason}` : ''),
        }),
      ),
    ];
    return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  }

  // ───────────── internals ─────────────
  private moneyFormatter(): (minor: number) => string {
    const decimals = this.settings.getInt('currency.decimals', 2);
    const symbol = this.settings.get('currency.symbol') ?? '';
    return (minor) => formatMoney(minor, { decimals, symbol });
  }

  private validateProduct(input: ProductInput): ProductInput {
    const sku = cleanText(input.sku, 'SKU', 40, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(sku)) {
      throw new AppError('VALIDATION', 'SKU may contain letters, numbers and . _ - / only.', 'sku');
    }
    if (input.categoryId !== null && input.categoryId !== undefined) {
      const cat = this.db.prepare('SELECT id FROM categories WHERE id = ?').get(input.categoryId);
      if (!cat) throw new AppError('VALIDATION', 'Choose a valid category.', 'categoryId');
    }
    return {
      sku,
      name: cleanText(input.name, 'Name', 120, true),
      categoryId: input.categoryId ?? null,
      brand: cleanText(input.brand ?? '', 'Brand', 60),
      description: cleanText(input.description ?? '', 'Description', 2000),
      defaultCostMinor: money(input.defaultCostMinor, 'Default cost price', 'defaultCostMinor'),
      defaultPriceMinor: money(input.defaultPriceMinor, 'Default selling price', 'defaultPriceMinor'),
    };
  }

  private validateVariant(input: VariantInput, creating: boolean): Required<Omit<VariantInput, 'openingStock'>> & { openingStock: number } {
    const sku = cleanText(input.sku, 'SKU', 50, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(sku)) {
      throw new AppError('VALIDATION', 'Variant SKU may contain letters, numbers and . _ - / only.', 'sku');
    }
    const barcodeRaw = cleanText(input.barcode ?? '', 'Barcode', 64);
    if (barcodeRaw && !/^[A-Za-z0-9._\-]+$/.test(barcodeRaw)) {
      throw new AppError('VALIDATION', 'Barcode may contain letters, numbers and . _ - only.', 'barcode');
    }
    const reorder = input.reorderThreshold;
    if (!Number.isInteger(reorder) || reorder < 0 || reorder > 100_000) {
      throw new AppError('VALIDATION', 'Reorder threshold must be a whole number of 0 or more.', 'reorderThreshold');
    }
    let opening = 0;
    if (creating && input.openingStock !== undefined) {
      if (!Number.isInteger(input.openingStock) || input.openingStock < 0 || input.openingStock > 1_000_000) {
        throw new AppError('VALIDATION', 'Opening stock must be a whole number of 0 or more.', 'openingStock');
      }
      opening = input.openingStock;
    }
    return {
      sku,
      barcode: barcodeRaw || (null as unknown as string),
      size: cleanText(input.size ?? '', 'Size', 20),
      colour: cleanText(input.colour ?? '', 'Colour', 30),
      costMinor: money(input.costMinor, 'Cost price', 'costMinor'),
      priceMinor: money(input.priceMinor, 'Selling price', 'priceMinor'),
      reorderThreshold: reorder,
      openingStock: opening,
    };
  }

  private assertVariantsUniqueWithinRequest(variants: Array<{ sku: string; barcode: string | null; size: string; colour: string }>): void {
    const skus = new Set<string>();
    const barcodes = new Set<string>();
    const combos = new Set<string>();
    for (const v of variants) {
      const sku = v.sku.toLowerCase();
      if (skus.has(sku)) throw new AppError('DUPLICATE', `Variant SKU "${v.sku}" is used more than once.`, 'sku');
      skus.add(sku);
      if (v.barcode) {
        const b = v.barcode.toLowerCase();
        if (barcodes.has(b)) throw new AppError('DUPLICATE', `Barcode "${v.barcode}" is used more than once.`, 'barcode');
        barcodes.add(b);
      }
      const combo = `${v.size.toLowerCase()}|${v.colour.toLowerCase()}`;
      if (combos.has(combo)) {
        throw new AppError('DUPLICATE', `There are two variants for ${variantLabel(v)}.`, 'size');
      }
      combos.add(combo);
    }
  }

  private assertVariantUnique(
    v: { sku: string; barcode: string | null; size: string; colour: string },
    productId: number,
    excludeVariantId: number | null,
  ): void {
    const skuClash = this.db
      .prepare('SELECT id FROM product_variants WHERE sku = ? AND id IS NOT ?')
      .get(v.sku, excludeVariantId);
    if (skuClash) throw new AppError('DUPLICATE', 'That variant SKU is already in use.', 'sku');
    if (v.barcode) {
      const bc = this.db
        .prepare('SELECT id FROM product_variants WHERE barcode = ? AND id IS NOT ?')
        .get(v.barcode, excludeVariantId);
      if (bc) throw new AppError('DUPLICATE', 'That barcode is already assigned to another variant.', 'barcode');
    }
    const combo = this.db
      .prepare('SELECT id FROM product_variants WHERE product_id = ? AND size = ? AND colour = ? AND id IS NOT ?')
      .get(productId, v.size, v.colour, excludeVariantId);
    if (combo) {
      throw new AppError('DUPLICATE', `This product already has a ${variantLabel(v)} variant.`, 'size');
    }
  }

  private insertVariant(
    actor: Actor,
    productId: number,
    v: { sku: string; barcode: string | null; size: string; colour: string; costMinor: number; priceMinor: number; reorderThreshold: number; openingStock: number },
  ): number {
    this.assertVariantUnique(v, productId, null);
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO product_variants (product_id, sku, barcode, size, colour, cost_minor, price_minor, reorder_threshold)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(productId, v.sku, v.barcode, v.size, v.colour, v.costMinor, v.priceMinor, v.reorderThreshold).lastInsertRowid,
    );
    writeAudit(this.db, toAuditActor(actor), 'variant.create', 'variant', id, {
      label: variantLabel(v),
      sku: v.sku,
      priceMinor: v.priceMinor,
      costMinor: v.costMinor,
    });
    if (v.openingStock > 0) {
      recordMovement(this.db, {
        variantId: id,
        type: 'opening_stock',
        quantityDelta: v.openingStock,
        unitCostMinor: v.costMinor,
        reason: 'Opening stock',
        refType: 'manual',
        userId: actor.userId,
      });
    }
    return id;
  }

  private productSkuTaken(sku: string, excludeId: number | null): boolean {
    return !!this.db.prepare('SELECT id FROM products WHERE sku = ? AND id IS NOT ?').get(sku, excludeId);
  }

  private requireProductRow(id: number): ProductRow {
    const row = this.db
      .prepare(
        `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
      )
      .get(id) as ProductRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Product not found.');
    return row;
  }

  private requireVariantRow(id: number): VariantRow {
    const row = this.db.prepare('SELECT * FROM product_variants WHERE id = ?').get(id) as VariantRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Variant not found.');
    return row;
  }

  private loadDetail(id: number): ProductDetail {
    const p = this.requireProductRow(id);
    const variants = this.db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY is_active DESC, colour COLLATE NOCASE, id')
      .all(id) as VariantRow[];
    const product: ProductDto = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      categoryId: p.category_id,
      categoryName: p.category_name,
      brand: p.brand,
      description: p.description,
      imageUrl: p.image_path ? IMAGE_URL_PREFIX + p.image_path : null,
      defaultCostMinor: p.default_cost_minor,
      defaultPriceMinor: p.default_price_minor,
      isActive: p.is_active === 1,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
    return {
      product,
      variants: variants.map(
        (v): VariantDto => ({
          id: v.id,
          productId: v.product_id,
          sku: v.sku,
          barcode: v.barcode,
          size: v.size,
          colour: v.colour,
          costMinor: v.cost_minor,
          priceMinor: v.price_minor,
          stockQty: v.stock_qty,
          reorderThreshold: v.reorder_threshold,
          isActive: v.is_active === 1,
        }),
      ),
    };
  }
}

const MOVEMENT_LABELS: Record<string, string> = {
  opening_stock: 'Opening stock',
  purchase_receipt: 'Purchase received',
  sale: 'Sold',
  sale_cancellation: 'Sale cancelled',
  customer_return: 'Customer return',
  supplier_return: 'Returned to supplier',
  adjustment_increase: 'Adjustment (increase)',
  adjustment_decrease: 'Adjustment (decrease)',
  damaged: 'Damaged',
  lost: 'Lost',
};

function summariseAudit(action: string, d: Record<string, unknown>, fmt: (n: number) => string): string {
  const label = typeof d['label'] === 'string' ? (d['label'] as string) : '';
  const changed = d['changes'] && typeof d['changes'] === 'object' ? Object.keys(d['changes'] as object) : [];
  switch (action) {
    case 'product.create':
      return 'Product created';
    case 'product.update':
      return changed.length ? `Product updated (${changed.join(', ')})` : 'Product updated';
    case 'product.archive':
      return 'Product archived';
    case 'product.unarchive':
      return 'Product restored';
    case 'product.image_set':
      return 'Product image set';
    case 'product.image_remove':
      return 'Product image removed';
    case 'variant.create':
      return `Variant added: ${label}`;
    case 'variant.update':
      return `Variant updated: ${label}${changed.length ? ` (${changed.join(', ')})` : ''}`;
    case 'variant.price_change':
      return `Selling price changed for ${label}: ${fmt(Number(d['from']))} → ${fmt(Number(d['to']))}`;
    case 'variant.cost_change':
      return `Cost price changed for ${label}: ${fmt(Number(d['from']))} → ${fmt(Number(d['to']))}`;
    case 'variant.archive':
      return `Variant archived: ${label}`;
    case 'variant.unarchive':
      return `Variant restored: ${label}`;
    default:
      return action;
  }
}
