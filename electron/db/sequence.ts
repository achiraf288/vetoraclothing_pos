import type { Db } from './connection';

/**
 * Atomically increments and returns a named counter. Call inside the same
 * transaction as the record that uses the number so a rollback also rolls the
 * counter back (no gaps from failed attempts).
 */
export function nextSequence(db: Db, name: string): number {
  const row = db
    .prepare(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(name) as { value: number };
  return row.value;
}

/** Local business date (YYYY-MM-DD) in the machine's timezone. */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** e.g. INV-20261012-0007; the counter resets per local business day. */
export function nextDocumentNumber(db: Db, prefix: string, d: Date = new Date()): string {
  const date = localDate(d).replace(/-/g, '');
  const n = nextSequence(db, `${prefix}:${date}`);
  return `${prefix}-${date}-${String(n).padStart(4, '0')}`;
}
