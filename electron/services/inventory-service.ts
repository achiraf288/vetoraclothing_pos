import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type {
  AdjustStockRequest,
  MovementDto,
  MovementQuery,
  MovementTypeDto,
  Page,
  StockQuery,
  StockRow,
  ValuationReport,
  ValuationRow,
} from '../shared/api';
import { recordMovement, type MovementType } from './inventory-core';
import { assertCan, can, type Actor } from './permissions';
import { escapeLike, isoDate, pageParams, positiveInt, text } from './validate';

const MOVEMENT_TYPES: ReadonlySet<string> = new Set<MovementTypeDto>([
  'opening_stock', 'purchase_receipt', 'sale', 'sale_cancellation', 'customer_return',
  'supplier_return', 'adjustment_increase', 'adjustment_decrease', 'damaged', 'lost',
]);

interface StockSqlRow {
  variant_id: number;
  product_id: number;
  product_name: string;
  sku: string;
  barcode: string | null;
  size: string;
  colour: string;
  category_name: string | null;
  stock_qty: number;
  reserved_qty: number;
  reorder_threshold: number;
  cost_minor: number;
  price_minor: number;
  is_active: number;
}

const STOCK_SELECT = `
  SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name, v.sku, v.barcode, v.size, v.colour,
         c.name AS category_name, v.stock_qty,
         COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0) AS reserved_qty,
         v.reorder_threshold, v.cost_minor, v.price_minor,
         (v.is_active AND p.is_active) AS is_active
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN categories c ON c.id = p.category_id`;

export class InventoryService {
  private readonly settings: SettingsRepo;

  constructor(private readonly db: Db) {
    this.settings = new SettingsRepo(db);
  }

  private toStockRow(actor: Actor, r: StockSqlRow): StockRow {
    const canSeeCost = can(actor, 'reports.read');
    return {
      variantId: r.variant_id,
      productId: r.product_id,
      productName: r.product_name,
      sku: r.sku,
      barcode: r.barcode,
      size: r.size,
      colour: r.colour,
      categoryName: r.category_name,
      stockQty: r.stock_qty,
      reservedQty: r.reserved_qty,
      reorderThreshold: r.reorder_threshold,
      costMinor: canSeeCost ? r.cost_minor : 0,
      priceMinor: r.price_minor,
      isActive: r.is_active === 1,
    };
  }

  // ───────────── stock levels ─────────────
  listStock(actor: Actor, query: StockQuery = {}): Page<StockRow> {
    assertCan(actor, 'inventory.read');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const where: string[] = ['v.is_active = 1', 'p.is_active = 1'];
    const params: unknown[] = [];
    const search = query.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push(
        `(p.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\' OR v.size LIKE ? ESCAPE '\\' OR v.colour LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like, like);
    }
    if (query.lowOnly) where.push("(v.stock_qty - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0)) <= v.reorder_threshold");
    if (query.categoryId) {
      where.push('p.category_id = ?');
      params.push(query.categoryId);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM product_variants v JOIN products p ON p.id = v.product_id ${whereSql}`)
        .get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`${STOCK_SELECT} ${whereSql} ORDER BY p.name COLLATE NOCASE, v.size, v.colour LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as StockSqlRow[];
    return { items: rows.map((r) => this.toStockRow(actor, r)), total, page, pageSize };
  }

  /** All low-stock variants (no paging) — used by reports. */
  listLowStock(actor: Actor): StockRow[] {
    assertCan(actor, 'reports.read');
    const rows = this.db
      .prepare(
        `${STOCK_SELECT} WHERE v.is_active = 1 AND p.is_active = 1 AND (v.stock_qty - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0)) <= v.reorder_threshold
          ORDER BY (v.stock_qty - v.reorder_threshold), p.name COLLATE NOCASE`,
      )
      .all() as StockSqlRow[];
    return rows.map((r) => this.toStockRow(actor, r));
  }

  private getStockRow(actor: Actor, variantId: number): StockRow {
    const r = this.db.prepare(`${STOCK_SELECT} WHERE v.id = ?`).get(variantId) as StockSqlRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'Variant not found.');
    return this.toStockRow(actor, r);
  }

  // ───────────── ledger ─────────────
  private movementQuery(query: MovementQuery): { where: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.variantId) {
      where.push('m.variant_id = ?');
      params.push(query.variantId);
    }
    if (query.type) {
      if (!MOVEMENT_TYPES.has(query.type)) throw new AppError('VALIDATION', 'Unknown movement type.', 'type');
      where.push('m.movement_type = ?');
      params.push(query.type);
    }
    if (query.from) {
      // Stored in UTC; the filter uses the local business day boundaries.
      const [y, mo, d] = isoDate(query.from, 'From').split('-').map(Number);
      where.push('m.created_at >= ?');
      params.push(new Date(y, mo - 1, d).toISOString());
    }
    if (query.to) {
      const [y, mo, d] = isoDate(query.to, 'To').split('-').map(Number);
      where.push('m.created_at < ?');
      params.push(new Date(y, mo - 1, d + 1).toISOString());
    }
    const search = query.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push(`(p.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR COALESCE(m.reason,'') LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  private static readonly MOVEMENT_FROM = `
    FROM stock_movements m
    JOIN product_variants v ON v.id = m.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN sales s ON m.ref_type = 'sale' AND s.id = m.ref_id
    LEFT JOIN purchases pu ON m.ref_type = 'purchase' AND pu.id = m.ref_id
    LEFT JOIN returns r ON m.ref_type = 'return' AND r.id = m.ref_id
    LEFT JOIN supplier_returns sr ON m.ref_type = 'supplier_return' AND sr.id = m.ref_id
    LEFT JOIN orders o ON m.ref_type = 'manual' AND m.ref_id = o.id AND m.reason IN ('Online order fulfilled','Courier parcel returned')`;

  listMovements(actor: Actor, query: MovementQuery = {}, unpaged = false): Page<MovementDto> {
    assertCan(actor, 'inventory.read');
    const { where, params } = this.movementQuery(query);
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n ${InventoryService.MOVEMENT_FROM} ${where}`).get(...params) as { n: number }
    ).n;
    const sql = `
      SELECT m.id, m.created_at, m.variant_id, p.name AS product_name, v.sku, v.size, v.colour,
             m.movement_type, m.quantity_delta, m.balance_after, m.unit_cost_minor, m.reason,
             m.ref_type, m.ref_id, u.username,
             COALESCE(s.receipt_no, pu.purchase_no, r.return_no, sr.return_no, o.order_no) AS ref_label
      ${InventoryService.MOVEMENT_FROM} ${where}
      ORDER BY m.id DESC ${unpaged ? '' : 'LIMIT ? OFFSET ?'}`;
    const rows = (unpaged
      ? this.db.prepare(sql).all(...params)
      : this.db.prepare(sql).all(...params, pageSize, offset)) as Array<{
      id: number; created_at: string; variant_id: number; product_name: string; sku: string; size: string; colour: string;
      movement_type: MovementTypeDto; quantity_delta: number; balance_after: number; unit_cost_minor: number | null;
      reason: string | null; ref_type: string | null; ref_id: number | null; username: string | null; ref_label: string | null;
    }>;
    const canSeeCost = can(actor, 'reports.read');
    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        variantId: r.variant_id,
        productName: r.product_name,
        sku: r.sku,
        size: r.size,
        colour: r.colour,
        type: r.movement_type,
        quantityDelta: r.quantity_delta,
        balanceAfter: r.balance_after,
        unitCostMinor: canSeeCost ? r.unit_cost_minor : null,
        reason: r.reason,
        refType: r.ref_type,
        refId: r.ref_id,
        refLabel: r.ref_label,
        username: r.username,
      })),
      total,
      page,
      pageSize: unpaged ? total : pageSize,
    };
  }

  // ───────────── manual adjustments ─────────────
  adjust(actor: Actor, req: AdjustStockRequest): StockRow {
    assertCan(actor, 'inventory.adjust');
    const quantity = positiveInt(req.quantity, 'Quantity', 1_000_000);
    const reason = text(req.reason, 'Reason', 300, true);
    const variant = this.db
      .prepare(
        `SELECT v.id, v.stock_qty, v.cost_minor, v.is_active, p.name FROM product_variants v
           JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
      )
      .get(req.variantId) as { id: number; stock_qty: number; cost_minor: number; is_active: number; name: string } | undefined;
    if (!variant) throw new AppError('NOT_FOUND', 'Variant not found.');

    const kinds: Record<AdjustStockRequest['kind'], { type: MovementType; sign: 1 | -1 }> = {
      opening: { type: 'opening_stock', sign: 1 },
      increase: { type: 'adjustment_increase', sign: 1 },
      decrease: { type: 'adjustment_decrease', sign: -1 },
      damaged: { type: 'damaged', sign: -1 },
      lost: { type: 'lost', sign: -1 },
    };
    const kind = kinds[req.kind];
    if (!kind) throw new AppError('VALIDATION', 'Choose a valid adjustment type.', 'kind');

    this.db.transaction(() => {
      if (req.kind === 'opening') {
        const any = this.db.prepare('SELECT 1 FROM stock_movements WHERE variant_id = ? LIMIT 1').get(req.variantId);
        if (any) throw new AppError('CONFLICT', 'Opening stock can only be set before any other stock movement exists. Use an adjustment instead.', 'kind');
      }
      const reserved=(this.db.prepare(`SELECT COALESCE(SUM(oi.quantity),0) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id
        WHERE oi.variant_id=? AND o.status IN ('confirmed','dispatched','in_transit','failed')`).get(req.variantId) as {n:number}).n;
      const available=Math.max(0,variant.stock_qty-reserved);
      if (kind.sign < 0 && !this.settings.getBool('inventory.allow_negative_stock') && available < quantity) {
        throw new AppError('INSUFFICIENT_STOCK', `Only ${available} unreserved units in stock for ${variant.name}; cannot remove ${quantity}.`, 'quantity');
      }
      const result = recordMovement(this.db, {
        variantId: req.variantId,
        type: kind.type,
        quantityDelta: kind.sign * quantity,
        unitCostMinor: variant.cost_minor,
        reason,
        refType: 'manual',
        userId: actor.userId,
      });
      writeAudit(this.db, actor, `stock.${req.kind}`, 'variant', req.variantId, {
        quantity: kind.sign * quantity,
        reason,
        balanceAfter: result.balanceAfter,
      });
    })();
    return this.getStockRow(actor, req.variantId);
  }

  // ───────────── valuation ─────────────
  /** Stock on hand × current cost (and retail) price. Cost basis is the variant's current cost. */
  valuation(actor: Actor): ValuationReport {
    assertCan(actor, 'reports.read');
    const rows = (
      this.db
        .prepare(
          `SELECT v.id AS variantId, p.name AS productName, v.sku, v.size, v.colour, v.stock_qty AS stockQty,
                  v.cost_minor AS costMinor, v.price_minor AS priceMinor,
                  v.stock_qty * v.cost_minor AS costValueMinor, v.stock_qty * v.price_minor AS retailValueMinor
             FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE v.stock_qty > 0
            ORDER BY p.name COLLATE NOCASE, v.size, v.colour`,
        )
        .all() as ValuationRow[]
    );
    return {
      rows,
      totalUnits: rows.reduce((a, r) => a + r.stockQty, 0),
      totalCostValueMinor: rows.reduce((a, r) => a + r.costValueMinor, 0),
      totalRetailValueMinor: rows.reduce((a, r) => a + r.retailValueMinor, 0),
    };
  }
}
