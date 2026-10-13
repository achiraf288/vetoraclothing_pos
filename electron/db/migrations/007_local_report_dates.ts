export const migration007 = {
  version: 7,
  name: 'local_business_dates_for_order_reporting',
  sql: `
ALTER TABLE orders ADD COLUMN delivered_date TEXT;
ALTER TABLE orders ADD COLUMN returned_date TEXT;
ALTER TABLE orders ADD COLUMN refunded_date TEXT;
UPDATE orders SET delivered_date=date(delivered_at) WHERE delivered_at IS NOT NULL;
UPDATE orders SET returned_date=date(returned_at) WHERE returned_at IS NOT NULL;
UPDATE orders SET refunded_date=date(refunded_at) WHERE refunded_at IS NOT NULL;
ALTER TABLE payments ADD COLUMN payment_date TEXT NOT NULL DEFAULT '1970-01-01';
UPDATE payments SET payment_date=COALESCE((SELECT sale_date FROM sales WHERE sales.id=payments.sale_id),'1970-01-01');
ALTER TABLE courier_settlements ADD COLUMN received_date TEXT NOT NULL DEFAULT '1970-01-01';
UPDATE courier_settlements SET received_date=date(received_at);
`,
};
