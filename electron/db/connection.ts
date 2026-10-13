import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
}

/**
 * Opens (creating if absent) the SQLite database and applies the mandatory
 * pragmas. This function never deletes or truncates an existing file.
 */
export function openDatabase(file: string, options: OpenOptions = {}): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file, { readonly: options.readonly ?? false });

  if (!options.readonly) {
    // WAL gives crash-safe, concurrent-reader-friendly writes. In-memory
    // databases ignore it, which is fine.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');

  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    db.close();
    throw new Error('SQLite foreign key enforcement could not be enabled');
  }
  return db;
}

export interface IntegrityResult {
  ok: boolean;
  messages: string[];
}

/** `quick` is cheap enough for every startup; use the full check on demand. */
export function checkIntegrity(db: Db, mode: 'quick' | 'full' = 'quick'): IntegrityResult {
  const pragma = mode === 'quick' ? 'quick_check' : 'integrity_check';
  const rows = db.pragma(pragma) as Array<Record<string, string>>;
  const messages = rows.map((r) => String(Object.values(r)[0]));
  const ok = messages.length === 1 && messages[0] === 'ok';

  const fkViolations = db.pragma('foreign_key_check') as unknown[];
  if (fkViolations.length > 0) {
    return { ok: false, messages: [...messages, `${fkViolations.length} foreign key violation(s)`] };
  }
  return { ok, messages };
}
