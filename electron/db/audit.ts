import type { Db } from './connection';

export interface AuditActor {
  userId: number | null;
  username: string;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, username: 'system' };

const SENSITIVE_KEY = /pass(word)?|hash|secret|token|salt/i;

/** Strips anything that looks like a credential before it reaches the log. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

export function writeAudit(
  db: Db,
  actor: AuditActor,
  action: string,
  entityType = '',
  entityId: string | number = '',
  details: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(actor.userId, actor.username, action, entityType, String(entityId), JSON.stringify(redact(details)));
}
