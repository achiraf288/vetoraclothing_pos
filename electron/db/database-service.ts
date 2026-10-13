import * as path from 'node:path';
import { checkIntegrity, openDatabase, type Db } from './connection';
import { MIGRATIONS } from './migrations';
import { runMigrations, type Migration, type MigrationOutcome } from './migrator';

export interface DatabaseHandle {
  db: Db;
  file: string;
  migration: MigrationOutcome;
}

export class DatabaseIntegrityError extends Error {
  constructor(
    public readonly messages: string[],
    public readonly file: string,
  ) {
    super('The database failed its integrity check.');
    this.name = 'DatabaseIntegrityError';
  }
}

/**
 * Opens the database, verifies integrity, and brings the schema up to date.
 * Creates a brand-new database on first launch. Never replaces an existing one.
 */
export function initDatabase(
  dataDir: string,
  backupDir: string,
  migrations: Migration[] = MIGRATIONS,
): DatabaseHandle {
  const file = path.join(dataDir, 'maison-pos.sqlite');
  const db = openDatabase(file);
  try {
    const integrity = checkIntegrity(db, 'quick');
    if (!integrity.ok) throw new DatabaseIntegrityError(integrity.messages, file);
    const migration = runMigrations(db, migrations, backupDir);
    return { db, file, migration };
  } catch (err) {
    db.close();
    throw err;
  }
}
