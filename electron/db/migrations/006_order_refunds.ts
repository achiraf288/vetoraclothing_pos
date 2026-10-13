export const migration006 = {
  version: 6,
  name: 'order_refund_tracking',
  sql: `
ALTER TABLE orders ADD COLUMN refunded_at TEXT;
ALTER TABLE orders ADD COLUMN refund_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount_minor >= 0);
`,
};
