export const migration005 = {
  version: 5,
  name: 'order_discount_codes',
  sql: `ALTER TABLE orders ADD COLUMN discount_code TEXT NOT NULL DEFAULT '';`,
};
