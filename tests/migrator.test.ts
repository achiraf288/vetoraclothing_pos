import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../electron/db/connection';
import { MigrationError, runMigrations, snapshotDatabase, type Migration } from '../electron/db/migrator';
import { MIGRATIONS } from '../electron/db/migrations';
import { tempDir } from './helpers';

const m1: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);' };
const m2: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY); ALTER TABLE a ADD COLUMN w TEXT;' };

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}

describe('migrations', () => {
  it('applies the shipped migration list to a fresh database and records checksums', () => {
    const db = openDatabase(':memory:');
    const out = runMigrations(db, MIGRATIONS);
    expect(out.applied).toEqual(MIGRATIONS.map((m) => m.version));
    const rows = db.prepare('SELECT version, checksum FROM schema_migrations').all() as Array<{ version: number; checksum: string }>;
    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, [m1, m2]);
    const again = runMigrations(db, [m1, m2]);
    expect(again.applied).toEqual([]);
    expect(again.fromVersion).toBe(2);
  });

  it('snapshots an existing database before upgrading it, and keeps the data', () => {
    const dir = tempDir();
    const file = path.join(dir, 'db.sqlite');
    const backups = path.join(dir, 'backups');
    const db = openDatabase(file);
    runMigrations(db, [m1], backups);
    db.prepare("INSERT INTO a (v) VALUES ('precious')").run();

    const out = runMigrations(db, [m1, m2], backups);
    expect(out.applied).toEqual([2]);
    expect(out.safetyBackup).not.toBeNull();
    expect(path.dirname(out.safetyBackup!)).toBe(backups);
    expect(path.basename(out.safetyBackup!)).toMatch(/^pre-migration-v1-to-v2-.*\.sqlite$/);

    // live DB upgraded, data kept
    expect(tables(db)).toContain('b');
    expect((db.prepare('SELECT v FROM a').get() as { v: string }).v).toBe('precious');

    // the snapshot is a valid, independent database at the OLD schema
    const snap = openDatabase(out.safetyBackup!, { readonly: true });
    expect(tables(snap)).not.toContain('b');
    expect((snap.prepare('SELECT v FROM a').get() as { v: string }).v).toBe('precious');
    snap.close();
    db.close();
  });

  it('does not create a safety backup for a brand-new database', () => {
    const dir = tempDir();
    const db = openDatabase(path.join(dir, 'db.sqlite'));
    const out = runMigrations(db, [m1, m2], path.join(dir, 'backups'));
    expect(out.safetyBackup).toBeNull();
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('rolls back a failing migration completely and leaves earlier data intact', () => {
    const dir = tempDir();
    const backups = path.join(dir, 'backups');
    const db = openDatabase(path.join(dir, 'db.sqlite'));
    runMigrations(db, [m1], backups);
    db.prepare("INSERT INTO a (v) VALUES ('safe')").run();

    const bad: Migration = {
      version: 2,
      name: 'bad',
      sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO table_that_does_not_exist VALUES (1);',
    };
    let error: unknown;
    try {
      runMigrations(db, [m1, bad], backups);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe('MIGRATION_FAILED');
    expect((error as MigrationError).message).toContain('pre-upgrade backup');

    expect(tables(db)).not.toContain('half_done');
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(1);
    expect((db.prepare('SELECT v FROM a').get() as { v: string }).v).toBe('safe');
  });

  it('refuses to run when an already-applied migration was edited', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, [m1]);
    const tampered: Migration = { ...m1, sql: m1.sql + ' -- edited' };
    expect(() => runMigrations(db, [tampered, m2])).toThrow(/modified after it was applied/);
    expect(tables(db)).not.toContain('b');
  });

  it('refuses to open a database created by a newer app version, without touching it', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, [m1, m2]);
    let error: unknown;
    try {
      runMigrations(db, [m1]);
    } catch (e) {
      error = e;
    }
    expect((error as MigrationError).code).toBe('DATABASE_TOO_NEW');
    expect(tables(db)).toContain('b');
  });

  it('rejects a migration list with gaps or wrong numbering', () => {
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, [m1, { ...m2, version: 3 }])).toThrow(/without gaps/);
  });

  it('aborts the upgrade (applies nothing) if the safety backup cannot be written', () => {
    const dir = tempDir();
    const db = openDatabase(path.join(dir, 'db.sqlite'));
    runMigrations(db, [m1], path.join(dir, 'b'));
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    let error: unknown;
    try {
      runMigrations(db, [m1, m2], blocker);
    } catch (e) {
      error = e;
    }
    expect((error as MigrationError).code).toBe('BACKUP_FAILED');
    expect(tables(db)).not.toContain('b');
  });

  it('never overwrites an existing backup file', () => {
    const dir = tempDir();
    const db = openDatabase(':memory:');
    runMigrations(db, [m1]);
    const target = path.join(dir, 'snap.sqlite');
    snapshotDatabase(db, target);
    expect(() => snapshotDatabase(db, target)).toThrow(/overwrite/);
  });
});
