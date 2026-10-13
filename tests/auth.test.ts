import { describe, expect, it } from 'vitest';
import { AuthService, hashPassword, verifyPassword } from '../electron/services/auth-service';
import { memoryDb } from './helpers';
import { ADMIN_PASSWORD, CASHIER_PASSWORD, makeEnv } from './env';

describe('password hashing', () => {
  it('never stores the plaintext and uses a unique salt each time', () => {
    const a = hashPassword('secret-pass-1');
    const b = hashPassword('secret-pass-1');
    expect(a).not.toContain('secret-pass-1');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('secret-pass-1', a)).toBe(true);
    expect(verifyPassword('secret-pass-2', a)).toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$1$2$3$bad$bad')).toBe(false);
  });
});

describe('first-run setup and login', () => {
  it('requires setup when there are no users, and only allows it once', () => {
    const auth = new AuthService(memoryDb());
    expect(auth.status().needsSetup).toBe(true);
    const session = auth.setupAdmin({ username: 'boss', displayName: 'Boss', password: 'a-long-password' });
    expect(session.user.role).toBe('admin');
    expect(auth.status()).toMatchObject({ needsSetup: false, session: { user: { username: 'boss' } } });
    expect(() => auth.setupAdmin({ username: 'other', displayName: 'Other', password: 'another-password' })).toThrow(/already been completed/);
  });

  it('rejects weak passwords and bad usernames', () => {
    const auth = new AuthService(memoryDb());
    expect(() => auth.setupAdmin({ username: 'boss', displayName: 'B', password: 'short' })).toThrow(/at least 8/);
    expect(() => auth.setupAdmin({ username: 'a b', displayName: 'B', password: 'long-enough-pw' })).toThrow(/Username/);
  });

  it('stores only a hash in the database', () => {
    const { db } = makeEnv();
    const rows = db.prepare('SELECT password_hash FROM users').all() as Array<{ password_hash: string }>;
    for (const r of rows) {
      expect(r.password_hash.startsWith('scrypt$')).toBe(true);
      expect(r.password_hash).not.toContain(ADMIN_PASSWORD);
      expect(r.password_hash).not.toContain(CASHIER_PASSWORD);
    }
  });

  it('logs in with correct credentials and gives a generic error otherwise', () => {
    const { auth } = makeEnv();
    auth.logout();
    expect(auth.status().session).toBeNull();
    expect(() => auth.requireActor()).toThrow(/sign in/i);
    expect(() => auth.login({ username: 'owner', password: 'wrong-password' })).toThrow('Incorrect username or password.');
    expect(() => auth.login({ username: 'nobody', password: 'whatever-pass' })).toThrow('Incorrect username or password.');
    expect(auth.login({ username: 'OWNER', password: ADMIN_PASSWORD }).user.username).toBe('owner');
  });

  it('locks the account after repeated failures, even for the right password', () => {
    const { auth } = makeEnv();
    for (let i = 0; i < 5; i++) expect(() => auth.login({ username: 'cashier1', password: 'nope-nope-nope' })).toThrow();
    expect(() => auth.login({ username: 'cashier1', password: CASHIER_PASSWORD })).toThrow(/Too many failed attempts/);
  });

  it('signs a user out immediately when an administrator deactivates them', () => {
    const { auth, admin, cashier } = makeEnv();
    auth.logout();
    auth.login({ username: 'cashier1', password: CASHIER_PASSWORD });
    expect(auth.requireActor().role).toBe('cashier');
    auth.updateUser(admin, { id: cashier.userId!, displayName: 'Cashier One', role: 'cashier', isActive: false });
    expect(() => auth.requireActor()).toThrow(/sign in/i);
    expect(() => auth.login({ username: 'cashier1', password: CASHIER_PASSWORD })).toThrow('Incorrect username or password.');
  });
});

describe('user management', () => {
  it('only administrators can manage users', () => {
    const { auth, cashier } = makeEnv();
    expect(() => auth.listUsers(cashier)).toThrow(/permission/);
    expect(() => auth.createUser(cashier, { username: 'x-user', displayName: 'X', role: 'admin', password: 'password-123' })).toThrow(/permission/);
    expect(() => auth.resetPassword(cashier, { id: 1, newPassword: 'password-123' })).toThrow(/permission/);
  });

  it('never leaves the system without an active administrator', () => {
    const { auth, admin } = makeEnv();
    expect(() => auth.updateUser(admin, { id: admin.userId!, displayName: 'Owner', role: 'cashier', isActive: true })).toThrow(/at least one active administrator/);
    expect(() => auth.updateUser(admin, { id: admin.userId!, displayName: 'Owner', role: 'admin', isActive: false })).toThrow(/at least one active administrator/);
    const second = auth.createUser(admin, { username: 'second', displayName: 'Second', role: 'admin', password: 'password-123' });
    expect(auth.updateUser(admin, { id: second.id, displayName: 'Second', role: 'cashier', isActive: true }).role).toBe('cashier');
  });

  it('rejects duplicate usernames case-insensitively', () => {
    const { auth, admin } = makeEnv();
    expect(() => auth.createUser(admin, { username: 'CASHIER1', displayName: 'Dup', role: 'cashier', password: 'password-123' })).toThrow(/already taken/);
  });

  it('changes a password only with the correct current one, and the old one stops working', () => {
    const { auth, admin } = makeEnv();
    expect(() => auth.changePassword(admin, { currentPassword: 'wrong-current', newPassword: 'brand-new-password' })).toThrow(/Current password is incorrect/);
    auth.changePassword(admin, { currentPassword: ADMIN_PASSWORD, newPassword: 'brand-new-password' });
    auth.logout();
    expect(() => auth.login({ username: 'owner', password: ADMIN_PASSWORD })).toThrow();
    expect(auth.login({ username: 'owner', password: 'brand-new-password' }).user.id).toBe(admin.userId);
  });

  it('admin password reset also clears a lockout', () => {
    const { auth, admin } = makeEnv();
    for (let i = 0; i < 5; i++) expect(() => auth.login({ username: 'cashier1', password: 'bad-bad-bad-1' })).toThrow();
    const cashierId = auth.listUsers(admin).find((u) => u.username === 'cashier1')!.id;
    auth.resetPassword(admin, { id: cashierId, newPassword: 'fresh-password-9' });
    expect(auth.login({ username: 'cashier1', password: 'fresh-password-9' }).user.role).toBe('cashier');
  });

  it('writes audit entries without any password material', () => {
    const { db, auth, admin } = makeEnv();
    auth.resetPassword(admin, { id: admin.userId!, newPassword: 'super-secret-new-pw' });
    const dump = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
    expect(dump).not.toContain('super-secret-new-pw');
    expect(dump).not.toContain(ADMIN_PASSWORD);
    expect(dump).not.toContain('scrypt$');
  });
});

describe('administrator override', () => {
  it('accepts a valid administrator and rejects cashiers and wrong passwords', () => {
    const { auth } = makeEnv();
    expect(auth.verifyAdminOverride('owner', ADMIN_PASSWORD).username).toBe('owner');
    expect(() => auth.verifyAdminOverride('owner', 'wrong-password')).toThrow(/authorisation failed/);
    expect(() => auth.verifyAdminOverride('cashier1', CASHIER_PASSWORD)).toThrow(/authorisation failed/);
  });
});
