import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

describe('native SQLite', () => {
  it('loads better-sqlite3 and enforces foreign keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.exec('create table a(id integer primary key); create table b(a_id integer references a(id));');
    expect(() => db.prepare('insert into b(a_id) values (?)').run(99)).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
