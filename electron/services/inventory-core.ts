import type { Db } from '../db/connection';
import { AppError } from '../main/errors';

export type MovementType =
  | 'opening_stock'
  | 'purchase_receipt'
  | 'sale'
  | 'sale_cancellation'
  | 'customer_return'
  | 'supplier_return'
  | 'adjustment_increase'
  | 'adjustment_decrease'
  | 'damaged'
  | 'lost';

export type MovementRef = 'sale' | 'purchase' | 'return' | 'supplier_return' | 'manual';

export interface MovementInput {
  variantId: number;
  type: MovementType;
  /** Signed: positive adds stock, negative removes it. Direction must match `type`. */
  quantityDelta: number;
  unitCostMinor?: number | null;
  reason?: string | null;
  refType?: MovementRef | null;
  refId?: number | null;
  userId?: number | null;
}

export interface MovementResult {
  movementId: number;
  balanceAfter: number;
}

/**
 * The only function that changes stock. Every stock change in the app goes
 * through here so it always lands in the ledger. Must be called inside the
 * caller's transaction when it is part of a larger operation; the database
 * triggers enforce the negative-stock setting and ledger consistency.
 */
export function recordMovement(db: Db, input: MovementInput): MovementResult {
  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
    throw new AppError('VALIDATION', 'Quantity must be a whole number other than zero.', 'quantity');
  }
  const info = db
    .prepare(
      `INSERT INTO stock_movements
         (variant_id, movement_type, quantity_delta, unit_cost_minor, reason, ref_type, ref_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.variantId,
      input.type,
      input.quantityDelta,
      input.unitCostMinor ?? null,
      input.reason?.trim() || null,
      input.refType ?? null,
      input.refId ?? null,
      input.userId ?? null,
    );
  const movementId = Number(info.lastInsertRowid);
  const row = db.prepare('SELECT balance_after FROM stock_movements WHERE id = ?').get(movementId) as {
    balance_after: number;
  };
  return { movementId, balanceAfter: row.balance_after };
}
