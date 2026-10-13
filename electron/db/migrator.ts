import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Db } from './connection';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationOutcome {
  fromVersion: number;
  toVersion: number;
  applied: number[];
  safetyBackup: string | null;
}

export class MigrationError extends Error {
  constructor(
    public readonly code:
      | 'DATABASE_TOO_NEW'
      | 'CHECKSUM_MISMATCH'
      | 'MIGRATION_FAILED'
      | 'INVALID_MIGRATION_LIST'
      | 'BACKUP_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

function validateList(migrations: Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        'INVALID_MIGRATION_LIST',
        `Migrations must be numbered 1..n without gaps (found version ${m.version} at position ${i + 1}).`,
      );
    }
  });
}

function ensureTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

export function currentVersion(db: Db): number {
  ensureTable(db);
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
  return row.v;
}

function timestampForFilename(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Creates a consistent snapshot using VACUUM INTO (WAL-safe, no raw file copy).
 * The target path must not already exist.
 */
export function snapshotDatabase(db: Db, targetFile: string): void {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  if (fs.existsSync(targetFile)) {
    throw new MigrationError('BACKUP_FAILED', 'Refusing to overwrite an existing backup file.');
  }
  db.prepare('VACUUM INTO ?').run(targetFile);
}

/**
 * Applies pending migrations, each in its own transaction.
 *
 * Safety rules:
 *  - never drops or recreates an existing database;
 *  - refuses to run against a database created by a newer app version;
 *  - refuses to run if an already-applied migration has been edited;
 *  - when upgrading a database that already has data, takes a snapshot first
 *    (restore it manually if the upgrade ever misbehaves).
 */
export function runMigrations(db: Db, migrations: Migration[], backupDir?: string): MigrationOutcome {
  validateList(migrations);
  ensureTable(db);

  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string; checksum: string }>;

  const latestKnown = migrations.length;
  const fromVersion = applied.length ? applied[applied.length - 1].version : 0;

  if (fromVersion > latestKnown) {
    throw new MigrationError(
      'DATABASE_TOO_NEW',
      `This database is at schema version ${fromVersion} but this app only understands up to ${latestKnown}. ` +
        'Install the newer version of Vetora POS; the database has not been modified.',
    );
  }

  for (const row of applied) {
    const known = migrations[row.version - 1];
    if (checksum(known.sql) !== row.checksum) {
      throw new MigrationError(
        'CHECKSUM_MISMATCH',
        `Migration ${row.version} (${row.name}) was modified after it was applied. The database has not been changed.`,
      );
    }
  }

  const pending = migrations.filter((m) => m.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], safetyBackup: null };
  }

  let safetyBackup: string | null = null;
  if (fromVersion > 0 && backupDir) {
    const file = path.join(
      backupDir,
      `pre-migration-v${fromVersion}-to-v${latestKnown}-${timestampForFilename()}.sqlite`,
    );
    try {
      snapshotDatabase(db, file);
      safetyBackup = file;
    } catch (err) {
      throw new MigrationError(
        'BACKUP_FAILED',
        `Could not create the pre-upgrade safety backup, so the upgrade was not started: ${(err as Error).message}`,
      );
    }
  }

  const appliedNow: number[] = [];
  for (const m of pending) {
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          checksum(m.sql),
        );
      })();
      appliedNow.push(m.version);
    } catch (err) {
      throw new MigrationError(
        'MIGRATION_FAILED',
        `Migration ${m.version} (${m.name}) failed and was rolled back: ${(err as Error).message}` +
          (safetyBackup ? ` A pre-upgrade backup is at ${safetyBackup}.` : ''),
      );
    }
  }

  return { fromVersion, toVersion: latestKnown, applied: appliedNow, safetyBackup };
}
