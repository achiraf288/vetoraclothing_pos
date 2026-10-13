import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { allocateProportionally, percentOfMinor } from '../db/money';
import { localDate, nextDocumentNumber } from '../db/sequence';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type {
  CancelSaleRequest,
  CheckoutRequest,
  Page,
  PaymentDto,
  PosVariant,
  ReceiptDto,
  SaleDetail,
  SaleItemDto,
  SaleListItem,
  SaleQuery,
} from '../shared/api';
import { IMAGE_URL_PREFIX } from './catalog-service';
import { recordMovement } from './inventory-core';
import { assertCan, can, type Actor } from './permissions';
import { dateRange, escapeLike, nonNegativeMinor, pageParams, positiveInt, text, variantLabel } from './validate';

export interface AdminOverrideVerifier {
  verifyAdminOverride(username: string, password: string): { id: number; username: string };
}

interface SaleRow {
  id: number; receipt_no: string; created_at: string; sale_date: string; status: 'completed' | 'cancelled';
  customer_name: string; customer_phone: string; notes: string; cashier_name: string | null; total_minor: number;
  subtotal_minor: number; line_discount_total_minor: number; order_discount_minor: number; tax_minor: number;
  cancelled_at: string | null; cancel_reason: string | null; item_count: number; refunded_minor: number;
}

const SALE_SELECT = `
  SELECT s.id, s.receipt_no, s.created_at, s.sale_date, s.status, s.customer_name, s.customer_phone, s.notes,
         COALESCE(u.display_name, '') AS cashier_name, s.total_minor, s.subtotal_minor,
         s.line_discount_total_minor, s.order_discount_minor, s.tax_minor, s.cancelled_at, s.cancel_reason,
         COALESCE((SELECT SUM(quantity) FROM sale_items WHERE sale_id = s.id), 0) AS item_count,
         COALESCE((SELECT SUM(refund_amount_minor) FROM returns WHERE sale_id = s.id), 0) AS refunded_minor
    FROM sales s LEFT JOIN users u ON u.id = s.cashier_id`;

const toListItem = (r: SaleRow): SaleListItem => ({
  id: r.id,
  receiptNo: r.receipt_no,
  createdAt: r.created_at,
  saleDate: r.sale_date,
  status: r.status,
  customerName: r.customer_name,
  cashierName: r.cashier_name ?? '',
  totalMinor: r.total_minor,
  itemCount: r.item_count,
  refundedMinor: r.refunded_minor,
});

export class SalesService {
  private readonly settings: SettingsRepo;

  constructor(
    private readonly db: Db,
    private readonly auth: AdminOverrideVerifier,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.settings = new SettingsRepo(db);
  }

  // ───────────── POS lookup ─────────────
  previewDiscount(actor: Actor, req: { code: string; subtotalMinor: number }): { discountMinor: number } {
    assertCan(actor, 'sales.create');
    const code=text(req.code,'Discount code',32,true).toUpperCase();
    const subtotal=nonNegativeMinor(req.subtotalMinor,'Subtotal');
    const row=this.db.prepare('SELECT kind,amount,minimum_minor,usage_limit,usage_count,is_active FROM discount_codes WHERE code=?').get(code) as
      {kind:'fixed'|'percent';amount:number;minimum_minor:number;usage_limit:number|null;usage_count:number;is_active:number}|undefined;
    if(!row||!row.is_active) throw new AppError('VALIDATION','That discount code is invalid or inactive.','discountCode');
    if(subtotal<row.minimum_minor) throw new AppError('VALIDATION','The order does not meet this code’s minimum spend.','discountCode');
    if(row.usage_limit!==null&&row.usage_count>=row.usage_limit) throw new AppError('VALIDATION','That discount code has reached its usage limit.','discountCode');
    return {discountMinor:Math.min(subtotal,row.kind==='fixed'?row.amount:Math.floor(subtotal*row.amount/10_000))};
  }

  private posSelect = `
    SELECT v.id AS variantId, p.id AS productId, p.name AS productName, v.sku, v.barcode, v.size, v.colour,
           v.price_minor AS priceMinor, MAX(0,v.stock_qty-COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0)) AS stockQty, p.image_path AS imagePath
      FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.is_active = 1 AND p.is_active = 1`;

  private toPos(r: PosVariant & { imagePath?: string | null }): PosVariant {
    const { imagePath, ...rest } = r;
    return { ...rest, imageUrl: imagePath ? IMAGE_URL_PREFIX + imagePath : null };
  }

  lookup(actor: Actor, req: { query: string }): PosVariant[] {
    assertCan(actor, 'sales.create');
    const tokens = (req.query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    if (tokens.length === 0) return [];
    const where: string[] = [];
    const params: string[] = [];
    for (const t of tokens) {
      const like = `%${escapeLike(t)}%`;
      where.push(
        `(p.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\' OR v.size LIKE ? ESCAPE '\\' OR v.colour LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like, like, like);
    }
    const rows = this.db
      .prepare(`${this.posSelect} AND ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE, v.size, v.colour LIMIT 40`)
      .all(...params) as Array<PosVariant & { imagePath: string | null }>;
    return rows.map((r) => this.toPos(r));
  }

  /** Exact barcode / SKU match, as produced by a scanner. */
  scan(actor: Actor, req: { code: string }): PosVariant | null {
    assertCan(actor, 'sales.create');
    const code = (req.code ?? '').trim();
    if (!code) return null;
    const r = this.db.prepare(`${this.posSelect} AND (v.barcode = ? OR v.sku = ?) LIMIT 1`).get(code, code) as
      | (PosVariant & { imagePath: string | null })
      | undefined;
    return r ? this.toPos(r) : null;
  }

  // ───────────── checkout ─────────────
  /**
   * Completes a sale atomically: the sale, its lines (with price and cost
   * snapshots), its payments and the stock deductions are written in ONE
   * transaction. Any failure rolls the whole thing back — no partial sale.
   * The client-generated idempotency key makes a repeated submission return
   * the original sale instead of charging twice.
   */
  checkout(actor: Actor, req: CheckoutRequest): SaleDetail {
    assertCan(actor, 'sales.create');

    const key = typeof req.idempotencyKey === 'string' ? req.idempotencyKey : '';
    if (key.length < 8 || key.length > 100) throw new AppError('VALIDATION', 'Invalid checkout request.', 'idempotencyKey');
    const existing = this.db.prepare('SELECT id FROM sales WHERE idempotency_key = ?').get(key) as { id: number } | undefined;
    if (existing) return this.loadSale(existing.id);

    if (!Array.isArray(req.items) || req.items.length === 0) throw new AppError('VALIDATION', 'The cart is empty.', 'items');
    if (req.items.length > 200) throw new AppError('VALIDATION', 'Too many lines in one sale.', 'items');

    // Merge repeated variants so stock is checked against the combined quantity.
    const merged = new Map<number, { variantId: number; quantity: number; discountMinor: number }>();
    for (const i of req.items) {
      const quantity = positiveInt(i.quantity, 'Quantity', 100_000);
      const discount = nonNegativeMinor(i.discountMinor ?? 0, 'Discount');
      const prev = merged.get(i.variantId);
      if (prev) {
        prev.quantity += quantity;
        prev.discountMinor += discount;
      } else {
        merged.set(i.variantId, { variantId: i.variantId, quantity, discountMinor: discount });
      }
    }
    const lines = [...merged.values()];
    const orderDiscount = nonNegativeMinor(req.orderDiscountMinor ?? 0, 'Order discount');
    const discountCode = text(req.discountCode ?? '', 'Discount code', 32).toUpperCase();
    const customerName = text(req.customerName, 'Customer name', 100);
    const customerPhone = text(req.customerPhone, 'Customer phone', 40);
    const notes = text(req.notes, 'Notes', 300);
    const allowNegative = this.settings.getBool('inventory.allow_negative_stock');
    const taxEnabled = this.settings.getBool('tax.enabled');
    const taxBps = this.settings.getInt('tax.rate_bps', 0);
    const now = this.clock();

    const saleId = this.db
      .transaction((): number => {
        // Re-check inside the write transaction.
        const dup = this.db.prepare('SELECT id FROM sales WHERE idempotency_key = ?').get(key) as { id: number } | undefined;
        if (dup) return dup.id;

        const priced = lines.map((l) => {
          const v = this.db
            .prepare(
              `SELECT v.id, v.sku, v.size, v.colour, v.price_minor, v.cost_minor, v.stock_qty,
                      MAX(0,v.stock_qty-COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0)) AS available_qty,
                      v.is_active AS v_active,
                      p.is_active AS p_active, p.name
                 FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
            )
            .get(l.variantId) as
            | { id: number; sku: string; size: string; colour: string; price_minor: number; cost_minor: number; stock_qty: number; available_qty:number; v_active: number; p_active: number; name: string }
            | undefined;
          if (!v) throw new AppError('NOT_FOUND', 'An item in the cart no longer exists.', 'items');
          const label = `${v.name} (${variantLabel(v)})`;
          if (!v.v_active || !v.p_active) throw new AppError('VALIDATION', `${label} is archived and cannot be sold.`, 'items');
          if (!allowNegative && v.available_qty < l.quantity) {
            throw new AppError('INSUFFICIENT_STOCK', `Only ${v.available_qty} unreserved ${label} in stock.`, 'items');
          }
          const gross = l.quantity * v.price_minor;
          if (l.discountMinor > gross) throw new AppError('VALIDATION', `Discount on ${label} exceeds the line total.`, 'discount');
          return { ...l, v, label, gross, afterLine: gross - l.discountMinor };
        });

        const subtotal = priced.reduce((a, l) => a + l.gross, 0);
        const lineDiscountTotal = priced.reduce((a, l) => a + l.discountMinor, 0);
        const base = subtotal - lineDiscountTotal;
        let codeDiscount = 0;
        if (discountCode) {
          const code = this.db.prepare('SELECT kind,amount,minimum_minor,usage_limit,usage_count,is_active FROM discount_codes WHERE code=?').get(discountCode) as
            {kind:'fixed'|'percent';amount:number;minimum_minor:number;usage_limit:number|null;usage_count:number;is_active:number}|undefined;
          if (!code || !code.is_active) throw new AppError('VALIDATION','That discount code is invalid or inactive.','discountCode');
          if (base < code.minimum_minor) throw new AppError('VALIDATION','The order does not meet this code’s minimum spend.','discountCode');
          if (code.usage_limit !== null && code.usage_count >= code.usage_limit) throw new AppError('VALIDATION','That discount code has reached its usage limit.','discountCode');
          codeDiscount = Math.min(base, code.kind === 'fixed' ? code.amount : Math.floor(base * code.amount / 10_000));
        }
        const totalDiscount = orderDiscount + codeDiscount;
        if (totalDiscount > base) throw new AppError('VALIDATION', 'The discounts exceed the amount due.', 'orderDiscount');
        const shares = allocateProportionally(totalDiscount, priced.map((l) => l.afterLine));
        const taxable = base - totalDiscount;
        const tax = taxEnabled && taxBps > 0 ? percentOfMinor(taxable, taxBps) : 0;
        const total = taxable + tax;

        const payments = this.validatePayments(req, total);

        const receiptNo = nextDocumentNumber(this.db, 'INV', now);
        const id = Number(
          this.db
            .prepare(
              `INSERT INTO sales (receipt_no, idempotency_key, sale_date, cashier_id, customer_name, customer_phone, notes, discount_code,
                                  subtotal_minor, line_discount_total_minor, order_discount_minor, tax_minor, total_minor)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(receiptNo, key, localDate(now), actor.userId, customerName, customerPhone, notes, discountCode, subtotal, lineDiscountTotal, totalDiscount, tax, total)
            .lastInsertRowid,
        );

        priced.forEach((l, idx) => {
          this.db
            .prepare(
              `INSERT INTO sale_items (sale_id, variant_id, product_name, sku, size, colour, quantity, unit_price_minor,
                                       unit_cost_minor, line_discount_minor, order_discount_share_minor, line_net_minor)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(id, l.variantId, l.v.name, l.v.sku, l.v.size, l.v.colour, l.quantity, l.v.price_minor, l.v.cost_minor, l.discountMinor, shares[idx], l.afterLine - shares[idx]);
          recordMovement(this.db, {
            variantId: l.variantId,
            type: 'sale',
            quantityDelta: -l.quantity,
            unitCostMinor: l.v.cost_minor,
            refType: 'sale',
            refId: id,
            userId: actor.userId,
          });
        });

        for (const p of payments) {
          this.db
            .prepare('INSERT INTO payments (sale_id, method_code, amount_minor, tendered_minor, change_minor, reference, payment_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, p.methodCode, p.amountMinor, p.tenderedMinor, p.changeMinor, p.reference, localDate(now));
        }
        if (discountCode) this.db.prepare('UPDATE discount_codes SET usage_count=usage_count+1 WHERE code=?').run(discountCode);
        writeAudit(this.db, actor, 'sale.create', 'sale', id, { receiptNo, total, lines: priced.length });
        return id;
      })
      .immediate();

    return this.loadSale(saleId);
  }

  private validatePayments(
    req: CheckoutRequest,
    total: number,
  ): Array<{ methodCode: string; amountMinor: number; tenderedMinor: number | null; changeMinor: number | null; reference: string }> {
    const payments = Array.isArray(req.payments) ? req.payments : [];
    if (total === 0) {
      if (payments.length > 0) throw new AppError('VALIDATION', 'A zero-value sale takes no payment.', 'payments');
      return [];
    }
    if (payments.length === 0) throw new AppError('VALIDATION', 'Add a payment to complete the sale.', 'payments');
    if (payments.length > 6) throw new AppError('VALIDATION', 'Too many payment lines.', 'payments');

    const out = payments.map((p) => {
      const method = this.db.prepare('SELECT code, name, is_cash, reference_mode, is_active FROM payment_methods WHERE code = ?').get(p.methodCode) as
        | { code: string; name: string; is_cash: number; reference_mode: string; is_active: number }
        | undefined;
      if (!method || !method.is_active) throw new AppError('VALIDATION', 'That payment method is not available.', 'payments');
      if (method.code === 'cod') throw new AppError('VALIDATION', 'Cash on delivery can only be recorded on a customer order.', 'payments');
      const amount = nonNegativeMinor(p.amountMinor, 'Payment amount');
      if (amount === 0) throw new AppError('VALIDATION', 'Payment amounts must be greater than zero.', 'payments');
      const reference = text(p.reference ?? '', 'Payment reference', 80);
      if (method.reference_mode === 'required' && !reference) {
        throw new AppError('VALIDATION', `${method.name} needs a payment reference.`, 'reference');
      }
      let tendered: number | null = null;
      let change: number | null = null;
      if (method.is_cash) {
        tendered = p.tenderedMinor === undefined || p.tenderedMinor === null ? amount : nonNegativeMinor(p.tenderedMinor, 'Amount tendered');
        if (tendered < amount) throw new AppError('VALIDATION', 'The amount tendered is less than the amount due.', 'tendered');
        change = tendered - amount;
      }
      return { methodCode: method.code, amountMinor: amount, tenderedMinor: tendered, changeMinor: change, reference };
    });

    const paid = out.reduce((a, p) => a + p.amountMinor, 0);
    if (paid !== total) {
      throw new AppError('VALIDATION', paid < total ? 'The payments do not cover the total.' : 'The payments exceed the total; enter the amount tendered for cash instead.', 'payments');
    }
    return out;
  }

  // ───────────── reading ─────────────
  list(actor: Actor, query: SaleQuery = {}): Page<SaleListItem> {
    assertCan(actor, 'sales.read');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const where: string[] = [];
    const params: unknown[] = [];
    const search = query.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push(`(s.receipt_no LIKE ? ESCAPE '\\' OR s.customer_name LIKE ? ESCAPE '\\' OR s.customer_phone LIKE ? ESCAPE '\\')`);
      params.push(like, like, like);
    }
    if (query.from && query.to) {
      const r = dateRange(query.from, query.to);
      where.push('s.sale_date BETWEEN ? AND ?');
      params.push(r.from, r.to);
    }
    if (query.status === 'completed' || query.status === 'cancelled') {
      where.push('s.status = ?');
      params.push(query.status);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM sales s ${w}`).get(...params) as { n: number }).n;
    const rows = this.db.prepare(`${SALE_SELECT} ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as SaleRow[];
    return { items: rows.map(toListItem), total, page, pageSize };
  }

  get(actor: Actor, id: number): SaleDetail {
    assertCan(actor, 'sales.read');
    return this.loadSale(id);
  }

  private loadSale(id: number): SaleDetail {
    const r = this.db.prepare(`${SALE_SELECT} WHERE s.id = ?`).get(id) as SaleRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'Sale not found.');
    const items = (
      this.db
        .prepare(
          `SELECT si.id, si.variant_id AS variantId, si.product_name AS productName, si.sku, si.size, si.colour,
                  si.quantity, si.unit_price_minor AS unitPriceMinor, si.unit_cost_minor AS unitCostMinor,
                  si.line_discount_minor AS lineDiscountMinor, si.order_discount_share_minor AS orderDiscountShareMinor,
                  si.line_net_minor AS lineNetMinor,
                  COALESCE((SELECT SUM(quantity) FROM return_items WHERE sale_item_id = si.id), 0) AS returnedQty
             FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`,
        )
        .all(id) as SaleItemDto[]
    );
    const payments = this.db
      .prepare(
        `SELECT p.id, p.method_code AS methodCode, m.name AS methodName, p.amount_minor AS amountMinor,
                p.tendered_minor AS tenderedMinor, p.change_minor AS changeMinor, p.reference
           FROM payments p JOIN payment_methods m ON m.code = p.method_code WHERE p.sale_id = ? ORDER BY p.id`,
      )
      .all(id) as PaymentDto[];
    return {
      ...toListItem(r),
      customerPhone: r.customer_phone,
      notes: r.notes,
      subtotalMinor: r.subtotal_minor,
      lineDiscountTotalMinor: r.line_discount_total_minor,
      orderDiscountMinor: r.order_discount_minor,
      taxMinor: r.tax_minor,
      cancelledAt: r.cancelled_at,
      cancelReason: r.cancel_reason,
      items,
      payments,
    };
  }

  receipt(actor: Actor, id: number): ReceiptDto {
    assertCan(actor, 'sales.read');
    const s = this.settings.getAll();
    return {
      shop: {
        name: s['shop.name'] ?? '',
        address: s['shop.address'] ?? '',
        phone: s['shop.phone'] ?? '',
        email: s['shop.email'] ?? '',
        footer: s['receipt.footer'] ?? '',
        paperWidthMm: Number(s['receipt.paper_width_mm'] ?? 80),
      },
      currency: {
        code: s['currency.code'] ?? 'LKR',
        symbol: s['currency.symbol'] ?? 'Rs',
        decimals: Number(s['currency.decimals'] ?? 2),
        locale: s['locale'] ?? 'en-LK',
      },
      taxLabel: s['tax.label'] ?? 'Tax',
      sale: this.loadSale(id),
    };
  }

  // ───────────── cancellation ─────────────
  /**
   * Cancels a completed sale and puts its stock back through the ledger.
   * The sale row is kept (status = cancelled) so history is never deleted.
   * Administrators may cancel directly; anyone else needs an administrator
   * to authorise it with their credentials. A sale that already has customer
   * returns cannot be cancelled (refunds were paid out against it).
   */
  cancel(actor: Actor, req: CancelSaleRequest): SaleDetail {
    const reason = text(req.reason, 'Reason', 300, true);
    let authorisedBy: string | null = null;
    if (!can(actor, 'sales.cancel')) {
      if (!req.override) throw new AppError('FORBIDDEN', 'An administrator must authorise cancelling a sale.');
      authorisedBy = this.auth.verifyAdminOverride(req.override.username, req.override.password).username;
    }

    this.db.transaction(() => {
      const sale = this.db.prepare('SELECT id, status, receipt_no FROM sales WHERE id = ?').get(req.saleId) as
        | { id: number; status: string; receipt_no: string }
        | undefined;
      if (!sale) throw new AppError('NOT_FOUND', 'Sale not found.');
      if (sale.status === 'cancelled') throw new AppError('CONFLICT', 'This sale is already cancelled.');
      if (this.db.prepare('SELECT 1 FROM returns WHERE sale_id = ?').get(sale.id)) {
        throw new AppError('CONFLICT', 'This sale already has returns recorded, so it cannot be cancelled.');
      }
      const items = this.db.prepare('SELECT variant_id, quantity, unit_cost_minor FROM sale_items WHERE sale_id = ?').all(sale.id) as Array<{
        variant_id: number; quantity: number; unit_cost_minor: number;
      }>;
      for (const i of items) {
        recordMovement(this.db, {
          variantId: i.variant_id,
          type: 'sale_cancellation',
          quantityDelta: i.quantity,
          unitCostMinor: i.unit_cost_minor,
          reason,
          refType: 'sale',
          refId: sale.id,
          userId: actor.userId,
        });
      }
      this.db
        .prepare(
          `UPDATE sales SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?`,
        )
        .run(actor.userId, reason, sale.id);
      writeAudit(this.db, actor, 'sale.cancel', 'sale', sale.id, { receiptNo: sale.receipt_no, reason, authorisedBy });
    }).immediate();
    return this.loadSale(req.saleId);
  }
}
