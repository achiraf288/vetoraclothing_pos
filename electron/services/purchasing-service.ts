import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { localDate, nextDocumentNumber } from '../db/sequence';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type {
  Page,
  PurchaseDetail,
  PurchaseDraftInput,
  PurchaseItemDto,
  PurchaseListItem,
  PurchaseQuery,
  SupplierDto,
  SupplierInput,
  SupplierReturnDto,
  SupplierReturnInput,
} from '../shared/api';
import { recordMovement } from './inventory-core';
import { assertCan, type Actor } from './permissions';
import { dateRange, isoDate, nonNegativeMinor, pageParams, positiveInt, text } from './validate';

interface SupplierRow {
  id: number; name: string; contact_name: string; phone: string; email: string; address: string; notes: string; is_active: number;
}

const toSupplier = (r: SupplierRow): SupplierDto => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  phone: r.phone,
  email: r.email,
  address: r.address,
  notes: r.notes,
  isActive: r.is_active === 1,
});

interface PurchaseRow {
  id: number; purchase_no: string; supplier_id: number; supplier_name: string; status: PurchaseListItem['status'];
  purchase_date: string; total_cost_minor: number; item_count: number; received_at: string | null;
  supplier_ref: string; notes: string;
}

const PURCHASE_SELECT = `
  SELECT pu.id, pu.purchase_no, pu.supplier_id, s.name AS supplier_name, pu.status, pu.purchase_date,
         pu.total_cost_minor, pu.received_at, pu.supplier_ref, pu.notes,
         (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id) AS item_count
    FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id`;

const toListItem = (r: PurchaseRow): PurchaseListItem => ({
  id: r.id,
  purchaseNo: r.purchase_no,
  supplierId: r.supplier_id,
  supplierName: r.supplier_name,
  status: r.status,
  purchaseDate: r.purchase_date,
  totalCostMinor: r.total_cost_minor,
  itemCount: r.item_count,
  receivedAt: r.received_at,
});

export class PurchasingService {
  private readonly settings: SettingsRepo;

  constructor(private readonly db: Db) {
    this.settings = new SettingsRepo(db);
  }

  // ───────────── suppliers ─────────────
  listSuppliers(actor: Actor, includeInactive = false): SupplierDto[] {
    assertCan(actor, 'purchases.manage');
    const rows = this.db
      .prepare(`SELECT * FROM suppliers ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY name COLLATE NOCASE`)
      .all() as SupplierRow[];
    return rows.map(toSupplier);
  }

  saveSupplier(actor: Actor, req: SupplierInput): SupplierDto {
    assertCan(actor, 'purchases.manage');
    const name = text(req.name, 'Name', 100, true);
    const data = {
      contact: text(req.contactName, 'Contact name', 100),
      phone: text(req.phone, 'Phone', 40),
      email: text(req.email, 'Email', 120),
      address: text(req.address, 'Address', 200),
      notes: text(req.notes, 'Notes', 500),
    };
    const clash = this.db.prepare('SELECT id FROM suppliers WHERE name = ? AND id IS NOT ?').get(name, req.id ?? null);
    if (clash) throw new AppError('DUPLICATE', 'A supplier with that name already exists.', 'name');

    const id = this.db.transaction((): number => {
      if (req.id === undefined) {
        const newId = Number(
          this.db
            .prepare('INSERT INTO suppliers (name, contact_name, phone, email, address, notes) VALUES (?, ?, ?, ?, ?, ?)')
            .run(name, data.contact, data.phone, data.email, data.address, data.notes).lastInsertRowid,
        );
        writeAudit(this.db, actor, 'supplier.create', 'supplier', newId, { name });
        return newId;
      }
      if (!this.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(req.id)) throw new AppError('NOT_FOUND', 'Supplier not found.');
      this.db
        .prepare(
          `UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, address = ?, notes = ?,
                  is_active = COALESCE(?, is_active), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(name, data.contact, data.phone, data.email, data.address, data.notes, req.isActive === undefined ? null : req.isActive ? 1 : 0, req.id);
      writeAudit(this.db, actor, 'supplier.update', 'supplier', req.id, { name, isActive: req.isActive });
      return req.id;
    })();
    return toSupplier(this.db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as SupplierRow);
  }

  // ───────────── purchases ─────────────
  listPurchases(actor: Actor, query: PurchaseQuery = {}): Page<PurchaseListItem> {
    assertCan(actor, 'purchases.manage');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      where.push('pu.status = ?');
      params.push(query.status);
    }
    if (query.supplierId) {
      where.push('pu.supplier_id = ?');
      params.push(query.supplierId);
    }
    if (query.from && query.to) {
      const r = dateRange(query.from, query.to);
      where.push('pu.purchase_date BETWEEN ? AND ?');
      params.push(r.from, r.to);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM purchases pu ${w}`).get(...params) as { n: number }).n;
    const rows = this.db
      .prepare(`${PURCHASE_SELECT} ${w} ORDER BY pu.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as PurchaseRow[];
    return { items: rows.map(toListItem), total, page, pageSize };
  }

  getPurchase(actor: Actor, id: number): PurchaseDetail {
    assertCan(actor, 'purchases.manage');
    return this.loadPurchase(id);
  }

  private loadPurchase(id: number): PurchaseDetail {
    const r = this.db.prepare(`${PURCHASE_SELECT} WHERE pu.id = ?`).get(id) as PurchaseRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'Purchase not found.');
    const items = this.db
      .prepare(
        `SELECT i.id, i.variant_id AS variantId, p.name AS productName, v.sku, v.size, v.colour,
                i.quantity, i.unit_cost_minor AS unitCostMinor, i.line_total_minor AS lineTotalMinor
           FROM purchase_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
          WHERE i.purchase_id = ? ORDER BY i.id`,
      )
      .all(id) as PurchaseItemDto[];
    return { ...toListItem(r), supplierRef: r.supplier_ref, notes: r.notes, items };
  }

  saveDraft(actor: Actor, req: PurchaseDraftInput): PurchaseDetail {
    assertCan(actor, 'purchases.manage');
    const purchaseDate = isoDate(req.purchaseDate, 'Purchase date');
    const supplierRef = text(req.supplierRef, 'Supplier reference', 80);
    const notes = text(req.notes, 'Notes', 500);
    if (!Array.isArray(req.items) || req.items.length === 0) throw new AppError('VALIDATION', 'Add at least one item.', 'items');
    if (req.items.length > 500) throw new AppError('VALIDATION', 'Too many lines in one purchase.', 'items');

    const seen = new Set<number>();
    const items = req.items.map((i) => {
      if (seen.has(i.variantId)) throw new AppError('VALIDATION', 'Each variant can appear only once per purchase; combine the quantities.', 'items');
      seen.add(i.variantId);
      return {
        variantId: i.variantId,
        quantity: positiveInt(i.quantity, 'Quantity'),
        unitCostMinor: nonNegativeMinor(i.unitCostMinor, 'Unit cost'),
      };
    });
    const supplier = this.db.prepare('SELECT id, is_active FROM suppliers WHERE id = ?').get(req.supplierId) as
      | { id: number; is_active: number }
      | undefined;
    if (!supplier) throw new AppError('NOT_FOUND', 'Supplier not found.', 'supplierId');
    if (supplier.is_active !== 1) throw new AppError('VALIDATION', 'That supplier is inactive.', 'supplierId');
    for (const i of items) {
      if (!this.db.prepare('SELECT 1 FROM product_variants WHERE id = ?').get(i.variantId)) {
        throw new AppError('NOT_FOUND', 'One of the selected variants no longer exists.', 'items');
      }
    }
    const total = items.reduce((a, i) => a + i.quantity * i.unitCostMinor, 0);

    const id = this.db.transaction((): number => {
      let purchaseId = req.id;
      if (purchaseId === undefined) {
        purchaseId = Number(
          this.db
            .prepare(
              `INSERT INTO purchases (purchase_no, supplier_id, supplier_ref, notes, total_cost_minor, purchase_date, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(nextDocumentNumber(this.db, 'PO'), req.supplierId, supplierRef, notes, total, purchaseDate, actor.userId).lastInsertRowid,
        );
        writeAudit(this.db, actor, 'purchase.create', 'purchase', purchaseId, { total, lines: items.length });
      } else {
        const existing = this.db.prepare('SELECT status FROM purchases WHERE id = ?').get(purchaseId) as { status: string } | undefined;
        if (!existing) throw new AppError('NOT_FOUND', 'Purchase not found.');
        if (existing.status !== 'draft') throw new AppError('IMMUTABLE', 'Only draft purchases can be edited.');
        this.db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(purchaseId);
        this.db
          .prepare(
            `UPDATE purchases SET supplier_id = ?, supplier_ref = ?, notes = ?, total_cost_minor = ?, purchase_date = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          )
          .run(req.supplierId, supplierRef, notes, total, purchaseDate, purchaseId);
        writeAudit(this.db, actor, 'purchase.update', 'purchase', purchaseId, { total, lines: items.length });
      }
      const insert = this.db.prepare(
        'INSERT INTO purchase_items (purchase_id, variant_id, quantity, unit_cost_minor, line_total_minor) VALUES (?, ?, ?, ?, ?)',
      );
      for (const i of items) insert.run(purchaseId, i.variantId, i.quantity, i.unitCostMinor, i.quantity * i.unitCostMinor);
      return purchaseId;
    })();
    return this.loadPurchase(id);
  }

  /** Stock increases only here, inside one transaction with the status change. */
  receive(actor: Actor, req: { id: number; updateCosts: boolean }): PurchaseDetail {
    assertCan(actor, 'purchases.manage');
    this.db.transaction(() => {
      const purchase = this.db.prepare('SELECT id, status FROM purchases WHERE id = ?').get(req.id) as
        | { id: number; status: string }
        | undefined;
      if (!purchase) throw new AppError('NOT_FOUND', 'Purchase not found.');
      if (purchase.status !== 'draft') throw new AppError('CONFLICT', 'This purchase has already been received or cancelled.');

      const items = this.db
        .prepare('SELECT variant_id, quantity, unit_cost_minor FROM purchase_items WHERE purchase_id = ?')
        .all(req.id) as Array<{ variant_id: number; quantity: number; unit_cost_minor: number }>;
      if (items.length === 0) throw new AppError('VALIDATION', 'A purchase with no items cannot be received.');

      for (const i of items) {
        recordMovement(this.db, {
          variantId: i.variant_id,
          type: 'purchase_receipt',
          quantityDelta: i.quantity,
          unitCostMinor: i.unit_cost_minor,
          refType: 'purchase',
          refId: req.id,
          userId: actor.userId,
        });
        if (req.updateCosts) {
          const old = this.db.prepare('SELECT cost_minor FROM product_variants WHERE id = ?').get(i.variant_id) as { cost_minor: number };
          if (old.cost_minor !== i.unit_cost_minor) {
            this.db
              .prepare(`UPDATE product_variants SET cost_minor = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
              .run(i.unit_cost_minor, i.variant_id);
            writeAudit(this.db, actor, 'variant.cost_change', 'variant', i.variant_id, {
              from: old.cost_minor,
              to: i.unit_cost_minor,
              source: `purchase ${req.id}`,
            });
          }
        }
      }
      this.db
        .prepare(
          `UPDATE purchases SET status = 'received', received_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), received_by = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(actor.userId, req.id);
      writeAudit(this.db, actor, 'purchase.receive', 'purchase', req.id, { lines: items.length, updateCosts: req.updateCosts });
    })();
    return this.loadPurchase(req.id);
  }

  cancel(actor: Actor, id: number): PurchaseDetail {
    assertCan(actor, 'purchases.manage');
    this.db.transaction(() => {
      const p = this.db.prepare('SELECT status FROM purchases WHERE id = ?').get(id) as { status: string } | undefined;
      if (!p) throw new AppError('NOT_FOUND', 'Purchase not found.');
      if (p.status !== 'draft') throw new AppError('CONFLICT', 'Only draft purchases can be cancelled. For received stock, record a supplier return.');
      this.db.prepare(`UPDATE purchases SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
      writeAudit(this.db, actor, 'purchase.cancel', 'purchase', id);
    })();
    return this.loadPurchase(id);
  }

  // ───────────── supplier returns ─────────────
  createSupplierReturn(actor: Actor, req: SupplierReturnInput): SupplierReturnDto {
    assertCan(actor, 'purchases.manage');
    const reason = text(req.reason, 'Reason', 300, true);
    const returnDate = isoDate(req.returnDate ?? localDate(), 'Return date');
    if (!Array.isArray(req.items) || req.items.length === 0) throw new AppError('VALIDATION', 'Add at least one item.', 'items');
    const seen = new Set<number>();
    const items = req.items.map((i) => {
      if (seen.has(i.variantId)) throw new AppError('VALIDATION', 'Each variant can appear only once; combine the quantities.', 'items');
      seen.add(i.variantId);
      return { variantId: i.variantId, quantity: positiveInt(i.quantity, 'Quantity') };
    });
    if (!this.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(req.supplierId)) throw new AppError('NOT_FOUND', 'Supplier not found.', 'supplierId');
    const allowNegative = this.settings.getBool('inventory.allow_negative_stock');

    const id = this.db.transaction((): number => {
      if (req.purchaseId) {
        const p = this.db.prepare('SELECT supplier_id, status FROM purchases WHERE id = ?').get(req.purchaseId) as
          | { supplier_id: number; status: string }
          | undefined;
        if (!p || p.supplier_id !== req.supplierId) throw new AppError('VALIDATION', 'That purchase does not belong to this supplier.', 'purchaseId');
        if (p.status !== 'received') throw new AppError('VALIDATION', 'Only received purchases can have returns.', 'purchaseId');
      }
      const lines = items.map((i) => {
        const v = this.db
          .prepare(`SELECT v.stock_qty, v.cost_minor, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`)
          .get(i.variantId) as { stock_qty: number; cost_minor: number; name: string } | undefined;
        if (!v) throw new AppError('NOT_FOUND', 'One of the selected variants no longer exists.', 'items');
        let unitCost = v.cost_minor;
        if (req.purchaseId) {
          const bought = this.db
            .prepare('SELECT quantity, unit_cost_minor FROM purchase_items WHERE purchase_id = ? AND variant_id = ?')
            .get(req.purchaseId, i.variantId) as { quantity: number; unit_cost_minor: number } | undefined;
          if (!bought) throw new AppError('VALIDATION', `${v.name} was not on that purchase.`, 'items');
          const alreadyReturned = (
            this.db
              .prepare(
                `SELECT COALESCE(SUM(sri.quantity), 0) AS n FROM supplier_return_items sri
                   JOIN supplier_returns sr ON sr.id = sri.supplier_return_id
                  WHERE sr.purchase_id = ? AND sri.variant_id = ?`,
              )
              .get(req.purchaseId, i.variantId) as { n: number }
          ).n;
          if (i.quantity > bought.quantity - alreadyReturned) {
            throw new AppError('RETURN_LIMIT', `Only ${bought.quantity - alreadyReturned} of ${v.name} can still be returned for that purchase.`, 'items');
          }
          unitCost = bought.unit_cost_minor;
        }
        if (!allowNegative && v.stock_qty < i.quantity) {
          throw new AppError('INSUFFICIENT_STOCK', `Only ${v.stock_qty} of ${v.name} in stock.`, 'items');
        }
        return { ...i, unitCost };
      });
      const total = lines.reduce((a, l) => a + l.quantity * l.unitCost, 0);
      const returnId = Number(
        this.db
          .prepare(
            `INSERT INTO supplier_returns (return_no, supplier_id, purchase_id, reason, total_cost_minor, return_date, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(nextDocumentNumber(this.db, 'SR'), req.supplierId, req.purchaseId ?? null, reason, total, returnDate, actor.userId).lastInsertRowid,
      );
      for (const l of lines) {
        this.db
          .prepare('INSERT INTO supplier_return_items (supplier_return_id, variant_id, quantity, unit_cost_minor) VALUES (?, ?, ?, ?)')
          .run(returnId, l.variantId, l.quantity, l.unitCost);
        recordMovement(this.db, {
          variantId: l.variantId,
          type: 'supplier_return',
          quantityDelta: -l.quantity,
          unitCostMinor: l.unitCost,
          reason,
          refType: 'supplier_return',
          refId: returnId,
          userId: actor.userId,
        });
      }
      writeAudit(this.db, actor, 'supplier_return.create', 'supplier_return', returnId, { total, lines: lines.length });
      return returnId;
    })();
    return this.loadSupplierReturn(id);
  }

  private loadSupplierReturn(id: number): SupplierReturnDto {
    return this.db
      .prepare(
        `SELECT sr.id, sr.return_no AS returnNo, s.name AS supplierName, sr.reason, sr.return_date AS returnDate,
                sr.total_cost_minor AS totalCostMinor,
                (SELECT COUNT(*) FROM supplier_return_items i WHERE i.supplier_return_id = sr.id) AS itemCount
           FROM supplier_returns sr JOIN suppliers s ON s.id = sr.supplier_id WHERE sr.id = ?`,
      )
      .get(id) as SupplierReturnDto;
  }

  listSupplierReturns(actor: Actor, query: { page?: number; pageSize?: number } = {}): Page<SupplierReturnDto> {
    assertCan(actor, 'purchases.manage');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM supplier_returns').get() as { n: number }).n;
    const items = this.db
      .prepare(
        `SELECT sr.id, sr.return_no AS returnNo, s.name AS supplierName, sr.reason, sr.return_date AS returnDate,
                sr.total_cost_minor AS totalCostMinor,
                (SELECT COUNT(*) FROM supplier_return_items i WHERE i.supplier_return_id = sr.id) AS itemCount
           FROM supplier_returns sr JOIN suppliers s ON s.id = sr.supplier_id ORDER BY sr.id DESC LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset) as SupplierReturnDto[];
    return { items, total, page, pageSize };
  }
}
