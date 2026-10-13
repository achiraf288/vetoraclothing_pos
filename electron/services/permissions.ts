import { AppError } from '../main/errors';
import type { Role } from '../shared/api';

export type Permission =
  | 'dashboard.read'
  | 'catalog.read'
  | 'catalog.write'
  | 'inventory.read'
  | 'inventory.adjust'
  | 'purchases.manage'
  | 'sales.create'
  | 'sales.read'
  | 'sales.cancel'
  | 'returns.create'
  | 'expenses.manage'
  | 'reports.read'
  | 'settings.read'
  | 'settings.write'
  | 'users.manage'
  | 'backup.manage'
  | 'audit.read';

export interface Actor {
  userId: number | null;
  username: string;
  role: Role;
}

const CASHIER: ReadonlySet<Permission> = new Set<Permission>([
  'catalog.read',
  'inventory.read',
  'sales.create',
  'sales.read',
  'returns.create',
]);

const ADMIN: ReadonlySet<Permission> = new Set<Permission>([
  ...CASHIER,
  'dashboard.read',
  'catalog.write',
  'inventory.adjust',
  'purchases.manage',
  'sales.cancel',
  'expenses.manage',
  'reports.read',
  'settings.read',
  'settings.write',
  'users.manage',
  'backup.manage',
  'audit.read',
]);

const MATRIX: Record<Role, ReadonlySet<Permission>> = { admin: ADMIN, cashier: CASHIER };

export function can(actor: Actor, permission: Permission): boolean {
  return MATRIX[actor.role]?.has(permission) ?? false;
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}
