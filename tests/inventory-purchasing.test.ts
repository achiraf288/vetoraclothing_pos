import { describe, expect, it } from 'vitest';
import { makeEnv } from './env';

describe('manual stock adjustments', () => {
  it('requires a reason and a positive whole quantity', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    expect(() => e.inventory.adjust(e.admin, { variantId, kind: 'decrease', quantity: 1, reason: '  ' })).toThrow(/Reason is required/);
    expect(() => e.inventory.adjust(e.admin, { variantId, kind: 'decrease', quantity: 0, reason: 'x' })).toThrow(/greater than zero/);
    expect(() => e.inventory.adjust(e.admin, { variantId, kind: 'decrease', quantity: 1.5, reason: 'x' })).toThrow(/whole number/);
    expect(e.stock(variantId)).toBe(10);
  });

  it('records each change in the ledger with balance, reason and user', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 10 });
    e.inventory.adjust(e.admin, { variantId, kind: 'increase', quantity: 5, reason: 'Found in back room' });
    e.inventory.adjust(e.admin, { variantId, kind: 'damaged', quantity: 2, reason: 'Water damage' });
    e.inventory.adjust(e.admin, { variantId, kind: 'lost', quantity: 1, reason: 'Stock take shortfall' });
    expect(e.stock(variantId)).toBe(12);
    const moves = e.inventory.listMovements(e.admin, { variantId }).items;
    expect(moves.map((m) => [m.type, m.quantityDelta, m.balanceAfter])).toEqual([
      ['lost', -1, 12],
      ['damaged', -2, 13],
      ['adjustment_increase', 5, 15],
      ['opening_stock', 10, 10],
    ]);
    expect(moves[1].reason).toBe('Water damage');
    expect(moves[1].username).toBe('owner');
    expect(e.count('audit_logs')).toBeGreaterThan(0);
  });

  it('refuses to push stock below zero by default, and the failed attempt leaves no trace', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 3 });
    const before = e.count('stock_movements');
    expect(() => e.inventory.adjust(e.admin, { variantId, kind: 'decrease', quantity: 4, reason: 'oops' })).toThrow(/Only 3 in stock/);
    expect(e.stock(variantId)).toBe(3);
    expect(e.count('stock_movements')).toBe(before);
  });

  it('allows negative stock only when the setting is explicitly enabled', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 1 });
    e.settings.update(e.admin, { allowNegativeStock: true });
    e.inventory.adjust(e.admin, { variantId, kind: 'decrease', quantity: 3, reason: 'Backorder correction' });
    expect(e.stock(variantId)).toBe(-2);
  });

  it('keeps stock separate per variant (black M vs black L)', () => {
    const e = makeEnv();
    const detail = e.catalog.createProduct(e.admin, {
      product: { sku: 'TEE', name: 'Tee', categoryId: null, brand: '', description: '', defaultCostMinor: 100, defaultPriceMinor: 200 },
      variants: [
        { sku: 'TEE-BLK-M', size: 'M', colour: 'Black', costMinor: 100, priceMinor: 200, reorderThreshold: 1, openingStock: 4 },
        { sku: 'TEE-BLK-L', size: 'L', colour: 'Black', costMinor: 100, priceMinor: 200, reorderThreshold: 1, openingStock: 9 },
      ],
    });
    const [m, l] = detail.variants;
    e.sell([{ variantId: m.id, quantity: 3 }]);
    expect([e.stock(m.id), e.stock(l.id)]).toEqual([1, 9]);
  });

  it('only allows opening stock before any other movement', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5 });
    expect(() => e.inventory.adjust(e.admin, { variantId, kind: 'opening', quantity: 3, reason: 'again' })).toThrow(/Opening stock can only be set/);
  });

  it('cashiers cannot adjust stock', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5 });
    expect(() => e.inventory.adjust(e.cashier, { variantId, kind: 'increase', quantity: 1, reason: 'sneaky' })).toThrow(/permission/);
    expect(e.stock(variantId)).toBe(5);
  });

  it('the database itself rejects direct stock edits that bypass the ledger', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ stock: 5 });
    expect(() => e.db.prepare('UPDATE product_variants SET stock_qty = 500 WHERE id = ?').run(variantId)).toThrow(/STOCK_LEDGER_MISMATCH/);
  });
});

describe('stock reporting', () => {
  it('lists low stock and values stock at cost and retail', () => {
    const e = makeEnv();
    e.seedVariant({ name: 'Low', stock: 1, reorder: 3, cost: 1000, price: 2500 });
    e.seedVariant({ name: 'Fine', stock: 10, reorder: 3, cost: 2000, price: 5000 });
    expect(e.inventory.listLowStock(e.admin).map((r) => r.productName)).toEqual(['Low']);
    const v = e.inventory.valuation(e.admin);
    expect(v.totalUnits).toBe(11);
    expect(v.totalCostValueMinor).toBe(1 * 1000 + 10 * 2000);
    expect(v.totalRetailValueMinor).toBe(1 * 2500 + 10 * 5000);
  });

  it('hides cost prices from cashiers but shows them to administrators', () => {
    const e = makeEnv();
    const { productId } = e.seedVariant({ cost: 777, price: 999 });
    expect(e.inventory.listStock(e.cashier).items[0].costMinor).toBe(0);
    expect(e.inventory.listStock(e.admin).items[0].costMinor).toBe(777);
    expect(e.catalog.getProduct(e.cashier, productId).variants[0].costMinor).toBe(0);
    expect(e.catalog.getProduct(e.admin, productId).variants[0].costMinor).toBe(777);
    expect(() => e.inventory.valuation(e.cashier)).toThrow(/permission/);
  });

  it('filters movements by type and escapes search wildcards', () => {
    const e = makeEnv();
    const { variantId } = e.seedVariant({ name: '100% Cotton', stock: 5 });
    e.sell([{ variantId, quantity: 1 }]);
    expect(e.inventory.listMovements(e.admin, { type: 'sale' }).total).toBe(1);
    expect(e.inventory.listMovements(e.admin, { search: '100%' }).total).toBe(2);
    expect(e.inventory.listMovements(e.admin, { search: '%' }).total).toBe(2); // literal % only matches the '100%' product
    expect(e.inventory.listMovements(e.admin, { search: 'zzz' }).total).toBe(0);
  });
});

describe('suppliers and purchases', () => {
  const setup = () => {
    const e = makeEnv();
    const supplier = e.purchasing.saveSupplier(e.admin, { name: 'Colombo Textiles', contactName: '', phone: '', email: '', address: '', notes: '' });
    const { variantId } = e.seedVariant({ stock: 2, cost: 1000 });
    return { e, supplier, variantId };
  };
  const draft = (e: ReturnType<typeof makeEnv>, supplierId: number, variantId: number, qty = 10, cost = 1200) =>
    e.purchasing.saveDraft(e.admin, { supplierId, supplierRef: 'INV-77', notes: '', purchaseDate: '2026-10-01', items: [{ variantId, quantity: qty, unitCostMinor: cost }] });

  it('does not change stock until the purchase is received', () => {
    const { e, supplier, variantId } = setup();
    const p = draft(e, supplier.id, variantId);
    expect(p.status).toBe('draft');
    expect(p.totalCostMinor).toBe(12_000);
    expect(e.stock(variantId)).toBe(2);
    e.purchasing.receive(e.admin, { id: p.id, updateCosts: false });
    expect(e.stock(variantId)).toBe(12);
  });

  it('receiving writes the ledger entry referencing the purchase, at the purchase cost', () => {
    const { e, supplier, variantId } = setup();
    const p = draft(e, supplier.id, variantId);
    const received = e.purchasing.receive(e.admin, { id: p.id, updateCosts: true });
    expect(received.status).toBe('received');
    expect(received.receivedAt).not.toBeNull();
    const move = e.inventory.listMovements(e.admin, { type: 'purchase_receipt' }).items[0];
    expect(move).toMatchObject({ quantityDelta: 10, unitCostMinor: 1200, refType: 'purchase', refId: p.id, refLabel: p.purchaseNo });
    const cost = e.db.prepare('SELECT cost_minor AS c FROM product_variants WHERE id = ?').get(variantId) as { c: number };
    expect(cost.c).toBe(1200);
  });

  it('leaves the variant cost alone unless asked to update it', () => {
    const { e, supplier, variantId } = setup();
    e.purchasing.receive(e.admin, { id: draft(e, supplier.id, variantId).id, updateCosts: false });
    const cost = e.db.prepare('SELECT cost_minor AS c FROM product_variants WHERE id = ?').get(variantId) as { c: number };
    expect(cost.c).toBe(1000);
  });

  it('cannot be received twice', () => {
    const { e, supplier, variantId } = setup();
    const p = draft(e, supplier.id, variantId);
    e.purchasing.receive(e.admin, { id: p.id, updateCosts: false });
    expect(() => e.purchasing.receive(e.admin, { id: p.id, updateCosts: false })).toThrow(/already been received/);
    expect(e.stock(variantId)).toBe(12);
  });

  it('a received purchase can no longer be edited or have its lines altered', () => {
    const { e, supplier, variantId } = setup();
    const p = draft(e, supplier.id, variantId);
    e.purchasing.receive(e.admin, { id: p.id, updateCosts: false });
    expect(() => e.purchasing.saveDraft(e.admin, { id: p.id, supplierId: supplier.id, supplierRef: '', notes: '', purchaseDate: '2026-10-01', items: [{ variantId, quantity: 99, unitCostMinor: 1 }] })).toThrow(/Only draft/);
    expect(() => e.db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(p.id)).toThrow(/PURCHASE_ALREADY_RECEIVED/);
    expect(() => e.purchasing.cancel(e.admin, p.id)).toThrow(/Only draft/);
  });

  it('drafts can be edited and cancelled without touching stock', () => {
    const { e, supplier, variantId } = setup();
    const p = draft(e, supplier.id, variantId, 10, 1200);
    const edited = e.purchasing.saveDraft(e.admin, { id: p.id, supplierId: supplier.id, supplierRef: 'X', notes: '', purchaseDate: '2026-10-02', items: [{ variantId, quantity: 3, unitCostMinor: 500 }] });
    expect(edited.totalCostMinor).toBe(1500);
    expect(edited.items).toHaveLength(1);
    e.purchasing.cancel(e.admin, p.id);
    expect(e.stock(variantId)).toBe(2);
    expect(() => e.purchasing.receive(e.admin, { id: p.id, updateCosts: false })).toThrow(/already been received or cancelled/);
  });

  it('rejects invalid lines: zero quantity, negative cost, duplicates, empty', () => {
    const { e, supplier, variantId } = setup();
    const base = { supplierId: supplier.id, supplierRef: '', notes: '', purchaseDate: '2026-10-01' };
    expect(() => e.purchasing.saveDraft(e.admin, { ...base, items: [] })).toThrow(/at least one item/);
    expect(() => e.purchasing.saveDraft(e.admin, { ...base, items: [{ variantId, quantity: 0, unitCostMinor: 1 }] })).toThrow(/greater than zero/);
    expect(() => e.purchasing.saveDraft(e.admin, { ...base, items: [{ variantId, quantity: 1, unitCostMinor: -5 }] })).toThrow(/negative/);
    expect(() => e.purchasing.saveDraft(e.admin, { ...base, items: [{ variantId, quantity: 1, unitCostMinor: 1.5 }] })).toThrow(/valid amount/);
    expect(() => e.purchasing.saveDraft(e.admin, { ...base, items: [{ variantId, quantity: 1, unitCostMinor: 1 }, { variantId, quantity: 1, unitCostMinor: 1 }] })).toThrow(/only once/);
    expect(e.count('purchases')).toBe(0);
  });

  it('supplier returns reduce stock, link to the purchase and respect the received quantity', () => {
    const { e, supplier, variantId } = setup();
    const p = draft(e, supplier.id, variantId, 10, 1200);
    e.purchasing.receive(e.admin, { id: p.id, updateCosts: false });
    const r = e.purchasing.createSupplierReturn(e.admin, { supplierId: supplier.id, purchaseId: p.id, reason: 'Faulty zips', returnDate: '2026-10-05', items: [{ variantId, quantity: 4 }] });
    expect(r.totalCostMinor).toBe(4 * 1200);
    expect(e.stock(variantId)).toBe(8);
    expect(e.inventory.listMovements(e.admin, { type: 'supplier_return' }).items[0].refLabel).toBe(r.returnNo);
    expect(() => e.purchasing.createSupplierReturn(e.admin, { supplierId: supplier.id, purchaseId: p.id, reason: 'More', returnDate: '2026-10-06', items: [{ variantId, quantity: 7 }] })).toThrow(/Only 6/);
    expect(e.stock(variantId)).toBe(8);
  });

  it('a failed supplier return changes nothing (insufficient stock rolls the whole return back)', () => {
    const { e, supplier, variantId } = setup();
    const other = e.seedVariant({ stock: 1 });
    const before = { returns: e.count('supplier_returns'), moves: e.count('stock_movements') };
    expect(() =>
      e.purchasing.createSupplierReturn(e.admin, { supplierId: supplier.id, reason: 'Bad batch', returnDate: '2026-10-05', items: [{ variantId, quantity: 1 }, { variantId: other.variantId, quantity: 5 }] }),
    ).toThrow(/Only 1/);
    expect(e.count('supplier_returns')).toBe(before.returns);
    expect(e.count('stock_movements')).toBe(before.moves);
    expect(e.stock(variantId)).toBe(2);
  });

  it('cashiers cannot manage suppliers or purchases', () => {
    const { e, supplier, variantId } = setup();
    expect(() => e.purchasing.listSuppliers(e.cashier)).toThrow(/permission/);
    expect(() => e.purchasing.saveDraft(e.cashier, { supplierId: supplier.id, supplierRef: '', notes: '', purchaseDate: '2026-10-01', items: [{ variantId, quantity: 1, unitCostMinor: 1 }] })).toThrow(/permission/);
    expect(() => e.purchasing.receive(e.cashier, { id: 1, updateCosts: false })).toThrow(/permission/);
  });

  it('rejects duplicate supplier names', () => {
    const { e } = setup();
    expect(() => e.purchasing.saveSupplier(e.admin, { name: 'colombo textiles', contactName: '', phone: '', email: '', address: '', notes: '' })).toThrow(/already exists/);
  });
});
