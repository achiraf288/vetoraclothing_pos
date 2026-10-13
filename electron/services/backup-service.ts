import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkIntegrity, openDatabase, type Db } from '../db/connection';
import { initDatabase, type DatabaseHandle } from '../db/database-service';
import { writeAudit } from '../db/audit';
import { MIGRATIONS } from '../db/migrations';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type { BackupInfo, BackupValidation, RestoreResult } from '../shared/api';
import { assertCan, type Actor } from './permissions';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const REQUIRED_TABLES = [
  'users', 'products', 'product_variants', 'categories', 'suppliers', 'purchases', 'purchase_items',
  'sales', 'sale_items', 'payments', 'returns', 'return_items', 'expenses', 'stock_movements',
  'settings', 'audit_logs', 'schema_migrations',
];

export function stamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

type Kind = 'manual' | 'auto' | 'safety';

function kindOf(name: string): BackupInfo['kind'] {
  if (/^(vetora-pos|maison-pos)-manual-/.test(name)) return 'manual';
  if (/^(vetora-pos|maison-pos)-auto-/.test(name)) return 'auto';
  if (/^(vetora-pos|maison-pos)-safety-/.test(name)) return 'safety';
  if (name.startsWith('pre-migration-')) return 'pre-migration';
  return 'other';
}

/**
 * Validates a candidate backup file WITHOUT modifying it: real SQLite header,
 * opens read-only, passes SQLite's integrity check, has every required table,
 * and was written by this or an older schema version.
 */
export function validateBackupFile(file: string): BackupValidation {
  const problems: string[] = [];
  let sizeBytes = 0;
  let schemaVersion: number | null = null;
  let createdAt: string | null = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, problems: ['That is not a file.'], schemaVersion, createdAt, sizeBytes };
    sizeBytes = stat.size;
    createdAt = stat.mtime.toISOString();
    if (stat.size < 4096) problems.push('The file is too small to be a Vetora POS database.');
  } catch {
    return { ok: false, problems: ['The file could not be read.'], schemaVersion, createdAt, sizeBytes };
  }

  try {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (!header.equals(SQLITE_HEADER)) problems.push('This is not a SQLite database file.');
  } catch {
    problems.push('The file could not be read.');
  }
  if (problems.length) return { ok: false, problems, schemaVersion, createdAt, sizeBytes };

  let db: Db | null = null;
  try {
    db = openDatabase(file, { readonly: true });
    const integrity = checkIntegrity(db, 'full');
    if (!integrity.ok) problems.push(`Integrity check failed: ${integrity.messages.slice(0, 3).join('; ')}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) problems.push(`Not a Vetora POS backup (missing: ${missing.slice(0, 4).join(', ')}).`);
    else {
      schemaVersion = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v;
      const versionTables: Record<number,string[]>={2:['orders','order_items','courier_settlements'],3:['discount_codes']};
      const missingVersioned=Object.entries(versionTables).filter(([v])=>schemaVersion!>=Number(v)).flatMap(([,names])=>names.filter(n=>!tables.has(n)));
      if(missingVersioned.length)problems.push(`This backup is missing Vetora POS tables: ${missingVersioned.join(', ')}.`);
      if (schemaVersion < 1) problems.push('The backup has no schema version.');
      if (schemaVersion > MIGRATIONS.length) {
        problems.push(`This backup was made by a newer version of Vetora POS (schema ${schemaVersion}); this app understands up to ${MIGRATIONS.length}.`);
      }
    }
  } catch (err) {
    problems.push(`The file could not be opened as a database (${(err as Error).message}).`);
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
  return { ok: problems.length === 0, problems, schemaVersion, createdAt, sizeBytes };
}

export class BackupService {
  constructor(
    private readonly getDb: () => Db,
    private readonly defaultDir: string,
  ) {}

  private get settings(): SettingsRepo {
    return new SettingsRepo(this.getDb());
  }

  directory(): string {
    const configured = this.settings.get('backup.directory');
    return configured && configured.trim() ? configured : this.defaultDir;
  }

  /**
   * Consistent snapshot via SQLite's VACUUM INTO — correct even while the
   * database is in WAL mode and being written. (A raw file copy would miss
   * data still sitting in the -wal file.) The result is validated before it
   * is reported as successful; an invalid file is removed.
   */
  createBackup(kind: Kind = 'manual', actor?: Actor, now: Date = new Date()): BackupInfo {
    if (actor) assertCan(actor, 'backup.manage');
    const dir = this.directory();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      throw new AppError('VALIDATION', 'The backup folder cannot be created. Choose a different folder in Settings.');
    }
    let file = path.join(dir, `vetora-pos-${kind}-${stamp(now)}.sqlite`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `vetora-pos-${kind}-${stamp(now)}-${n}.sqlite`);

    try {
      this.getDb().prepare('VACUUM INTO ?').run(file);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw new AppError('INTERNAL', `The backup could not be written: ${(err as Error).message}`);
    }
    const check = validateBackupFile(file);
    if (!check.ok) {
      fs.rmSync(file, { force: true });
      throw new AppError('INTERNAL', 'The backup file failed validation and was discarded.');
    }
    if (actor) writeAudit(this.getDb(), actor, 'backup.create', 'backup', path.basename(file), { kind });
    return this.describe(file);
  }

  private describe(file: string): BackupInfo {
    const st = fs.statSync(file);
    const name = path.basename(file);
    return { file, name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), kind: kindOf(name) };
  }

  list(actor?: Actor): BackupInfo[] {
    if (actor) assertCan(actor, 'backup.manage');
    const dirs = new Set([this.directory(), this.defaultDir]);
    const out: BackupInfo[] = [];
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.sqlite')) continue;
        try {
          out.push(this.describe(path.join(dir, n)));
        } catch {
          /* vanished */
        }
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Keeps only the newest `keep` AUTOMATIC backups. Manual and safety backups are never pruned. */
  pruneAuto(keep: number): number {
    const autos = this.list().filter((b) => b.kind === 'auto');
    let removed = 0;
    for (const b of autos.slice(Math.max(keep, 1))) {
      try {
        fs.unlinkSync(b.file);
        removed++;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** Called periodically; creates an automatic backup when enabled and due. */
  runScheduledIfDue(now: Date = new Date()): BackupInfo | null {
    const s = this.settings;
    if (!s.getBool('backup.auto_enabled')) return null;
    const hours = s.getInt('backup.interval_hours', 24);
    const newest = this.list().find((b) => b.kind === 'auto');
    if (newest && now.getTime() - new Date(newest.createdAt).getTime() < hours * 3_600_000) return null;
    const info = this.createBackup('auto', undefined, now);
    this.pruneAuto(s.getInt('backup.keep_count', 14));
    return info;
  }
}

/**
 * Restores `sourceFile` over the live database.
 *
 * Order of operations (each step is reversible until the last):
 *  1. validate the source (integrity, schema, not the live file itself);
 *  2. take a safety backup of the CURRENT database;
 *  3. copy the source next to the live file and validate the copy;
 *  4. close the live connection, move the live file aside, move the copy in;
 *  5. reopen (running any pending migrations); on failure put the old file back.
 * Returns the new database handle; the caller must switch to it.
 */
export function restoreDatabase(opts: {
  live: DatabaseHandle;
  dataDir: string;
  backupDir: string;
  sourceFile: string;
  backups: BackupService;
  actor: { userId: number | null; username: string };
}): { handle: DatabaseHandle; result: RestoreResult } {
  const { live, dataDir, backupDir, sourceFile, backups, actor } = opts;
  const liveFile = live.file;
  if (path.resolve(sourceFile) === path.resolve(liveFile)) {
    throw new AppError('VALIDATION', 'That is the live database, not a backup.');
  }
  const validation = validateBackupFile(sourceFile);
  if (!validation.ok) throw new AppError('VALIDATION', `This backup cannot be restored: ${validation.problems[0]}`);

  const safety = backups.createBackup('safety');
  const tmp = `${liveFile}.restore-tmp`;
  const aside = `${liveFile}.pre-restore`;
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(sourceFile, tmp);
  const copyCheck = validateBackupFile(tmp);
  if (!copyCheck.ok) {
    fs.rmSync(tmp, { force: true });
    throw new AppError('INTERNAL', 'The copied backup failed validation. Nothing was changed.');
  }

  const removeSidecars = (): void => {
    for (const ext of ['-wal', '-shm']) fs.rmSync(liveFile + ext, { force: true });
  };

  live.db.close();
  try {
    fs.rmSync(aside, { force: true });
    fs.renameSync(liveFile, aside);
    removeSidecars();
    fs.renameSync(tmp, liveFile);
  } catch (err) {
    // Could not swap files: put everything back and reopen the original.
    try {
      if (!fs.existsSync(liveFile) && fs.existsSync(aside)) fs.renameSync(aside, liveFile);
    } catch {
      /* best effort */
    }
    fs.rmSync(tmp, { force: true });
    const handle = initDatabase(dataDir, backupDir);
    Object.assign(live, handle);
    throw new AppError('INTERNAL', `The restore could not be completed and the original data was kept: ${(err as Error).message}`);
  }

  let handle: DatabaseHandle;
  try {
    handle = initDatabase(dataDir, backupDir);
  } catch (err) {
    // The restored file would not open or migrate: roll back to the original.
    fs.rmSync(liveFile, { force: true });
    removeSidecars();
    fs.renameSync(aside, liveFile);
    const original = initDatabase(dataDir, backupDir);
    Object.assign(live, original);
    throw new AppError('INTERNAL', `The backup could not be opened, so the original data was kept: ${(err as Error).message}`);
  }
  fs.rmSync(aside, { force: true });
  writeAudit(handle.db, { userId: null, username: actor.username }, 'backup.restore', 'backup', path.basename(sourceFile), {
    safetyBackup: path.basename(safety.file),
  });
  return { handle, result: { safetyBackup: safety.file, restoredFrom: sourceFile } };
}
