import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, toPublicError } from '../electron/main/errors';
import { createLogger } from '../electron/main/logger';
import { addProduct, addVariant, memoryDb, moveStock, tempDir } from './helpers';

describe('error mapping', () => {
  it('passes AppError details through', () => {
    const { error, unexpected } = toPublicError(new AppError('FORBIDDEN', 'Admins only', 'role'));
    expect(error).toEqual({ code: 'FORBIDDEN', message: 'Admins only', field: 'role' });
    expect(unexpected).toBe(false);
  });

  it('maps real database errors to friendly codes', () => {
    const db = memoryDb();
    const p = addProduct(db, 'DUP-1');
    let dup: unknown;
    try { addProduct(db, 'dup-1'); } catch (e) { dup = e; }
    expect(toPublicError(dup).error.code).toBe('DUPLICATE');
    expect(toPublicError(dup).error.field).toBe('sku');

    const v = addVariant(db, p, { opening: 1 });
    let stock: unknown;
    try { moveStock(db, v, 'adjustment_decrease', -5, { reason: 'x' }); } catch (e) { stock = e; }
    expect(toPublicError(stock).error.code).toBe('INSUFFICIENT_STOCK');

    let fk: unknown;
    try { db.prepare('INSERT INTO product_variants (product_id, sku, cost_minor, price_minor) VALUES (999,?,1,1)').run('F'); } catch (e) { fk = e; }
    expect(toPublicError(fk).error.code).toBe('CONFLICT');
  });

  it('hides internal details of unexpected errors', () => {
    const { error, unexpected } = toPublicError(new Error('ENOENT: /Users/achira/secret/path.db'));
    expect(unexpected).toBe(true);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).not.toContain('/Users');
  });
});

describe('logger', () => {
  it('writes entries and redacts credentials', () => {
    const dir = tempDir();
    const log = createLogger(dir);
    log.info('login attempt', { username: 'sam', password: 'hunter2', passwordHash: 'scrypt$abc' });
    log.error('failed', new Error('boom'));
    const text = fs.readFileSync(path.join(dir, 'maison-pos.log'), 'utf8');
    expect(text).toContain('login attempt');
    expect(text).toContain('sam');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('scrypt$abc');
    expect(text).toContain('boom');
  });

  it('never throws even if the log location is unusable', () => {
    const dir = tempDir();
    const log = createLogger(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => log.info('still fine')).not.toThrow();
  });
});
