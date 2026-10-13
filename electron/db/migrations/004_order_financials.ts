export const migration004 = {
  version: 4,
  name: 'order_cost_and_business_dates',
  sql: `
ALTER TABLE orders ADD COLUMN order_date TEXT NOT NULL DEFAULT '1970-01-01';
ALTER TABLE orders ADD COLUMN returned_at TEXT;
ALTER TABLE orders ADD COLUMN delivered_at TEXT;
ALTER TABLE order_items ADD COLUMN unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0);
UPDATE orders SET order_date=date(created_at);
`,
};
