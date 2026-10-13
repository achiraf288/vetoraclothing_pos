import * as crypto from 'node:crypto';
import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { AppError } from '../main/errors';
import type { AuthStatus, Role, SessionDto, UserDto } from '../shared/api';
import { assertCan, permissionsFor, type Actor } from './permissions';
import { text } from './validate';

/**
 * Local authentication for a single-store, offline installation.
 *
 * Passwords are hashed with scrypt (memory-hard, built into Node — no native
 * dependency) using a unique random salt per user. Plaintext passwords are
 * never stored or logged. Accounts lock for a few minutes after repeated
 * failures. The signed-in user lives only in the main process; the renderer
 * holds no credentials and cannot choose its own role.
 *
 * Limitations (documented in the README): this protects against casual
 * misuse inside the app, not against someone with file-system access to the
 * computer — they can copy or read the SQLite file directly.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_FAILED = 5;
const LOCK_MINUTES = 5;
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function checkPasswordStrength(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('VALIDATION', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 'password');
  }
  if (password.length > 200) throw new AppError('VALIDATION', 'Password is too long.', 'password');
  if (/^\s|\s$/.test(password)) throw new AppError('VALIDATION', 'Password cannot start or end with a space.', 'password');
  return password;
}

function checkUsername(username: unknown): string {
  const v = text(username, 'Username', 40, true);
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(v)) {
    throw new AppError('VALIDATION', 'Username may use letters, numbers, dots, dashes and underscores (3–40 characters).', 'username');
  }
  return v;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  is_active: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

const toDto = (u: UserRow): UserDto => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  role: u.role,
  isActive: u.is_active === 1,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

const GENERIC_LOGIN_ERROR = 'Incorrect username or password.';

export class AuthService {
  private sessionUserId: number | null = null;

  constructor(private readonly db: Db) {}

  // ───────────── session ─────────────
  private userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  needsSetup(): boolean {
    return this.userCount() === 0;
  }

  private toSession(u: UserRow): SessionDto {
    return {
      user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role },
      permissions: permissionsFor(u.role),
    };
  }

  status(): AuthStatus {
    return { needsSetup: this.needsSetup(), session: this.currentSession() };
  }

  currentSession(): SessionDto | null {
    const u = this.currentUserRow();
    return u ? this.toSession(u) : null;
  }

  private currentUserRow(): UserRow | null {
    if (this.sessionUserId === null) return null;
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(this.sessionUserId) as UserRow | undefined;
    // A deactivated user is signed out immediately, and role changes apply at once.
    if (!u || u.is_active !== 1) {
      this.sessionUserId = null;
      return null;
    }
    return u;
  }

  /** The signed-in user, re-read from the database on every call. */
  requireActor(): Actor {
    const u = this.currentUserRow();
    if (!u) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    return { userId: u.id, username: u.username, role: u.role };
  }

  logout(): void {
    const u = this.currentUserRow();
    if (u) writeAudit(this.db, { userId: u.id, username: u.username }, 'auth.logout', 'user', u.id);
    this.sessionUserId = null;
  }

  // ───────────── setup & login ─────────────
  /** Creates the first administrator. Only possible while no users exist. */
  setupAdmin(req: { username: string; displayName: string; password: string }): SessionDto {
    const username = checkUsername(req.username);
    const displayName = text(req.displayName, 'Name', 80, true);
    const password = checkPasswordStrength(req.password);
    const hash = hashPassword(password);

    const id = this.db.transaction((): number => {
      // Checked inside the transaction so two racing calls cannot both succeed.
      if (this.userCount() > 0) throw new AppError('CONFLICT', 'Setup has already been completed.');
      const newId = Number(
        this.db
          .prepare(`INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, 'admin', ?)`)
          .run(username, displayName, hash).lastInsertRowid,
      );
      writeAudit(this.db, { userId: newId, username }, 'auth.setup_admin', 'user', newId);
      return newId;
    })();
    return this.startSession(id);
  }

  login(req: { username: string; password: string }): SessionDto {
    const username = typeof req.username === 'string' ? req.username.trim() : '';
    const u = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;

    if (!u) {
      // Burn comparable time so unknown usernames are not distinguishable by speed.
      verifyPassword(String(req.password ?? ''), hashPasswordCached());
      throw new AppError('UNAUTHENTICATED', GENERIC_LOGIN_ERROR);
    }
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      throw new AppError('UNAUTHENTICATED', 'Too many failed attempts. Try again in a few minutes.');
    }

    const ok = verifyPassword(String(req.password ?? ''), u.password_hash);
    if (!ok || u.is_active !== 1) {
      this.recordFailure(u);
      throw new AppError('UNAUTHENTICATED', GENERIC_LOGIN_ERROR);
    }
    this.db
      .prepare(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL,
                last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      )
      .run(u.id);
    writeAudit(this.db, { userId: u.id, username: u.username }, 'auth.login', 'user', u.id);
    return this.startSession(u.id);
  }

  private recordFailure(u: UserRow): void {
    const attempts = u.failed_attempts + 1;
    const lock = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
    this.db
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(lock ? 0 : attempts, lock, u.id);
    writeAudit(this.db, { userId: null, username: u.username }, lock ? 'auth.locked' : 'auth.login_failed', 'user', u.id);
  }

  private startSession(userId: number): SessionDto {
    this.sessionUserId = userId;
    return this.toSession(this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow);
  }

  /**
   * Re-verifies an administrator's credentials for a one-off authorisation
   * (e.g. a cashier asking a manager to approve a sale cancellation).
   */
  verifyAdminOverride(username: string, password: string): { id: number; username: string } {
    const u = this.db.prepare('SELECT * FROM users WHERE username = ?').get((username ?? '').trim()) as UserRow | undefined;
    if (u && u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      throw new AppError('FORBIDDEN', 'That account is temporarily locked.');
    }
    if (!u || u.role !== 'admin' || u.is_active !== 1 || !verifyPassword(String(password ?? ''), u.password_hash)) {
      if (u) this.recordFailure(u);
      throw new AppError('FORBIDDEN', 'Administrator authorisation failed.');
    }
    return { id: u.id, username: u.username };
  }

  changePassword(actor: Actor, req: { currentPassword: string; newPassword: string }): void {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(actor.userId) as UserRow | undefined;
    if (!u || !verifyPassword(String(req.currentPassword ?? ''), u.password_hash)) {
      throw new AppError('VALIDATION', 'Current password is incorrect.', 'currentPassword');
    }
    const next = checkPasswordStrength(req.newPassword);
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(hashPassword(next), u.id);
      writeAudit(this.db, actor, 'user.change_password', 'user', u.id);
    })();
  }

  // ───────────── user management (admin) ─────────────
  listUsers(actor: Actor): UserDto[] {
    assertCan(actor, 'users.manage');
    return (this.db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as UserRow[]).map(toDto);
  }

  createUser(actor: Actor, req: { username: string; displayName: string; role: Role; password: string }): UserDto {
    assertCan(actor, 'users.manage');
    const username = checkUsername(req.username);
    const displayName = text(req.displayName, 'Name', 80, true);
    if (req.role !== 'admin' && req.role !== 'cashier') throw new AppError('VALIDATION', 'Choose a valid role.', 'role');
    const password = checkPasswordStrength(req.password);
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new AppError('DUPLICATE', 'That username is already taken.', 'username');
    }
    const id = this.db.transaction((): number => {
      const newId = Number(
        this.db
          .prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
          .run(username, displayName, req.role, hashPassword(password)).lastInsertRowid,
      );
      writeAudit(this.db, actor, 'user.create', 'user', newId, { username, role: req.role });
      return newId;
    })();
    return toDto(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
  }

  updateUser(actor: Actor, req: { id: number; displayName: string; role: Role; isActive: boolean }): UserDto {
    assertCan(actor, 'users.manage');
    const existing = this.db.prepare('SELECT * FROM users WHERE id = ?').get(req.id) as UserRow | undefined;
    if (!existing) throw new AppError('NOT_FOUND', 'User not found.');
    const displayName = text(req.displayName, 'Name', 80, true);
    if (req.role !== 'admin' && req.role !== 'cashier') throw new AppError('VALIDATION', 'Choose a valid role.', 'role');

    const losesAdmin = existing.role === 'admin' && existing.is_active === 1 && (req.role !== 'admin' || !req.isActive);
    if (losesAdmin) {
      const others = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?`).get(existing.id) as {
          n: number;
        }
      ).n;
      if (others === 0) {
        throw new AppError('CONFLICT', 'There must always be at least one active administrator.');
      }
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE users SET display_name = ?, role = ?, is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(displayName, req.role, req.isActive ? 1 : 0, existing.id);
      writeAudit(this.db, actor, 'user.update', 'user', existing.id, {
        role: { from: existing.role, to: req.role },
        isActive: { from: existing.is_active === 1, to: req.isActive },
      });
    })();
    return toDto(this.db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id) as UserRow);
  }

  resetPassword(actor: Actor, req: { id: number; newPassword: string }): void {
    assertCan(actor, 'users.manage');
    const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(req.id);
    if (!existing) throw new AppError('NOT_FOUND', 'User not found.');
    const password = checkPasswordStrength(req.newPassword);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(hashPassword(password), req.id);
      writeAudit(this.db, actor, 'user.reset_password', 'user', req.id);
    })();
  }
}

let cachedDummy: string | null = null;
function hashPasswordCached(): string {
  cachedDummy ??= hashPassword('not-a-real-password');
  return cachedDummy;
}
