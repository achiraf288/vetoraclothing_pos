import type { ErrorCode, PublicError } from '../shared/api';

export type { ErrorCode, PublicError, IpcResult } from '../shared/api';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const TRIGGER_MESSAGES: Record<string, { code: ErrorCode; message: string }> = {
  INSUFFICIENT_STOCK: { code: 'INSUFFICIENT_STOCK', message: 'Not enough stock available for this operation.' },
  STOCK_LEDGER_MISMATCH: { code: 'CONFLICT', message: 'Stock can only be changed through a recorded stock movement.' },
  STOCK_MUST_START_AT_ZERO: { code: 'VALIDATION', message: 'New variants start at zero stock; record opening stock separately.' },
  LEDGER_IS_APPEND_ONLY: { code: 'IMMUTABLE', message: 'Stock history cannot be edited or deleted.' },
  SALES_ARE_IMMUTABLE: { code: 'IMMUTABLE', message: 'Completed sales cannot be edited or deleted.' },
  RETURNS_ARE_IMMUTABLE: { code: 'IMMUTABLE', message: 'Returns cannot be edited or deleted.' },
  AUDIT_LOG_IS_APPEND_ONLY: { code: 'IMMUTABLE', message: 'The audit log cannot be edited or deleted.' },
  PURCHASE_ALREADY_RECEIVED: { code: 'IMMUTABLE', message: 'A received purchase can no longer be changed.' },
  RETURN_EXCEEDS_SOLD_QUANTITY: { code: 'RETURN_LIMIT', message: 'Cannot return more units than were sold and not yet returned.' },
  REFUND_EXCEEDS_LINE_TOTAL: { code: 'RETURN_LIMIT', message: 'Cannot refund more than the line was worth.' },
  RETURN_ITEM_NOT_IN_SALE: { code: 'VALIDATION', message: 'That item does not belong to the selected sale.' },
};

/**
 * Converts any thrown value into an error that is safe to send to the
 * renderer. Unknown errors are reduced to a generic message; the original is
 * returned separately so the caller can log it.
 */
export function toPublicError(err: unknown): { error: PublicError; unexpected: boolean } {
  if (err instanceof AppError) {
    return { error: { code: err.code, message: err.message, field: err.field }, unexpected: false };
  }
  const e = err as { code?: string; message?: string } | undefined;
  const message = e?.message ?? '';

  for (const [token, mapped] of Object.entries(TRIGGER_MESSAGES)) {
    if (message.includes(token)) return { error: { ...mapped }, unexpected: false };
  }
  if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const field = /\.([a-z_]+)$/i.exec(message)?.[1];
    return {
      error: { code: 'DUPLICATE', message: 'A record with the same value already exists.', field },
      unexpected: false,
    };
  }
  if (e?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return {
      error: { code: 'CONFLICT', message: 'This record is referenced by other data and cannot be changed that way.' },
      unexpected: false,
    };
  }
  if (e?.code?.startsWith('SQLITE_CONSTRAINT')) {
    return { error: { code: 'VALIDATION', message: 'The values provided are not allowed.' }, unexpected: false };
  }
  return { error: { code: 'INTERNAL', message: 'Something went wrong. The operation was not completed.' }, unexpected: true };
}
