import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { localDate, nextDocumentNumber } from '../db/sequence';
import { AppError } from '../main/errors';
import type {
  CreateReturnRequest,
  Page,
  ReturnDto,
  ReturnQuery,
  ReturnableItem,
  ReturnableSale,
  SaleListItem,
} from '../shared/api';
import { recordMovement } from './inventory-core';
import { assertCan, type Actor } from './permissions';
import { dateRange, pageParams, positiveInt, text, variantLabel } from './validate';

interface ItemState {
  id: number; product_name: string; sku: string; size: string; colour: string; variant_id: number;
  quantity: number; unit_cost_minor: number; line_net_minor: number; returned_qty: number; refunded_minor: number;
}

/**
 * Customer returns.
 *
 * Refund amounts are derived from what the customer actually paid for the line
 * (after line and order discounts), never from today's price. A line is
 * refunded pro-rata per unit; the final unit takes the remainder so the sum of
 * all refunds equals the line's net exactly. Tax is not refunded automatically
 * (documented limitation). Items return to stock ONLY when the user marks them
 * resalable AND explicitly chooses to restock; damaged returns are recorded but
 * never touch stock.
 */
export class ReturnsService {
  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private itemStates(saleId: number): ItemState[] {
    return this.db
      .prepare(
        `SELECT si.id, si.product_name, si.sku, si.size, si.colour, si.variant_id, si.quantity, si.unit_cost_minor, si.line_net_minor,
                COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id = si.id), 0) AS returned_qty,
                COALESCE((SELECT SUM(refund_minor) FROM return_items WHERE sale_item_id = si.id), 0) AS refunded_minor
           FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`,
      )
      .all(saleId) as ItemState[];
  }

  getReturnable(actor: Actor, saleId: number): ReturnableSale {
    assertCan(actor, 'returns.create');
    const s = this.db
      .prepare(
        `SELECT s.id, s.receipt_no AS receiptNo, s.created_at AS createdAt, s.sale_date AS saleDate, s.status,
                s.customer_name AS customerName, COALESCE(u.display_name,'') AS cashierName, s.total_minor AS totalMinor,
                COALESCE((SELECT SUM(quantity) FROM sale_items WHERE sale_id = s.id),0) AS itemCount,
                COALESCE((SELECT SUM(refund_amount_minor) FROM returns WHERE sale_id = s.id),0) AS refundedMinor
           FROM sales s LEFT JOIN users u ON u.id = s.cashier_id WHERE s.id = ?`,
      )
      .get(saleId) as SaleListItem | undefined;
    if (!s) throw new AppError('NOT_FOUND', 'Sale not found.');
    const items: ReturnableItem[] = this.itemStates(saleId).map((i) => ({
      saleItemId: i.id,
      productName: i.product_name,
      sku: i.sku,
      size: i.size,
      colour: i.colour,
      soldQty: i.quantity,
      returnedQty: i.returned_qty,
      remainingQty: i.quantity - i.returned_qty,
      lineNetMinor: i.line_net_minor,
      refundedMinor: i.refunded_minor,
      remainingRefundMinor: i.line_net_minor - i.refunded_minor,
    }));
    return { sale: s, items };
  }

  create(actor: Actor, req: CreateReturnRequest): ReturnDto {
    assertCan(actor, 'returns.create');
    const reason = text(req.reason, 'Reason', 300, true);
    const notes = text(req.notes, 'Notes', 500);
    if (!Array.isArray(req.items) || req.items.length === 0) throw new AppError('VALIDATION', 'Select at least one item to return.', 'items');
    const seen = new Set<number>();
    for (const i of req.items) {
      if (seen.has(i.saleItemId)) throw new AppError('VALIDATION', 'Each item can appear only once per return.', 'items');
      seen.add(i.saleItemId);
    }

    const returnId = this.db
      .transaction((): number => {
        const sale = this.db.prepare('SELECT id, status, receipt_no FROM sales WHERE id = ?').get(req.saleId) as
          | { id: number; status: string; receipt_no: string }
          | undefined;
        if (!sale) throw new AppError('NOT_FOUND', 'Sale not found.');
        if (sale.status !== 'completed') throw new AppError('CONFLICT', 'A cancelled sale cannot have returns.');

        const states = new Map(this.itemStates(sale.id).map((s) => [s.id, s]));
        const lines = req.items.map((i) => {
          const st = states.get(i.saleItemId);
          if (!st) throw new AppError('VALIDATION', 'That item does not belong to the selected sale.', 'items');
          const qty = positiveInt(i.quantity, 'Quantity');
          const remaining = st.quantity - st.returned_qty;
          const label = `${st.product_name} (${variantLabel(st)})`;
          if (qty > remaining) {
            throw new AppError('RETURN_LIMIT', remaining === 0 ? `${label} has already been fully returned.` : `Only ${remaining} of ${label} can still be returned.`, 'quantity');
          }
          if (i.condition !== 'resalable' && i.condition !== 'damaged') throw new AppError('VALIDATION', 'Choose the condition of the returned item.', 'condition');
          if (i.restock && i.condition !== 'resalable') throw new AppError('VALIDATION', 'Only resalable items can be returned to stock.', 'restock');

          const remainingRefund = st.line_net_minor - st.refunded_minor;
          const refund = qty === remaining ? remainingRefund : Math.min(remainingRefund, Math.floor((st.line_net_minor * qty) / st.quantity));
          return { st, qty, refund, condition: i.condition, restock: Boolean(i.restock) };
        });

        const refundTotal = lines.reduce((a, l) => a + l.refund, 0);
        let methodCode: string | null = null;
        if (refundTotal > 0) {
          const m = this.db.prepare('SELECT code FROM payment_methods WHERE code = ? AND is_active = 1').get(req.refundMethodCode ?? '') as
            | { code: string }
            | undefined;
          if (!m) throw new AppError('VALIDATION', 'Choose how the refund is paid.', 'refundMethodCode');
          if (m.code === 'cod') throw new AppError('VALIDATION', 'Choose a direct refund method. Cash on delivery is only for customer orders.', 'refundMethodCode');
          methodCode = m.code;
        }

        const now = this.clock();
        const id = Number(
          this.db
            .prepare(
              `INSERT INTO returns (return_no, sale_id, return_date, refund_method_code, refund_amount_minor, reason, notes, user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(nextDocumentNumber(this.db, 'RET', now), sale.id, localDate(now), methodCode, refundTotal, reason, notes, actor.userId).lastInsertRowid,
        );
        for (const l of lines) {
          this.db
            .prepare('INSERT INTO return_items (return_id, sale_item_id, quantity, refund_minor, condition, restocked) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, l.st.id, l.qty, l.refund, l.condition, l.restock ? 1 : 0);
          if (l.restock) {
            recordMovement(this.db, {
              variantId: l.st.variant_id,
              type: 'customer_return',
              quantityDelta: l.qty,
              unitCostMinor: l.st.unit_cost_minor,
              reason,
              refType: 'return',
              refId: id,
              userId: actor.userId,
            });
          }
        }
        writeAudit(this.db, actor, 'return.create', 'return', id, {
          receiptNo: sale.receipt_no,
          refundTotal,
          restocked: lines.filter((l) => l.restock).length,
          damaged: lines.filter((l) => l.condition === 'damaged').length,
        });
        return id;
      })
      .immediate();
    return this.load(returnId);
  }

  private load(id: number): ReturnDto {
    const r = this.db
      .prepare(
        `SELECT r.id, r.return_no AS returnNo, r.sale_id AS saleId, s.receipt_no AS receiptNo, r.return_date AS returnDate,
                r.created_at AS createdAt, pm.name AS refundMethodName, r.refund_amount_minor AS refundAmountMinor,
                r.reason, r.notes, COALESCE(u.username, '') AS username
           FROM returns r JOIN sales s ON s.id = r.sale_id
           LEFT JOIN payment_methods pm ON pm.code = r.refund_method_code
           LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
      )
      .get(id) as Omit<ReturnDto, 'items'> | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'Return not found.');
    const items = (
      this.db
        .prepare(
          `SELECT si.product_name AS productName, si.size, si.colour, ri.quantity, ri.refund_minor AS refundMinor,
                  ri.condition, ri.restocked
             FROM return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = ? ORDER BY ri.id`,
        )
        .all(id) as Array<Omit<ReturnDto['items'][number], 'restocked'> & { restocked: number }>
    ).map((i) => ({ ...i, restocked: i.restocked === 1 }));
    return { ...r, items };
  }

  list(actor: Actor, query: ReturnQuery = {}): Page<ReturnDto> {
    assertCan(actor, 'returns.create');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.saleId) {
      where.push('r.sale_id = ?');
      params.push(query.saleId);
    }
    if (query.from && query.to) {
      const d = dateRange(query.from, query.to);
      where.push('r.return_date BETWEEN ? AND ?');
      params.push(d.from, d.to);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM returns r ${w}`).get(...params) as { n: number }).n;
    const ids = this.db.prepare(`SELECT r.id FROM returns r ${w} ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as Array<{ id: number }>;
    return { items: ids.map((x) => this.load(x.id)), total, page, pageSize };
  }
}
