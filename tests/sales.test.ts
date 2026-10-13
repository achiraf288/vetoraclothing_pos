import { describe, expect, it } from 'vitest';
import { makeEnv, newKey, ADMIN_PASSWORD, CASHIER_PASSWORD } from './env';

describe('checkout', () => {
  it('completes a sale: totals, receipt number, snapshots, payment, stock and ledger link', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, cost: 100_000, price: 250_000 });
    const sale = e.sell([{ variantId, quantity: 2 }]);
    expect(sale.receiptNo).toMatch(/^INV-\d{8}-0001$/);
    expect(sale.status).toBe('completed');
    expect(sale.subtotalMinor).toBe(500_000);
    expect(sale.totalMinor).toBe(500_000);
    expect(sale.items[0]).toMatchObject({ quantity: 2, unitPriceMinor: 250_000, unitCostMinor: 100_000, lineNetMinor: 500_000 });
    expect(sale.payments).toEqual([expect.objectContaining({ methodCode: 'cash', amountMinor: 500_000, tenderedMinor: 500_000, changeMinor: 0 })]);
    expect(e.stock(variantId)).toBe(8);
    const move = e.inventory.listMovements(e.admin, { type: 'sale' }).items[0];
    expect(move).toMatchObject({ quantityDelta: -2, refType: 'sale', refId: sale.id, refLabel: sale.receiptNo, unitCostMinor: 100_000 });
  });

  it('numbers receipts sequentially', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    const a = e.sell([{ variantId, quantity: 1 }]);
    const b = e.sell([{ variantId, quantity: 1 }]);
    expect(a.receiptNo.endsWith('-0001')).toBe(true);
    expect(b.receiptNo.endsWith('-0002')).toBe(true);
  });

  it('keeps historical prices when the product price later changes', () => {
    const e = makeEnv();
    const { variantId, productId } = e.seedVariant({ stock: 10, price: 250_000, cost: 100_000 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    const detail = e.catalog.getProduct(e.admin, productId);
    e.catalog.updateVariant(e.admin, detail.variants[0].id, {
      sku: detail.variants[0].sku, barcode: null, size: 'M', colour: 'Black', costMinor: 150_000, priceMinor: 400_000, reorderThreshold: 2,
    });
    const again = e.sales.get(e.cashier, sale.id);
    expect(again.items[0].unitPriceMinor).toBe(250_000);
    expect(again.items[0].unitCostMinor).toBe(100_000);
    expect(again.totalMinor).toBe(250_000);
    // new sales use the new price
    expect(e.sell([{ variantId, quantity: 1 }]).totalMinor).toBe(400_000);
  });

  it('never trusts a client-supplied price (price comes from the database)', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 250_000 });
    const req = { idempotencyKey: newKey(), items: [{ variantId, quantity: 1, discountMinor: 0, unitPriceMinor: 1 } as never], orderDiscountMinor: 0, customerName: '', customerPhone: '', notes: '', payments: [{ methodCode: 'cash', amountMinor: 1 }] };
    expect(() => e.sales.checkout(e.cashier, req)).toThrow(/do not cover/);
    expect(e.count('sales')).toBe(0);
  });

  it('applies line and order discounts and allocates the order discount exactly', () => {
    const e = makeEnv();
    const a = e.seedVariant({ stock: 10, price: 10_000, cost: 4_000 });
    const b = e.seedVariant({ stock: 10, price: 20_000, cost: 8_000 });
    const sale = e.sell([{ variantId: a.variantId, quantity: 1, discountMinor: 1_000 }, { variantId: b.variantId, quantity: 2 }], { orderDiscountMinor: 1_001 });
    // subtotal 50_000, line discount 1_000, order discount 1_001
    expect(sale.subtotalMinor).toBe(50_000);
    expect(sale.lineDiscountTotalMinor).toBe(1_000);
    expect(sale.orderDiscountMinor).toBe(1_001);
    expect(sale.totalMinor).toBe(50_000 - 1_000 - 1_001);
    const share = sale.items.reduce((s, i) => s + i.orderDiscountShareMinor, 0);
    expect(share).toBe(1_001);
    expect(sale.items.reduce((s, i) => s + i.lineNetMinor, 0)).toBe(sale.totalMinor);
  });

  it('rejects discounts larger than the line or the order', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    expect(() => e.sell([{ variantId, quantity: 1, discountMinor: 10_001 }])).toThrow(/exceeds the line total/);
    expect(() => e.sell([{ variantId, quantity: 1 }], { orderDiscountMinor: 10_001 })).toThrow(/exceeds the amount due/);
    expect(e.stock(variantId)).toBe(5);
  });

  it('computes cash change and supports split payments', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    const cash = e.sell([{ variantId, quantity: 1 }], { payments: [{ methodCode: 'cash', amountMinor: 10_000, tenderedMinor: 15_000 }] });
    expect(cash.payments[0]).toMatchObject({ tenderedMinor: 15_000, changeMinor: 5_000 });
    const split = e.sell([{ variantId, quantity: 2 }], {
      payments: [{ methodCode: 'cash', amountMinor: 5_000 }, { methodCode: 'card', amountMinor: 15_000, reference: 'AUTH123' }],
    });
    expect(split.payments).toHaveLength(2);
    expect(split.payments.reduce((s, p) => s + p.amountMinor, 0)).toBe(20_000);
  });

  it('validates payments: must match total, valid method, required reference, tendered >= amount', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 20, price: 10_000 });
    const item = [{ variantId, quantity: 1 }];
    expect(() => e.sell(item, { payments: [] })).toThrow(/Add a payment/);
    expect(() => e.sell(item, { payments: [{ methodCode: 'cash', amountMinor: 9_999 }] })).toThrow(/do not cover/);
    expect(() => e.sell(item, { payments: [{ methodCode: 'cash', amountMinor: 10_001 }] })).toThrow(/exceed/);
    expect(() => e.sell(item, { payments: [{ methodCode: 'bitcoin', amountMinor: 10_000 }] })).toThrow(/not available/);
    expect(() => e.sell(item, { payments: [{ methodCode: 'bank_transfer', amountMinor: 10_000 }] })).toThrow(/needs a payment reference/);
    expect(() => e.sell(item, { payments: [{ methodCode: 'cash', amountMinor: 10_000, tenderedMinor: 9_000 }] })).toThrow(/tendered is less/);
    expect(() => e.sell(item, { payments: [{ methodCode: 'cash', amountMinor: 0 }] })).toThrow(/greater than zero/);
    expect(e.sell(item, { payments: [{ methodCode: 'bank_transfer', amountMinor: 10_000, reference: 'TRX-9' }] }).payments[0].reference).toBe('TRX-9');
    expect(e.count('sales')).toBe(1);
  });

  it('refuses to sell more than is in stock and leaves everything unchanged', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 2 });
    expect(() => e.sell([{ variantId, quantity: 3 }])).toThrow(/Only 2 of/);
    expect(e.stock(variantId)).toBe(2);
    expect(e.count('sales')).toBe(0);
  });

  it('merges repeated lines of the same variant before checking stock', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 3 });
    expect(() => e.sell([{ variantId, quantity: 2 }, { variantId, quantity: 2 }])).toThrow(/Only 3 of/);
    expect(e.sell([{ variantId, quantity: 1 }, { variantId, quantity: 2 }]).items).toHaveLength(1);
  });

  it('rolls back the ENTIRE checkout when any line fails — no sale, no payments, no stock change, no receipt number used', () => {
    const e = makeEnv();
    const ok = e.seedVariant({ stock: 5 });
    const scarce = e.seedVariant({ stock: 1 });
    const before = { sales: e.count('sales'), items: e.count('sale_items'), pay: e.count('payments'), moves: e.count('stock_movements') };
    expect(() => e.sell([{ variantId: ok.variantId, quantity: 2 }, { variantId: scarce.variantId, quantity: 4 }])).toThrow(/Only 1 of/);
    expect({ sales: e.count('sales'), items: e.count('sale_items'), pay: e.count('payments'), moves: e.count('stock_movements') }).toEqual(before);
    expect(e.stock(ok.variantId)).toBe(5);
    // the failed attempt did not burn a receipt number
    expect(e.sell([{ variantId: ok.variantId, quantity: 1 }]).receiptNo.endsWith('-0001')).toBe(true);
  });

  it('rolls back if the database fails midway (stock deduction rejected by the ledger trigger)', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5 });
    // Force a failure AFTER the sale and sale items are inserted: block movements for this variant.
    e.db.exec(`CREATE TRIGGER test_fail_move BEFORE INSERT ON stock_movements WHEN NEW.movement_type = 'sale' BEGIN SELECT RAISE(ABORT, 'SIMULATED_FAILURE'); END;`);
    const before = { sales: e.count('sales'), items: e.count('sale_items'), pay: e.count('payments') };
    expect(() => e.sell([{ variantId, quantity: 1 }])).toThrow(/SIMULATED_FAILURE/);
    expect({ sales: e.count('sales'), items: e.count('sale_items'), pay: e.count('payments') }).toEqual(before);
    expect(e.stock(variantId)).toBe(5);
    e.db.exec('DROP TRIGGER test_fail_move');
    expect(e.sell([{ variantId, quantity: 1 }]).receiptNo.endsWith('-0001')).toBe(true);
  });

  it('is idempotent: submitting the same checkout twice creates one sale and deducts stock once', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, price: 10_000 });
    const req = { idempotencyKey: 'dup-protect-key-1', items: [{ variantId, quantity: 2, discountMinor: 0 }], orderDiscountMinor: 0, customerName: '', customerPhone: '', notes: '', payments: [{ methodCode: 'cash', amountMinor: 20_000 }] };
    const first = e.sales.checkout(e.cashier, req);
    const second = e.sales.checkout(e.cashier, req);
    expect(second.id).toBe(first.id);
    expect(second.receiptNo).toBe(first.receiptNo);
    expect(e.count('sales')).toBe(1);
    expect(e.count('payments')).toBe(1);
    expect(e.stock(variantId)).toBe(8);
  });

  it('rejects empty carts, bad quantities and archived items', () => {
    const e = makeEnv();
    const { variantId, productId } = e.seedVariant({ stock: 5 });
    expect(() => e.sell([])).toThrow(/cart is empty/);
    expect(() => e.sell([{ variantId, quantity: 0 }])).toThrow(/greater than zero/);
    expect(() => e.sell([{ variantId, quantity: -1 }])).toThrow(/greater than zero/);
    expect(() => e.sell([{ variantId, quantity: 1.5 }])).toThrow(/whole number/);
    expect(() => e.sell([{ variantId, quantity: 1, discountMinor: -1 }])).toThrow(/negative/);
    e.catalog.setProductArchived(e.admin, productId, true);
    expect(() => e.sell([{ variantId, quantity: 1 }])).toThrow(/archived/);
    expect(() => e.sales.checkout(e.cashier, { idempotencyKey: 'x', items: [], orderDiscountMinor: 0, customerName: '', customerPhone: '', notes: '', payments: [] })).toThrow(/Invalid checkout/);
  });

  it('adds tax only when enabled and configured, calculated in integer minor units', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    expect(e.sell([{ variantId, quantity: 1 }]).taxMinor).toBe(0);
    e.settings.update(e.admin, { taxEnabled: true, taxRateBps: 1_800, taxLabel: 'VAT' });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    expect(sale.taxMinor).toBe(1_800);
    expect(sale.totalMinor).toBe(11_800);
  });

  it('supports a zero-value sale (fully discounted) with no payment', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 1, discountMinor: 10_000 }], { payments: [] });
    expect(sale.totalMinor).toBe(0);
    expect(sale.payments).toHaveLength(0);
    expect(e.stock(variantId)).toBe(4);
  });

  it('finds items by name, SKU, barcode and combined size/colour terms; ignores archived', () => {
    const e = makeEnv();
    e.seedVariant({ name: 'Linen Shirt', size: 'L', colour: 'Blue', barcode: '4790001112223' });
    e.seedVariant({ name: 'Linen Shirt', size: 'M', colour: 'Blue' });
    const archived = e.seedVariant({ name: 'Linen Hidden', size: 'M', colour: 'Blue' });
    e.catalog.setProductArchived(e.admin, archived.productId, true);
    expect(e.sales.lookup(e.cashier, { query: 'linen' })).toHaveLength(2);
    expect(e.sales.lookup(e.cashier, { query: 'linen blue l' })).toHaveLength(2); // 'l' also matches "Linen"
    expect(e.sales.lookup(e.cashier, { query: 'shirt L' }).map((v) => v.size)).toContain('L');
    expect(e.sales.scan(e.cashier, { code: '4790001112223' })?.size).toBe('L');
    expect(e.sales.scan(e.cashier, { code: 'nope' })).toBeNull();
    expect(e.sales.lookup(e.cashier, { query: '%' })).toHaveLength(0);
  });

  it('lists and searches sales by receipt number and date range', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    const a = e.sell([{ variantId, quantity: 1 }], { customerName: 'Nimali' });
    e.sell([{ variantId, quantity: 1 }]);
    expect(e.sales.list(e.cashier, { search: a.receiptNo }).items.map((s) => s.id)).toEqual([a.id]);
    expect(e.sales.list(e.cashier, { search: 'nimali' }).total).toBe(1);
    expect(e.sales.list(e.cashier, { from: '2000-01-01', to: '2000-01-02' }).total).toBe(0);
    expect(e.sales.list(e.cashier, { from: a.saleDate, to: a.saleDate }).total).toBe(2);
    expect(() => e.sales.list(e.cashier, { from: '2026-02-30', to: '2026-03-01' })).toThrow(/real date/);
  });

  it('builds a receipt with shop details and paper width', () => {
    const e = makeEnv();
    e.settings.update(e.admin, { shopName: 'Maison Test', receiptPaperWidthMm: 58, receiptFooter: 'Come again' });
    const { variantId } = e.seedVariant({ stock: 5 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    const r = e.sales.receipt(e.cashier, sale.id);
    expect(r.shop).toMatchObject({ name: 'Maison Test', paperWidthMm: 58, footer: 'Come again' });
    expect(r.currency.code).toBe('LKR');
    expect(r.sale.receiptNo).toBe(sale.receiptNo);
  });
});

describe('completed sales are immutable', () => {
  it('cannot be deleted or edited at the database level', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    expect(() => e.db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id)).toThrow(/SALES_ARE_IMMUTABLE/);
    expect(() => e.db.prepare('UPDATE sales SET total_minor = 1 WHERE id = ?').run(sale.id)).toThrow();
    expect(() => e.db.prepare('UPDATE sale_items SET unit_price_minor = 1 WHERE sale_id = ?').run(sale.id)).toThrow(/SALES_ARE_IMMUTABLE/);
    expect(() => e.db.prepare('DELETE FROM payments WHERE sale_id = ?').run(sale.id)).toThrow(/SALES_ARE_IMMUTABLE/);
  });
});

describe('cancelling a sale', () => {
  it('restocks through the ledger and keeps the sale record', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    const sale = e.sell([{ variantId, quantity: 3 }]);
    expect(e.stock(variantId)).toBe(7);
    const cancelled = e.sales.cancel(e.admin, { saleId: sale.id, reason: 'Customer left without paying' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Customer left without paying');
    expect(e.stock(variantId)).toBe(10);
    expect(e.count('sales')).toBe(1);
    expect(e.inventory.listMovements(e.admin, { type: 'sale_cancellation' }).items[0]).toMatchObject({ quantityDelta: 3, refId: sale.id });
  });

  it('requires a reason and cannot be done twice', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    expect(() => e.sales.cancel(e.admin, { saleId: sale.id, reason: ' ' })).toThrow(/Reason is required/);
    e.sales.cancel(e.admin, { saleId: sale.id, reason: 'Mistake' });
    expect(() => e.sales.cancel(e.admin, { saleId: sale.id, reason: 'Again' })).toThrow(/already cancelled/);
    expect(e.stock(variantId)).toBe(10);
  });

  it('a cashier cannot cancel alone, but can with an administrator’s authorisation', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    expect(() => e.sales.cancel(e.cashier, { saleId: sale.id, reason: 'Wrong item' })).toThrow(/administrator must authorise/);
    expect(() => e.sales.cancel(e.cashier, { saleId: sale.id, reason: 'Wrong item', override: { username: 'owner', password: 'bad-password' } })).toThrow(/authorisation failed/);
    expect(() => e.sales.cancel(e.cashier, { saleId: sale.id, reason: 'Wrong item', override: { username: 'cashier1', password: CASHIER_PASSWORD } })).toThrow(/authorisation failed/);
    expect(e.stock(variantId)).toBe(9);
    const done = e.sales.cancel(e.cashier, { saleId: sale.id, reason: 'Wrong item', override: { username: 'owner', password: ADMIN_PASSWORD } });
    expect(done.status).toBe('cancelled');
    const audit = e.db.prepare("SELECT username, details FROM audit_logs WHERE action = 'sale.cancel'").get() as { username: string; details: string };
    expect(audit.username).toBe('cashier1');
    expect(JSON.parse(audit.details).authorisedBy).toBe('owner');
    expect(audit.details).not.toContain(ADMIN_PASSWORD);
  });

  it('cannot cancel a sale that already has returns', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    const sale = e.sell([{ variantId, quantity: 2 }]);
    e.returns.create(e.cashier, { saleId: sale.id, reason: 'Too small', notes: '', refundMethodCode: 'cash', items: [{ saleItemId: sale.items[0].id, quantity: 1, condition: 'resalable', restock: true }] });
    expect(() => e.sales.cancel(e.admin, { saleId: sale.id, reason: 'x' })).toThrow(/already has returns/);
  });

  it('cancelled sales are excluded from the dashboard and reports', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, price: 10_000, cost: 4_000 });
    const keep = e.sell([{ variantId, quantity: 1 }]);
    const drop = e.sell([{ variantId, quantity: 2 }]);
    e.sales.cancel(e.admin, { saleId: drop.id, reason: 'Duplicate entry' });
    const today = keep.saleDate;
    const d = e.dashboard.get(e.admin);
    expect(d.financials.saleCount).toBe(1);
    expect(d.financials.grossSalesMinor).toBe(10_000);
    expect(d.financials.cogsMinor).toBe(4_000);
    const rep = e.reports.sales(e.admin, { from: today, to: today, groupBy: 'day' });
    expect(rep.totals.grossSalesMinor).toBe(10_000);
  });
});
