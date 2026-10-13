import { describe, expect, it } from 'vitest';
import { buildPeriods } from '../electron/services/report-service';
import { csvCell, plainMoney, toCsv } from '../electron/services/csv';
import { makeEnv } from './env';

const returnReq = (saleId: number, saleItemId: number, quantity: number, over: Partial<{ condition: 'resalable' | 'damaged'; restock: boolean; method: string | null }> = {}) => ({
  saleId,
  reason: 'Does not fit',
  notes: '',
  refundMethodCode: over.method === undefined ? 'cash' : over.method,
  items: [{ saleItemId, quantity, condition: over.condition ?? 'resalable', restock: over.restock ?? true }],
});

describe('customer returns', () => {
  it('restocks only when the item is resalable AND restock is explicitly confirmed', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 4 }]);
    expect(e.stock(variantId)).toBe(6);

    e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1, { restock: false }));
    expect(e.stock(variantId)).toBe(6); // resalable but not confirmed: not restocked

    e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1, { restock: true }));
    expect(e.stock(variantId)).toBe(7);

    e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1, { condition: 'damaged', restock: false }));
    expect(e.stock(variantId)).toBe(7); // damaged never touches stock
    expect(() => e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1, { condition: 'damaged', restock: true }))).toThrow(/Only resalable/);
  });

  it('links the return to the sale and writes a ledger entry referencing the return', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 2 }]);
    const ret = e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1));
    expect(ret).toMatchObject({ saleId: sale.id, receiptNo: sale.receiptNo, refundAmountMinor: 10_000, refundMethodName: 'Cash' });
    expect(ret.returnNo).toMatch(/^RET-/);
    const move = e.inventory.listMovements(e.admin, { type: 'customer_return' }).items[0];
    expect(move).toMatchObject({ quantityDelta: 1, refType: 'return', refLabel: ret.returnNo });
    expect(e.sales.get(e.cashier, sale.id).items[0].returnedQty).toBe(1);
    expect(e.sales.get(e.cashier, sale.id).refundedMinor).toBe(10_000);
  });

  it('cannot return more than was sold, across multiple returns', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 3 }]);
    const item = sale.items[0].id;
    expect(() => e.returns.create(e.cashier, returnReq(sale.id, item, 4))).toThrow(/Only 3/);
    e.returns.create(e.cashier, returnReq(sale.id, item, 2));
    expect(() => e.returns.create(e.cashier, returnReq(sale.id, item, 2))).toThrow(/Only 1/);
    e.returns.create(e.cashier, returnReq(sale.id, item, 1));
    expect(() => e.returns.create(e.cashier, returnReq(sale.id, item, 1))).toThrow(/fully returned/);
    expect(e.returns.getReturnable(e.cashier, sale.id).items[0]).toMatchObject({ soldQty: 3, returnedQty: 3, remainingQty: 0, remainingRefundMinor: 0 });
  });

  it('refunds exactly what was paid after discounts, with the remainder on the last unit (no rounding drift)', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, price: 10_000 });
    // 3 units, line total 30_000, minus 1_000 line discount, minus 1_000 order discount = 28_000 net (not divisible by 3)
    const sale = e.sell([{ variantId, quantity: 3, discountMinor: 1_000 }], { orderDiscountMinor: 1_000 });
    expect(sale.items[0].lineNetMinor).toBe(28_000);
    const item = sale.items[0].id;
    const r1 = e.returns.create(e.cashier, returnReq(sale.id, item, 1));
    const r2 = e.returns.create(e.cashier, returnReq(sale.id, item, 1));
    const r3 = e.returns.create(e.cashier, returnReq(sale.id, item, 1));
    expect(r1.refundAmountMinor).toBe(9_333);
    expect(r2.refundAmountMinor).toBe(9_333);
    expect(r3.refundAmountMinor).toBe(28_000 - 9_333 - 9_333);
    expect(r1.refundAmountMinor + r2.refundAmountMinor + r3.refundAmountMinor).toBe(28_000);
  });

  it('refunds use the sale-time price, not the current price', () => {
    const e = makeEnv();
    const { variantId, productId } = e.seedVariant({ stock: 5, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    const v = e.catalog.getProduct(e.admin, productId).variants[0];
    e.catalog.updateVariant(e.admin, v.id, { sku: v.sku, barcode: null, size: v.size, colour: v.colour, costMinor: v.costMinor, priceMinor: 99_000, reorderThreshold: 2 });
    expect(e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1)).refundAmountMinor).toBe(10_000);
  });

  it('requires a refund method when money is refunded, and a reason', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    expect(() => e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1, { method: null }))).toThrow(/how the refund is paid/);
    expect(() => e.returns.create(e.cashier, { ...returnReq(sale.id, sale.items[0].id, 1), reason: '' })).toThrow(/Reason is required/);
    expect(e.count('returns')).toBe(0);
  });

  it('rejects items from another sale, duplicates, cancelled sales and zero quantities', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10, price: 10_000 });
    const a = e.sell([{ variantId, quantity: 2 }]);
    const b = e.sell([{ variantId, quantity: 2 }]);
    expect(() => e.returns.create(e.cashier, returnReq(a.id, b.items[0].id, 1))).toThrow(/does not belong/);
    expect(() => e.returns.create(e.cashier, { ...returnReq(a.id, a.items[0].id, 1), items: [{ saleItemId: a.items[0].id, quantity: 1, condition: 'resalable', restock: true }, { saleItemId: a.items[0].id, quantity: 1, condition: 'resalable', restock: true }] })).toThrow(/only once/);
    expect(() => e.returns.create(e.cashier, returnReq(a.id, a.items[0].id, 0))).toThrow(/greater than zero/);
    e.sales.cancel(e.admin, { saleId: b.id, reason: 'Void' });
    expect(() => e.returns.create(e.cashier, returnReq(b.id, b.items[0].id, 1))).toThrow(/cancelled sale/);
  });

  it('a failed return (second line over the limit) records nothing and restocks nothing', () => {
    const e = makeEnv();
    const x = e.seedVariant({ stock: 10, price: 10_000 });
    const y = e.seedVariant({ stock: 10, price: 5_000 });
    const sale = e.sell([{ variantId: x.variantId, quantity: 1 }, { variantId: y.variantId, quantity: 1 }]);
    const before = { returns: e.count('returns'), moves: e.count('stock_movements') };
    expect(() =>
      e.returns.create(e.cashier, {
        saleId: sale.id, reason: 'r', notes: '', refundMethodCode: 'cash',
        items: [
          { saleItemId: sale.items[0].id, quantity: 1, condition: 'resalable', restock: true },
          { saleItemId: sale.items[1].id, quantity: 2, condition: 'resalable', restock: true },
        ],
      }),
    ).toThrow(/Only 1/);
    expect({ returns: e.count('returns'), moves: e.count('stock_movements') }).toEqual(before);
    expect(e.stock(x.variantId)).toBe(9);
  });

  it('the database blocks tampering with returns and over-refunds', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000 });
    const sale = e.sell([{ variantId, quantity: 2 }]);
    const ret = e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 1));
    expect(() => e.db.prepare('DELETE FROM returns WHERE id = ?').run(ret.id)).toThrow(/RETURNS_ARE_IMMUTABLE/);
    expect(() => e.db.prepare('UPDATE returns SET refund_amount_minor = 1 WHERE id = ?').run(ret.id)).toThrow(/RETURNS_ARE_IMMUTABLE/);
    const second = e.db.prepare("INSERT INTO returns (return_no, sale_id, return_date, refund_amount_minor, reason, refund_method_code) VALUES ('RAW-1', ?, '2026-10-12', 0, 'x', NULL)").run(sale.id);
    // 1 of 2 units already returned: asking for 2 more exceeds the quantity limit (refund of 1 is within the value limit).
    expect(() => e.db.prepare("INSERT INTO return_items (return_id, sale_item_id, quantity, refund_minor, condition) VALUES (?, ?, 2, 1, 'damaged')").run(second.lastInsertRowid, sale.items[0].id)).toThrow(/RETURN_EXCEEDS_SOLD_QUANTITY/);
    // Quantity is fine (1 unit left) but the refund is more than the remaining line value.
    expect(() => e.db.prepare("INSERT INTO return_items (return_id, sale_item_id, quantity, refund_minor, condition) VALUES (?, ?, 1, 999999, 'damaged')").run(second.lastInsertRowid, sale.items[0].id)).toThrow(/REFUND_EXCEEDS_LINE_TOTAL/);
  });
});

describe('financial figures', () => {
  it('computes gross sales, discounts, refunds, net sales, COGS, gross profit and net profit', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 20, price: 10_000, cost: 4_000 });
    const s1 = e.sell([{ variantId, quantity: 4, discountMinor: 2_000 }], { orderDiscountMinor: 1_000 });
    e.sell([{ variantId, quantity: 1 }]);
    // sales: gross 40_000 + 10_000 = 50_000; discounts 3_000; COGS 5 × 4_000 = 20_000
    e.returns.create(e.cashier, returnReq(s1.id, s1.items[0].id, 1, { restock: true })); // refund (40_000-3_000)/4 floor = 9_250; COGS recovered 4_000
    e.returns.create(e.cashier, returnReq(s1.id, s1.items[0].id, 1, { condition: 'damaged', restock: false })); // refund 9_250; cost stays lost
    const cat = e.expenses.listCategories(e.admin)[0];
    e.expenses.save(e.admin, { categoryId: cat.id, expenseDate: s1.saleDate, amountMinor: 6_000, paymentMethodCode: 'cash', notes: 'Rent share' });

    const f = e.dashboard.get(e.admin).financials;
    expect(f.saleCount).toBe(2);
    expect(f.grossSalesMinor).toBe(50_000);
    expect(f.discountsMinor).toBe(3_000);
    expect(f.refundsMinor).toBe(18_500);
    expect(f.netSalesMinor).toBe(50_000 - 3_000 - 18_500);
    expect(f.cogsMinor).toBe(20_000 - 4_000);
    expect(f.grossProfitMinor).toBe(f.netSalesMinor - f.cogsMinor);
    expect(f.operatingExpensesMinor).toBe(6_000);
    expect(f.netProfitMinor).toBe(f.grossProfitMinor - 6_000);
    // gross and net profit are distinct figures
    expect(f.netProfitMinor).not.toBe(f.grossProfitMinor);
  });

  it('excludes voided expenses and counts tax separately from sales and profit', () => {
    const e = makeEnv();
    e.settings.update(e.admin, { taxEnabled: true, taxRateBps: 1_000 });
    const { variantId } = e.seedVariant({ stock: 5, price: 10_000, cost: 3_000 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    expect(sale.taxMinor).toBe(1_000);
    const cat = e.expenses.listCategories(e.admin)[0];
    const exp = e.expenses.save(e.admin, { categoryId: cat.id, expenseDate: sale.saleDate, amountMinor: 500, paymentMethodCode: null, notes: '' });
    e.expenses.void(e.admin, exp.id);
    const f = e.dashboard.get(e.admin).financials;
    expect(f.grossSalesMinor).toBe(10_000);
    expect(f.taxCollectedMinor).toBe(1_000);
    expect(f.operatingExpensesMinor).toBe(0);
    expect(f.grossProfitMinor).toBe(7_000);
  });

  it('dashboard totals, low-stock list, best sellers and trend come from real data', () => {
    const e = makeEnv();
    const a = e.seedVariant({ name: 'Alpha', stock: 5, reorder: 4, price: 10_000, cost: 1_000 });
    const b = e.seedVariant({ name: 'Beta', stock: 20, reorder: 1, price: 10_000, cost: 1_000 });
    e.sell([{ variantId: a.variantId, quantity: 2 }, { variantId: b.variantId, quantity: 5 }]);
    const d = e.dashboard.get(e.admin);
    expect(d.totalUnitsInStock).toBe(3 + 15);
    expect(d.lowStockCount).toBe(1);
    expect(d.lowStock[0].productName).toBe('Alpha');
    expect(d.bestSellers[0]).toMatchObject({ name: 'Beta', unitsSold: 5 });
    expect(d.recentSales).toHaveLength(1);
    expect(d.trend).toHaveLength(14);
    expect(d.trend[13]).toMatchObject({ saleCount: 1, grossSalesMinor: 70_000 });
  });

  it('dashboard is empty (zeros), not demo data, on a fresh install', () => {
    const e = makeEnv();
    const d = e.dashboard.get(e.admin);
    expect(d.financials.grossSalesMinor).toBe(0);
    expect(d.totalUnitsInStock).toBe(0);
    expect(d.recentSales).toEqual([]);
    expect(d.bestSellers).toEqual([]);
  });

  it('cashiers cannot see the dashboard, reports, or expenses', () => {
    const e = makeEnv();
    expect(() => e.dashboard.get(e.cashier)).toThrow(/permission/);
    expect(() => e.reports.sales(e.cashier, { from: '2026-01-01', to: '2026-01-31', groupBy: 'day' })).toThrow(/permission/);
    expect(() => e.expenses.list(e.cashier)).toThrow(/permission/);
    expect(() => e.audit.list(e.cashier)).toThrow(/permission/);
  });
});

describe('expenses', () => {
  it('validates amount, date and category; edits and voids with audit trail; never deletes', () => {
    const e = makeEnv();
    const cat = e.expenses.listCategories(e.admin).find((c) => c.name === 'Rent')!;
    const base = { categoryId: cat.id, expenseDate: '2026-10-01', amountMinor: 50_000, paymentMethodCode: 'cash', notes: 'October' };
    expect(() => e.expenses.save(e.admin, { ...base, amountMinor: 0 })).toThrow(/greater than zero/);
    expect(() => e.expenses.save(e.admin, { ...base, amountMinor: -5 })).toThrow(/negative/);
    expect(() => e.expenses.save(e.admin, { ...base, expenseDate: '2026-13-01' })).toThrow(/real date|YYYY-MM-DD/);
    expect(() => e.expenses.save(e.admin, { ...base, categoryId: 9999 })).toThrow(/Choose a category/);
    const created = e.expenses.save(e.admin, base);
    const edited = e.expenses.save(e.admin, { ...base, id: created.id, amountMinor: 60_000 });
    expect(edited.amountMinor).toBe(60_000);
    const voided = e.expenses.void(e.admin, created.id);
    expect(voided.voidedAt).not.toBeNull();
    expect(() => e.expenses.save(e.admin, { ...base, id: created.id })).toThrow(/voided/);
    expect(() => e.expenses.void(e.admin, created.id)).toThrow(/already voided/);
    expect(e.expenses.list(e.admin, {}).total).toBe(0);
    expect(e.expenses.list(e.admin, { includeVoided: true }).total).toBe(1);
    const actions = (e.db.prepare("SELECT action FROM audit_logs WHERE entity_type = 'expense' ORDER BY id").all() as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toEqual(['expense.create', 'expense.update', 'expense.void']);
  });

  it('totals the filtered, non-voided amounts', () => {
    const e = makeEnv();
    const [c1, c2] = e.expenses.listCategories(e.admin);
    e.expenses.save(e.admin, { categoryId: c1.id, expenseDate: '2026-10-01', amountMinor: 1_000, paymentMethodCode: null, notes: '' });
    e.expenses.save(e.admin, { categoryId: c2.id, expenseDate: '2026-10-02', amountMinor: 2_500, paymentMethodCode: null, notes: '' });
    e.expenses.save(e.admin, { categoryId: c2.id, expenseDate: '2026-11-02', amountMinor: 9_999, paymentMethodCode: null, notes: '' });
    expect(e.expenses.list(e.admin, { from: '2026-10-01', to: '2026-10-31' }).totalMinor).toBe(3_500);
    expect(e.expenses.list(e.admin, { from: '2026-10-01', to: '2026-10-31', categoryId: c2.id }).totalMinor).toBe(2_500);
  });
});

describe('reports', () => {
  it('splits ranges into day, Monday-based week and month periods that tile the range exactly', () => {
    expect(buildPeriods('2026-10-01', '2026-10-03', 'day').map((p) => p.label)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    // 2026-10-12 is a Monday
    const weeks = buildPeriods('2026-10-07', '2026-10-20', 'week');
    expect(weeks).toEqual([
      { label: '2026-10-05', from: '2026-10-07', to: '2026-10-11' },
      { label: '2026-10-12', from: '2026-10-12', to: '2026-10-18' },
      { label: '2026-10-19', from: '2026-10-19', to: '2026-10-20' },
    ]);
    const months = buildPeriods('2026-01-15', '2026-03-10', 'month');
    expect(months).toEqual([
      { label: '2026-01', from: '2026-01-15', to: '2026-01-31' },
      { label: '2026-02', from: '2026-02-01', to: '2026-02-28' },
      { label: '2026-03', from: '2026-03-01', to: '2026-03-10' },
    ]);
  });

  it('period rows add up to the totals', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 20, price: 10_000, cost: 3_000 });
    const sale = e.sell([{ variantId, quantity: 3, discountMinor: 500 }]);
    const rep = e.reports.sales(e.admin, { from: sale.saleDate, to: sale.saleDate, groupBy: 'month' });
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0].grossSalesMinor).toBe(rep.totals.grossSalesMinor);
    expect(rep.totals).toMatchObject({ grossSalesMinor: 30_000, discountsMinor: 500, cogsMinor: 9_000, grossProfitMinor: 30_000 - 500 - 9_000 });
  });

  it('rejects inverted and oversized ranges', () => {
    const e = makeEnv();
    expect(() => e.reports.sales(e.admin, { from: '2026-02-01', to: '2026-01-01', groupBy: 'day' })).toThrow(/not be after/);
    expect(() => e.reports.sales(e.admin, { from: '2020-01-01', to: '2026-01-01', groupBy: 'day' })).toThrow(/two years/);
  });

  it('best sellers are net of returns', () => {
    const e = makeEnv();
    const a = e.seedVariant({ name: 'A', stock: 20, price: 1_000 });
    const sale = e.sell([{ variantId: a.variantId, quantity: 5 }]);
    e.returns.create(e.cashier, returnReq(sale.id, sale.items[0].id, 2));
    const r = e.reports.bestSellers(e.admin, { from: sale.saleDate, to: sale.saleDate });
    expect(r[0]).toMatchObject({ name: 'A', unitsSold: 3, revenueMinor: 3_000 });
  });
});

describe('CSV export', () => {
  it('formats money without symbols or grouping and escapes properly', () => {
    expect(plainMoney(123_456, 2)).toBe('1234.56');
    expect(plainMoney(-5, 2)).toBe('-0.05');
    expect(plainMoney(7, 0)).toBe('7');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(-12)).toBe('-12');
  });

  it('neutralises spreadsheet formula injection in text cells', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(toCsv(['a'], [['=1+1']])).toContain("'=1+1");
  });

  it('exports every report type with a BOM, header and sensible file name', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ name: '=Evil Tee', stock: 5, price: 12_345, cost: 1_000 });
    const sale = e.sell([{ variantId, quantity: 1 }]);
    const cat = e.expenses.listCategories(e.admin)[0];
    e.expenses.save(e.admin, { categoryId: cat.id, expenseDate: sale.saleDate, amountMinor: 1_050, paymentMethodCode: null, notes: 'x' });
    const range = { from: sale.saleDate, to: sale.saleDate };
    for (const report of ['sales', 'best-sellers', 'stock-valuation', 'low-stock', 'movements', 'purchases', 'expenses'] as const) {
      const out = e.reports.buildCsv(e.admin, { report, ...range });
      expect(out.content.startsWith('﻿')).toBe(true);
      expect(out.fileName).toMatch(/\.csv$/);
      expect(out.content.split('\r\n').length).toBeGreaterThanOrEqual(2);
    }
    const sales = e.reports.buildCsv(e.admin, { report: 'sales', ...range });
    expect(sales.content).toContain('123.45');
    const best = e.reports.buildCsv(e.admin, { report: 'best-sellers', ...range });
    expect(best.content).toContain("'=Evil Tee");
    expect(() => e.reports.buildCsv(e.cashier, { report: 'sales', ...range })).toThrow(/permission/);
  });
});
