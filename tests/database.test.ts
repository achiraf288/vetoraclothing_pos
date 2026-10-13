import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkIntegrity, openDatabase } from '../electron/db/connection';
import { initDatabase } from '../electron/db/database-service';
import { SettingsRepo } from '../electron/db/settings-repo';
import { nextDocumentNumber, nextSequence } from '../electron/db/sequence';
import { writeAudit, SYSTEM_ACTOR } from '../electron/db/audit';
import { addProduct, addReturn, addSale, addUser, addVariant, memoryDb, moveStock, stockOf, tempDir } from './helpers';

const REQUIRED_TABLES = [
  'users', 'products', 'product_variants', 'categories', 'suppliers', 'purchases', 'purchase_items',
  'sales', 'sale_items', 'payments', 'returns', 'return_items', 'expenses', 'stock_movements',
  'settings', 'audit_logs', 'schema_migrations',
];

describe('database initialisation', () => {
  it('creates every required table on first launch', () => {
    const dir = tempDir();
    const { db, migration } = initDatabase(path.join(dir, 'data'), path.join(dir, 'backups'));
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of REQUIRED_TABLES) expect(names, `missing table ${t}`).toContain(t);
    expect(migration.fromVersion).toBe(0);
    expect(migration.toVersion).toBe(1);
    expect(migration.safetyBackup).toBeNull();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(checkIntegrity(db).ok).toBe(true);
    db.close();
  });

  it('seeds configuration defaults but no demo business data', () => {
    const db = memoryDb();
    const s = new SettingsRepo(db);
    expect(s.get('currency.code')).toBe('LKR');
    expect(s.getBool('tax.enabled')).toBe(false);
    expect(s.getBool('inventory.allow_negative_stock')).toBe(false);
    for (const t of ['products', 'product_variants', 'sales', 'users', 'stock_movements']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('reopening an existing database keeps its data and does not re-run migrations', () => {
    const dir = tempDir();
    const first = initDatabase(path.join(dir, 'data'), path.join(dir, 'backups'));
    addProduct(first.db, 'KEEP-1', 'Keep me');
    first.db.close();

    const second = initDatabase(path.join(dir, 'data'), path.join(dir, 'backups'));
    expect(second.migration.applied).toEqual([]);
    expect(second.migration.safetyBackup).toBeNull();
    expect((second.db.prepare('SELECT name FROM products').get() as { name: string }).name).toBe('Keep me');
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
    second.db.close();
  });
});

describe('products and variants', () => {
  it('rejects duplicate product SKUs case-insensitively', () => {
    const db = memoryDb();
    addProduct(db, 'TSH-001');
    expect(() => addProduct(db, 'tsh-001')).toThrow(/UNIQUE/);
  });

  it('rejects duplicate variant SKUs and duplicate barcodes, but allows many NULL barcodes', () => {
    const db = memoryDb();
    const p = addProduct(db);
    addVariant(db, p, { sku: 'A', size: 'S' });
    expect(() => addVariant(db, p, { sku: 'a', size: 'M' })).toThrow(/UNIQUE/);
    db.prepare('UPDATE product_variants SET barcode = ? WHERE sku = ?').run('123456', 'A');
    addVariant(db, p, { sku: 'B', size: 'L' });
    expect(() => db.prepare('UPDATE product_variants SET barcode = ? WHERE sku = ?').run('123456', 'B')).toThrow(/UNIQUE/);
  });

  it('rejects the same size+colour twice for one product', () => {
    const db = memoryDb();
    const p = addProduct(db);
    addVariant(db, p, { sku: 'A', size: 'M', colour: 'Black' });
    expect(() => addVariant(db, p, { sku: 'B', size: 'm', colour: 'black' })).toThrow(/UNIQUE/);
  });

  it('rejects invalid (negative) prices and costs', () => {
    const db = memoryDb();
    const p = addProduct(db);
    expect(() => addVariant(db, p, { price: -1 })).toThrow(/CHECK/);
    expect(() => addVariant(db, p, { cost: -5 })).toThrow(/CHECK/);
    expect(() => db.prepare('UPDATE products SET default_price_minor = -1').run()).toThrow(/CHECK/);
  });

  it('rejects fractional money values (integer minor units only)', () => {
    const db = memoryDb();
    const p = addProduct(db);
    expect(() => addVariant(db, p, { price: 1999.5 })).toThrow(/cannot store REAL value in INTEGER column/);
    expect(() => db.prepare('UPDATE products SET default_cost_minor = 10.25').run()).toThrow(/cannot store REAL value in INTEGER column/);
    const id = addVariant(db, p, { price: 1999 });
    const row = db.prepare('SELECT typeof(price_minor) AS t FROM product_variants WHERE id = ?').get(id) as { t: string };
    expect(row.t).toBe('integer');
  });

  it('keeps stock separate per size/colour variant', () => {
    const db = memoryDb();
    const p = addProduct(db);
    const blackM = addVariant(db, p, { sku: 'BM', size: 'M', colour: 'Black', opening: 10 });
    const blackL = addVariant(db, p, { sku: 'BL', size: 'L', colour: 'Black', opening: 4 });
    moveStock(db, blackM, 'adjustment_decrease', -3, { reason: 'Stock count' });
    expect(stockOf(db, blackM)).toBe(7);
    expect(stockOf(db, blackL)).toBe(4);
  });

  it('refuses a variant that starts with non-zero stock (must use the ledger)', () => {
    const db = memoryDb();
    const p = addProduct(db);
    expect(() =>
      db.prepare('INSERT INTO product_variants (product_id, sku, cost_minor, price_minor, stock_qty) VALUES (?, ?, 1, 1, 5)').run(p, 'X'),
    ).toThrow(/STOCK_MUST_START_AT_ZERO/);
  });

  it('enforces foreign keys', () => {
    const db = memoryDb();
    expect(() => db.prepare('INSERT INTO product_variants (product_id, sku, cost_minor, price_minor) VALUES (999, ?, 1, 1)').run('Z')).toThrow(/FOREIGN KEY/);
  });
});

describe('stock ledger', () => {
  it('updates stock from the ledger and records the running balance', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 10 });
    const m = moveStock(db, v, 'adjustment_decrease', -4, { reason: 'Damaged in storage' });
    expect(stockOf(db, v)).toBe(6);
    expect((db.prepare('SELECT balance_after AS b FROM stock_movements WHERE id = ?').get(m) as { b: number }).b).toBe(6);
  });

  it('prevents negative stock by default', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 2 });
    expect(() => moveStock(db, v, 'adjustment_decrease', -3, { reason: 'x' })).toThrow(/INSUFFICIENT_STOCK/);
    expect(stockOf(db, v)).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n).toBe(1);
  });

  it('allows negative stock only when the setting explicitly enables it', () => {
    const db = memoryDb();
    new SettingsRepo(db).set('inventory.allow_negative_stock', '1');
    const v = addVariant(db, addProduct(db), { opening: 1 });
    moveStock(db, v, 'adjustment_decrease', -3, { reason: 'oversold' });
    expect(stockOf(db, v)).toBe(-2);
  });

  it('rejects a direct stock_qty edit that bypasses the ledger', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 5 });
    expect(() => db.prepare('UPDATE product_variants SET stock_qty = 50 WHERE id = ?').run(v)).toThrow(/STOCK_LEDGER_MISMATCH/);
    expect(stockOf(db, v)).toBe(5);
  });

  it('requires a reason for adjustments, damaged and lost stock', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 10 });
    expect(() => moveStock(db, v, 'adjustment_decrease', -1)).toThrow(/CHECK/);
    expect(() => moveStock(db, v, 'damaged', -1, { reason: '   ' })).toThrow(/CHECK/);
    moveStock(db, v, 'lost', -1, { reason: 'Missing after stocktake' });
    expect(stockOf(db, v)).toBe(9);
  });

  it('requires the movement direction to match its type and a source reference for document types', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 10 });
    expect(() => moveStock(db, v, 'damaged', 2, { reason: 'x' })).toThrow(/CHECK/);
    expect(() => moveStock(db, v, 'sale', -1)).toThrow(/CHECK/);
    expect(() => moveStock(db, v, 'purchase_receipt', 5)).toThrow(/CHECK/);
  });

  it('makes the ledger append-only', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 5 });
    const m = moveStock(db, v, 'lost', -1, { reason: 'gone' });
    expect(() => db.prepare('UPDATE stock_movements SET quantity_delta = -2 WHERE id = ?').run(m)).toThrow(/LEDGER_IS_APPEND_ONLY/);
    expect(() => db.prepare('UPDATE stock_movements SET reason = ? WHERE id = ?').run('edited', m)).toThrow(/LEDGER_IS_APPEND_ONLY/);
    expect(() => db.prepare('DELETE FROM stock_movements WHERE id = ?').run(m)).toThrow(/LEDGER_IS_APPEND_ONLY/);
  });

  it('always reconciles: stock_qty equals the ledger sum', () => {
    const db = memoryDb();
    const p = addProduct(db);
    const ids = [addVariant(db, p, { sku: 'a', size: 'S', opening: 7 }), addVariant(db, p, { sku: 'b', size: 'M', opening: 3 })];
    moveStock(db, ids[0], 'lost', -2, { reason: 'x' });
    moveStock(db, ids[1], 'adjustment_increase', 5, { reason: 'found' });
    const bad = db
      .prepare(
        `SELECT v.id FROM product_variants v
         WHERE v.stock_qty <> (SELECT COALESCE(SUM(quantity_delta),0) FROM stock_movements WHERE variant_id = v.id)`,
      )
      .all();
    expect(bad).toEqual([]);
  });
});

describe('sales immutability', () => {
  it('stores sale-time price and cost snapshots that survive later product price changes', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { price: 250000, cost: 100000, opening: 5 });
    const { itemId } = addSale(db, v, 2, { price: 250000, cost: 100000 });
    db.prepare('UPDATE product_variants SET price_minor = 999900, cost_minor = 500000 WHERE id = ?').run(v);
    const item = db.prepare('SELECT unit_price_minor AS p, unit_cost_minor AS c FROM sale_items WHERE id = ?').get(itemId) as { p: number; c: number };
    expect(item).toEqual({ p: 250000, c: 100000 });
  });

  it('rejects inconsistent sale arithmetic at the database level', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 5 });
    expect(() =>
      db.prepare(`INSERT INTO sales (receipt_no, idempotency_key, sale_date, subtotal_minor, total_minor) VALUES ('R1','idem-key-bad-1','2026-10-12', 1000, 900)`).run(),
    ).toThrow(/CHECK/);
    const { saleId } = addSale(db, v, 1);
    expect(() =>
      db.prepare(
        `INSERT INTO sale_items (sale_id, variant_id, product_name, sku, quantity, unit_price_minor, unit_cost_minor, line_net_minor) VALUES (?, ?, 'x','x', 2, 100, 50, 150)`,
      ).run(saleId, v),
    ).toThrow(/CHECK/);
  });

  it('prevents duplicate checkout via the idempotency key', () => {
    const db = memoryDb();
    const ins = () =>
      db.prepare(`INSERT INTO sales (receipt_no, idempotency_key, sale_date, subtotal_minor, total_minor) VALUES (?, 'same-key-12345', '2026-10-12', 100, 100)`);
    ins().run('R-A');
    expect(() => ins().run('R-B')).toThrow(/UNIQUE/);
  });

  it('forbids deleting or editing completed sales, items and payments', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 5 });
    const { saleId, itemId } = addSale(db, v, 1);
    expect(() => db.prepare('DELETE FROM sales WHERE id = ?').run(saleId)).toThrow(/SALES_ARE_IMMUTABLE/);
    expect(() => db.prepare('UPDATE sales SET total_minor = 1 WHERE id = ?').run(saleId)).toThrow(/SALES_ARE_IMMUTABLE/);
    expect(() => db.prepare('UPDATE sale_items SET unit_price_minor = 1 WHERE id = ?').run(itemId)).toThrow(/SALES_ARE_IMMUTABLE/);
    expect(() => db.prepare('DELETE FROM sale_items WHERE id = ?').run(itemId)).toThrow(/SALES_ARE_IMMUTABLE/);
  });

  it('allows cancelling a sale (with reason) but never un-cancelling it', () => {
    const db = memoryDb();
    const uid = addUser(db);
    const v = addVariant(db, addProduct(db), { opening: 5 });
    const { saleId } = addSale(db, v, 1);
    expect(() => db.prepare(`UPDATE sales SET status='cancelled', cancelled_at=datetime('now') WHERE id = ?`).run(saleId)).toThrow(/CHECK/);
    db.prepare(`UPDATE sales SET status='cancelled', cancelled_at=datetime('now'), cancelled_by=?, cancel_reason='Wrong item' WHERE id = ?`).run(uid, saleId);
    expect(() => db.prepare(`UPDATE sales SET status='completed', cancelled_at=NULL WHERE id = ?`).run(saleId)).toThrow(/SALES_ARE_IMMUTABLE/);
  });
});

describe('returns', () => {
  function setup() {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db), { opening: 10 });
    const sale = addSale(db, v, 3, { price: 100000 }); // net 300000
    return { db, v, ...sale };
  }
  const insertItem = (db: ReturnType<typeof memoryDb>, returnId: number, itemId: number, qty: number, refund: number, condition = 'resalable', restocked = 0) =>
    db.prepare('INSERT INTO return_items (return_id, sale_item_id, quantity, refund_minor, condition, restocked) VALUES (?,?,?,?,?,?)').run(returnId, itemId, qty, refund, condition, restocked);

  it('allows a partial return and blocks exceeding the unreturned quantity across returns', () => {
    const { db, saleId, itemId } = setup();
    insertItem(db, addReturn(db, saleId), itemId, 2, 200000);
    expect(() => insertItem(db, addReturn(db, saleId), itemId, 2, 100000)).toThrow(/RETURN_EXCEEDS_SOLD_QUANTITY/);
    insertItem(db, addReturn(db, saleId), itemId, 1, 100000);
  });

  it('blocks refunding more than the line was worth', () => {
    const { db, saleId, itemId } = setup();
    expect(() => insertItem(db, addReturn(db, saleId), itemId, 1, 300001)).toThrow(/REFUND_EXCEEDS_LINE_TOTAL/);
  });

  it('blocks returning an item that belongs to a different sale', () => {
    const { db, v, itemId } = setup();
    const other = addSale(db, v, 1);
    expect(() => insertItem(db, addReturn(db, other.saleId), itemId, 1, 1000)).toThrow(/RETURN_ITEM_NOT_IN_SALE/);
  });

  it('only allows restocking items confirmed resalable', () => {
    const { db, saleId, itemId } = setup();
    expect(() => insertItem(db, addReturn(db, saleId), itemId, 1, 1000, 'damaged', 1)).toThrow(/CHECK/);
    insertItem(db, addReturn(db, saleId), itemId, 1, 1000, 'damaged', 0);
  });

  it('never deletes or edits a return', () => {
    const { db, saleId } = setup();
    const r = addReturn(db, saleId);
    expect(() => db.prepare('DELETE FROM returns WHERE id = ?').run(r)).toThrow(/RETURNS_ARE_IMMUTABLE/);
    expect(() => db.prepare("UPDATE returns SET reason = 'x' WHERE id = ?").run(r)).toThrow(/RETURNS_ARE_IMMUTABLE/);
  });
});

describe('purchases', () => {
  it('locks received purchase lines', () => {
    const db = memoryDb();
    const v = addVariant(db, addProduct(db));
    const supplier = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('Colombo Textiles')").run().lastInsertRowid);
    const pid = Number(db.prepare("INSERT INTO purchases (purchase_no, supplier_id, purchase_date) VALUES ('PO-1', ?, '2026-10-12')").run(supplier).lastInsertRowid);
    const line = Number(db.prepare('INSERT INTO purchase_items (purchase_id, variant_id, quantity, unit_cost_minor, line_total_minor) VALUES (?,?,?,?,?)').run(pid, v, 5, 1000, 5000).lastInsertRowid);
    db.prepare("UPDATE purchase_items SET quantity = 6, line_total_minor = 6000 WHERE id = ?").run(line); // draft: editable
    db.prepare("UPDATE purchases SET status='received', received_at=datetime('now') WHERE id = ?").run(pid);
    expect(() => db.prepare('UPDATE purchase_items SET quantity = 9, line_total_minor = 9000 WHERE id = ?').run(line)).toThrow(/PURCHASE_ALREADY_RECEIVED/);
    expect(() => db.prepare('DELETE FROM purchase_items WHERE id = ?').run(line)).toThrow(/PURCHASE_ALREADY_RECEIVED/);
  });
});

describe('expenses, audit and sequences', () => {
  it('rejects zero/negative expense amounts and malformed dates', () => {
    const db = memoryDb();
    const cat = (db.prepare("SELECT id FROM expense_categories WHERE name='Rent'").get() as { id: number }).id;
    const ins = (date: string, amount: number) =>
      db.prepare('INSERT INTO expenses (category_id, expense_date, amount_minor) VALUES (?,?,?)').run(cat, date, amount);
    expect(() => ins('2026-10-12', 0)).toThrow(/CHECK/);
    expect(() => ins('2026-10-12', -5)).toThrow(/CHECK/);
    expect(() => ins('12/10/2026', 100)).toThrow(/CHECK/);
    ins('2026-10-12', 15000000);
  });

  it('makes the audit log append-only and redacts credentials', () => {
    const db = memoryDb();
    writeAudit(db, SYSTEM_ACTOR, 'user.create', 'user', 1, { username: 'sam', password: 'hunter2', nested: { passwordHash: 'abc' } });
    const row = db.prepare('SELECT id, details FROM audit_logs').get() as { id: number; details: string };
    expect(row.details).not.toContain('hunter2');
    expect(row.details).not.toContain('abc');
    expect(JSON.parse(row.details).username).toBe('sam');
    expect(() => db.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').run('x', row.id)).toThrow(/AUDIT_LOG_IS_APPEND_ONLY/);
    expect(() => db.prepare('DELETE FROM audit_logs WHERE id = ?').run(row.id)).toThrow(/AUDIT_LOG_IS_APPEND_ONLY/);
  });

  it('issues unique, sequential document numbers per business day and rolls back with the transaction', () => {
    const db = memoryDb();
    const day = new Date(2026, 9, 12, 10, 0, 0);
    expect(nextDocumentNumber(db, 'INV', day)).toBe('INV-20261012-0001');
    expect(nextDocumentNumber(db, 'INV', day)).toBe('INV-20261012-0002');
    expect(nextDocumentNumber(db, 'INV', new Date(2026, 9, 13))).toBe('INV-20261013-0001');
    expect(() =>
      db.transaction(() => {
        nextSequence(db, 'rollback-test');
        throw new Error('boom');
      })(),
    ).toThrow('boom');
    expect(nextSequence(db, 'rollback-test')).toBe(1);
  });
});

describe('connection hardening', () => {
  it('refuses to open a read-only handle for writes', () => {
    const dir = tempDir();
    const file = path.join(dir, 'x.sqlite');
    openDatabase(file).close();
    const ro = openDatabase(file, { readonly: true });
    expect(() => ro.exec('CREATE TABLE t(a)')).toThrow();
    ro.close();
  });
});
