/** Online and phone order management. Existing sales and stock history remain intact. */
export const migration002 = {
  version: 2,
  name: 'orders_and_courier_tracking',
  sql: `
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('facebook','instagram','whatsapp','phone','website','walk_in','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','dispatched','in_transit','delivered','failed','returned')),
  customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) > 0),
  customer_phone TEXT NOT NULL,
  delivery_address TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL DEFAULT '',
  recipient_phone TEXT NOT NULL DEFAULT '',
  courier_name TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card','bank_transfer','cod')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','prepaid','cod_pending','settled','refunded')),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  delivery_fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  cod_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (cod_amount_minor >= 0),
  courier_paid_minor INTEGER NOT NULL DEFAULT 0 CHECK (courier_paid_minor >= 0 AND courier_paid_minor <= cod_amount_minor),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (discount_minor <= subtotal_minor),
  CHECK (cod_amount_minor <= subtotal_minor - discount_minor + delivery_fee_minor)
) STRICT;
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE INDEX idx_orders_tracking ON orders(tracking_number);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  size TEXT NOT NULL DEFAULT '',
  colour TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0)
) STRICT;
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE TABLE courier_settlements (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reference TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  received_by INTEGER REFERENCES users(id)
) STRICT;
CREATE INDEX idx_courier_settlements_order ON courier_settlements(order_id);
CREATE TRIGGER trg_orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'ORDERS_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_order_items_no_update BEFORE UPDATE ON order_items
BEGIN SELECT RAISE(ABORT, 'ORDER_ITEMS_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_order_items_no_delete BEFORE DELETE ON order_items
BEGIN SELECT RAISE(ABORT, 'ORDER_ITEMS_ARE_IMMUTABLE'); END;
INSERT INTO payment_methods (code, name, is_cash, reference_mode, sort_order)
VALUES ('cod', 'Cash on delivery', 1, 'none', 5);
`,
};
