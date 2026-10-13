import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type Db } from '../electron/db/connection';
import { MIGRATIONS } from '../electron/db/migrations';
import { runMigrations } from '../electron/db/migrator';

export function tempDir(prefix = 'maison-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memoryDb(): Db {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS);
  return db;
}

export function addUser(db: Db, username = 'admin', role: 'admin' | 'cashier' = 'admin'): number {
  return Number(
    db
      .prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(username, username, role, 'scrypt$placeholder-hash-for-tests-only').lastInsertRowid,
  );
}

export interface VariantSeed {
  sku?: string;
  size?: string;
  colour?: string;
  cost?: number;
  price?: number;
  opening?: number;
}

export function addProduct(db: Db, sku = 'TSH-001', name = 'Linen T-shirt'): number {
  return Number(db.prepare('INSERT INTO products (sku, name) VALUES (?, ?)').run(sku, name).lastInsertRowid);
}

export function addVariant(db: Db, productId: number, v: VariantSeed = {}): number {
  const id = Number(
    db
      .prepare(
        'INSERT INTO product_variants (product_id, sku, size, colour, cost_minor, price_minor) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(productId, v.sku ?? `V-${Math.random().toString(36).slice(2, 8)}`, v.size ?? 'M', v.colour ?? 'Black', v.cost ?? 100000, v.price ?? 250000)
      .lastInsertRowid,
  );
  if (v.opening) moveStock(db, id, 'opening_stock', v.opening, { ref_type: 'manual' });
  return id;
}

export function moveStock(
  db: Db,
  variantId: number,
  type: string,
  qty: number,
  extra: { reason?: string; ref_type?: string; ref_id?: number } = {},
): number {
  return Number(
    db
      .prepare(
        'INSERT INTO stock_movements (variant_id, movement_type, quantity_delta, reason, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(variantId, type, qty, extra.reason ?? null, extra.ref_type ?? null, extra.ref_id ?? null).lastInsertRowid,
  );
}

export function stockOf(db: Db, variantId: number): number {
  return (db.prepare('SELECT stock_qty AS q FROM product_variants WHERE id = ?').get(variantId) as { q: number }).q;
}

let saleCounter = 0;
/** Inserts a consistent completed sale with one line. Returns ids. */
export function addSale(
  db: Db,
  variantId: number,
  qty: number,
  opts: { price?: number; cost?: number; lineDiscount?: number } = {},
): { saleId: number; itemId: number; lineNet: number } {
  saleCounter += 1;
  const price = opts.price ?? 250000;
  const cost = opts.cost ?? 100000;
  const lineDiscount = opts.lineDiscount ?? 0;
  const subtotal = qty * price;
  const total = subtotal - lineDiscount;
  const saleId = Number(
    db
      .prepare(
        `INSERT INTO sales (receipt_no, idempotency_key, sale_date, subtotal_minor, line_discount_total_minor, total_minor)
         VALUES (?, ?, '2026-10-12', ?, ?, ?)`,
      )
      .run(`INV-TEST-${saleCounter}`, `idem-key-${saleCounter}-${Date.now()}`, subtotal, lineDiscount, total).lastInsertRowid,
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO sale_items (sale_id, variant_id, product_name, sku, quantity, unit_price_minor, unit_cost_minor, line_discount_minor, line_net_minor)
         VALUES (?, ?, 'Item', 'SKU', ?, ?, ?, ?, ?)`,
      )
      .run(saleId, variantId, qty, price, cost, lineDiscount, total).lastInsertRowid,
  );
  return { saleId, itemId, lineNet: total };
}

export function addReturn(db: Db, saleId: number, no = `RET-${Math.random().toString(36).slice(2, 8)}`): number {
  return Number(
    db
      .prepare(
        `INSERT INTO returns (return_no, sale_id, return_date, refund_amount_minor, reason, refund_method_code)
         VALUES (?, ?, '2026-10-12', 0, 'Customer changed mind', NULL)`,
      )
      .run(no, saleId).lastInsertRowid,
  );
}
