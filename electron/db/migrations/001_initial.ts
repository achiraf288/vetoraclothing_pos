/**
 * Migration 1 — initial schema.
 *
 * Conventions
 *  - Money: INTEGER minor units (e.g. cents). Column names end in `_minor`.
 *  - Timestamps: UTC ISO-8601 text ('2026-10-12T05:54:00.000Z'). The UI converts
 *    to local time. `*_date` columns hold the LOCAL business date (YYYY-MM-DD)
 *    captured when the record was created, so reports group by the shop's day
 *    even if the computer's timezone later changes.
 *  - History is never deleted: sales, payments, returns, stock movements and
 *    audit logs are protected by triggers.
 *  - `product_variants.stock_qty` is a cache of SUM(stock_movements.quantity_delta).
 *    A trigger rejects any change that does not match the ledger, so every
 *    stock change must go through a stock_movements row.
 */
export const migration001 = {
  version: 1,
  name: 'initial_schema',
  sql: `
-- ───────────── configuration ─────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID, STRICT;

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK (value >= 0)
) WITHOUT ROWID, STRICT;

CREATE TABLE payment_methods (
  code           TEXT PRIMARY KEY CHECK (code = lower(code) AND length(code) BETWEEN 2 AND 30),
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  is_cash        INTEGER NOT NULL DEFAULT 0 CHECK (is_cash IN (0,1)),
  reference_mode TEXT NOT NULL DEFAULT 'optional' CHECK (reference_mode IN ('none','optional','required')),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order     INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID, STRICT;

-- ───────────── users & access ─────────────
CREATE TABLE users (
  id              INTEGER PRIMARY KEY,
  username        TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(username)) BETWEEN 3 AND 40),
  display_name    TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  role            TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  password_hash   TEXT NOT NULL CHECK (length(password_hash) > 20),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TEXT,
  last_login_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- ───────────── catalogue ─────────────
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE products (
  id                  INTEGER PRIMARY KEY,
  sku                 TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(sku)) > 0),
  name                TEXT NOT NULL CHECK (length(trim(name)) > 0),
  category_id         INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  brand               TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  image_path          TEXT,
  default_cost_minor  INTEGER NOT NULL DEFAULT 0 CHECK (default_cost_minor >= 0),
  default_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (default_price_minor >= 0),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  archived_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX idx_products_active ON products(is_active);

CREATE TABLE product_variants (
  id                INTEGER PRIMARY KEY,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku               TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(sku)) > 0),
  barcode           TEXT COLLATE NOCASE UNIQUE CHECK (barcode IS NULL OR length(trim(barcode)) > 0),
  size              TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  colour            TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  cost_minor        INTEGER NOT NULL CHECK (cost_minor >= 0),
  price_minor       INTEGER NOT NULL CHECK (price_minor >= 0),
  stock_qty         INTEGER NOT NULL DEFAULT 0,
  reorder_threshold INTEGER NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (product_id, size, colour)
) STRICT;
CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_variants_low_stock ON product_variants(is_active, stock_qty, reorder_threshold);

-- New variants always start at zero; opening stock goes through the ledger.
CREATE TRIGGER trg_variants_start_at_zero
BEFORE INSERT ON product_variants
WHEN NEW.stock_qty <> 0
BEGIN
  SELECT RAISE(ABORT, 'STOCK_MUST_START_AT_ZERO');
END;

-- Negative stock is blocked unless the setting explicitly allows it.
CREATE TRIGGER trg_variants_no_negative_stock
BEFORE UPDATE OF stock_qty ON product_variants
WHEN NEW.stock_qty < 0
 AND COALESCE((SELECT value FROM settings WHERE key = 'inventory.allow_negative_stock'), '0') <> '1'
BEGIN
  SELECT RAISE(ABORT, 'INSUFFICIENT_STOCK');
END;

-- stock_qty may only ever equal the ledger total.
CREATE TRIGGER trg_variants_stock_matches_ledger
BEFORE UPDATE OF stock_qty ON product_variants
WHEN NEW.stock_qty <> OLD.stock_qty
 AND NEW.stock_qty <> (SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements WHERE variant_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'STOCK_LEDGER_MISMATCH');
END;

-- ───────────── suppliers & purchasing ─────────────
CREATE TABLE suppliers (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
  contact_name TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE purchases (
  id               INTEGER PRIMARY KEY,
  purchase_no      TEXT NOT NULL UNIQUE,
  supplier_id      INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','received','cancelled')),
  supplier_ref     TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  total_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_minor >= 0),
  purchase_date    TEXT NOT NULL CHECK (date(purchase_date) IS purchase_date),
  created_by       INTEGER REFERENCES users(id),
  received_by      INTEGER REFERENCES users(id),
  received_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((status = 'received') = (received_at IS NOT NULL))
) STRICT;
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);

CREATE TABLE purchase_items (
  id               INTEGER PRIMARY KEY,
  purchase_id      INTEGER NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  variant_id       INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_minor  INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = quantity * unit_cost_minor),
  UNIQUE (purchase_id, variant_id)
) STRICT;
CREATE INDEX idx_purchase_items_variant ON purchase_items(variant_id);

-- Received purchases are history: their lines can no longer change.
CREATE TRIGGER trg_purchase_items_locked_update
BEFORE UPDATE ON purchase_items
WHEN (SELECT status FROM purchases WHERE id = OLD.purchase_id) = 'received'
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_ALREADY_RECEIVED');
END;
CREATE TRIGGER trg_purchase_items_locked_delete
BEFORE DELETE ON purchase_items
WHEN (SELECT status FROM purchases WHERE id = OLD.purchase_id) = 'received'
BEGIN
  SELECT RAISE(ABORT, 'PURCHASE_ALREADY_RECEIVED');
END;

CREATE TABLE supplier_returns (
  id                INTEGER PRIMARY KEY,
  return_no         TEXT NOT NULL UNIQUE,
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_id       INTEGER REFERENCES purchases(id) ON DELETE RESTRICT,
  reason            TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  total_cost_minor  INTEGER NOT NULL DEFAULT 0 CHECK (total_cost_minor >= 0),
  return_date       TEXT NOT NULL CHECK (date(return_date) IS return_date),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE supplier_return_items (
  id               INTEGER PRIMARY KEY,
  supplier_return_id INTEGER NOT NULL REFERENCES supplier_returns(id) ON DELETE RESTRICT,
  variant_id       INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_minor  INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  UNIQUE (supplier_return_id, variant_id)
) STRICT;

-- ───────────── stock ledger ─────────────
CREATE TABLE stock_movements (
  id             INTEGER PRIMARY KEY,
  variant_id     INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  movement_type  TEXT NOT NULL CHECK (movement_type IN (
                   'opening_stock','purchase_receipt','sale','sale_cancellation',
                   'customer_return','supplier_return',
                   'adjustment_increase','adjustment_decrease','damaged','lost')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  unit_cost_minor INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  reason         TEXT,
  ref_type       TEXT CHECK (ref_type IS NULL OR ref_type IN ('sale','purchase','return','supplier_return','manual')),
  ref_id         INTEGER,
  user_id        INTEGER REFERENCES users(id),
  balance_after  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- direction must match the movement type
  CHECK (
    (movement_type IN ('opening_stock','purchase_receipt','sale_cancellation','customer_return','adjustment_increase') AND quantity_delta > 0)
    OR
    (movement_type IN ('sale','supplier_return','adjustment_decrease','damaged','lost') AND quantity_delta < 0)
  ),
  -- manual corrections must say why
  CHECK (movement_type NOT IN ('adjustment_increase','adjustment_decrease','damaged','lost')
         OR length(trim(COALESCE(reason, ''))) > 0),
  -- document-driven movements must point at their originating record
  CHECK (movement_type NOT IN ('purchase_receipt','sale','sale_cancellation','customer_return','supplier_return')
         OR (ref_type IS NOT NULL AND ref_id IS NOT NULL))
) STRICT;
CREATE INDEX idx_movements_variant ON stock_movements(variant_id, quantity_delta);
CREATE INDEX idx_movements_created ON stock_movements(created_at);
CREATE INDEX idx_movements_ref ON stock_movements(ref_type, ref_id);

CREATE TRIGGER trg_movements_apply
AFTER INSERT ON stock_movements
BEGIN
  UPDATE product_variants
     SET stock_qty = stock_qty + NEW.quantity_delta,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id = NEW.variant_id;
  UPDATE stock_movements
     SET balance_after = (SELECT stock_qty FROM product_variants WHERE id = NEW.variant_id)
   WHERE id = NEW.id;
END;

-- The ledger is append-only (balance_after is filled once by trg_movements_apply).
CREATE TRIGGER trg_movements_no_update
BEFORE UPDATE ON stock_movements
WHEN OLD.balance_after IS NOT NULL
  OR NEW.variant_id IS NOT OLD.variant_id
  OR NEW.movement_type IS NOT OLD.movement_type
  OR NEW.quantity_delta IS NOT OLD.quantity_delta
  OR NEW.unit_cost_minor IS NOT OLD.unit_cost_minor
  OR NEW.reason IS NOT OLD.reason
  OR NEW.ref_type IS NOT OLD.ref_type
  OR NEW.ref_id IS NOT OLD.ref_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IS_APPEND_ONLY');
END;
CREATE TRIGGER trg_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_IS_APPEND_ONLY');
END;

-- ───────────── sales ─────────────
CREATE TABLE sales (
  id                        INTEGER PRIMARY KEY,
  receipt_no                TEXT NOT NULL UNIQUE,
  idempotency_key           TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  status                    TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
  sale_date                 TEXT NOT NULL CHECK (date(sale_date) IS sale_date),
  cashier_id                INTEGER REFERENCES users(id),
  customer_name             TEXT NOT NULL DEFAULT '',
  customer_phone            TEXT NOT NULL DEFAULT '',
  notes                     TEXT NOT NULL DEFAULT '',
  subtotal_minor            INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  line_discount_total_minor INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_total_minor >= 0),
  order_discount_minor      INTEGER NOT NULL DEFAULT 0 CHECK (order_discount_minor >= 0),
  tax_minor                 INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor               INTEGER NOT NULL CHECK (total_minor >= 0),
  cancelled_at              TEXT,
  cancelled_by              INTEGER REFERENCES users(id),
  cancel_reason             TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (total_minor = subtotal_minor - line_discount_total_minor - order_discount_minor + tax_minor),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR length(trim(COALESCE(cancel_reason, ''))) > 0)
) STRICT;
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_created ON sales(created_at);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_cashier ON sales(cashier_id);

CREATE TABLE sale_items (
  id                         INTEGER PRIMARY KEY,
  sale_id                    INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  variant_id                 INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  product_name               TEXT NOT NULL,
  sku                        TEXT NOT NULL,
  size                       TEXT NOT NULL DEFAULT '',
  colour                     TEXT NOT NULL DEFAULT '',
  quantity                   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor           INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  unit_cost_minor            INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  line_discount_minor        INTEGER NOT NULL DEFAULT 0 CHECK (line_discount_minor >= 0),
  order_discount_share_minor INTEGER NOT NULL DEFAULT 0 CHECK (order_discount_share_minor >= 0),
  line_net_minor             INTEGER NOT NULL CHECK (line_net_minor >= 0),
  CHECK (line_net_minor = quantity * unit_price_minor - line_discount_minor - order_discount_share_minor)
) STRICT;
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_variant ON sale_items(variant_id);

CREATE TABLE payments (
  id             INTEGER PRIMARY KEY,
  sale_id        INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  method_code    TEXT NOT NULL REFERENCES payment_methods(code),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  tendered_minor INTEGER CHECK (tendered_minor IS NULL OR tendered_minor >= amount_minor),
  change_minor   INTEGER CHECK (change_minor IS NULL OR change_minor >= 0),
  reference      TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (tendered_minor IS NULL OR change_minor = tendered_minor - amount_minor)
) STRICT;
CREATE INDEX idx_payments_sale ON payments(sale_id);

-- Completed-sale history is immutable: no deletes, no edits to money or lines.
CREATE TRIGGER trg_sales_no_delete
BEFORE DELETE ON sales
BEGIN
  SELECT RAISE(ABORT, 'SALES_ARE_IMMUTABLE');
END;
CREATE TRIGGER trg_sales_immutable_fields
BEFORE UPDATE ON sales
WHEN NEW.receipt_no IS NOT OLD.receipt_no
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.sale_date IS NOT OLD.sale_date
  OR NEW.cashier_id IS NOT OLD.cashier_id
  OR NEW.subtotal_minor IS NOT OLD.subtotal_minor
  OR NEW.line_discount_total_minor IS NOT OLD.line_discount_total_minor
  OR NEW.order_discount_minor IS NOT OLD.order_discount_minor
  OR NEW.tax_minor IS NOT OLD.tax_minor
  OR NEW.total_minor IS NOT OLD.total_minor
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status = 'cancelled' AND NEW.status <> 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'SALES_ARE_IMMUTABLE');
END;
CREATE TRIGGER trg_sale_items_no_update BEFORE UPDATE ON sale_items
BEGIN SELECT RAISE(ABORT, 'SALES_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_sale_items_no_delete BEFORE DELETE ON sale_items
BEGIN SELECT RAISE(ABORT, 'SALES_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'SALES_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'SALES_ARE_IMMUTABLE'); END;

-- ───────────── customer returns ─────────────
CREATE TABLE returns (
  id                  INTEGER PRIMARY KEY,
  return_no           TEXT NOT NULL UNIQUE,
  sale_id             INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  return_date         TEXT NOT NULL CHECK (date(return_date) IS return_date),
  refund_method_code  TEXT REFERENCES payment_methods(code),
  refund_amount_minor INTEGER NOT NULL CHECK (refund_amount_minor >= 0),
  reason              TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  notes               TEXT NOT NULL DEFAULT '',
  user_id             INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (refund_amount_minor = 0 OR refund_method_code IS NOT NULL)
) STRICT;
CREATE INDEX idx_returns_sale ON returns(sale_id);
CREATE INDEX idx_returns_date ON returns(return_date);

CREATE TABLE return_items (
  id            INTEGER PRIMARY KEY,
  return_id     INTEGER NOT NULL REFERENCES returns(id) ON DELETE RESTRICT,
  sale_item_id  INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  refund_minor  INTEGER NOT NULL CHECK (refund_minor >= 0),
  condition     TEXT NOT NULL CHECK (condition IN ('resalable','damaged')),
  restocked     INTEGER NOT NULL DEFAULT 0 CHECK (restocked IN (0,1)),
  -- only items explicitly confirmed resalable may go back into stock
  CHECK (restocked = 0 OR condition = 'resalable'),
  UNIQUE (return_id, sale_item_id)
) STRICT;
CREATE INDEX idx_return_items_sale_item ON return_items(sale_item_id);

-- The item must belong to the sale being returned against.
CREATE TRIGGER trg_return_items_same_sale
BEFORE INSERT ON return_items
WHEN (SELECT sale_id FROM sale_items WHERE id = NEW.sale_item_id)
  IS NOT (SELECT sale_id FROM returns WHERE id = NEW.return_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_ITEM_NOT_IN_SALE');
END;

-- Cannot return more than was sold, across all returns combined.
CREATE TRIGGER trg_return_items_limit
BEFORE INSERT ON return_items
WHEN NEW.quantity > (SELECT quantity FROM sale_items WHERE id = NEW.sale_item_id)
                    - (SELECT COALESCE(SUM(quantity), 0) FROM return_items WHERE sale_item_id = NEW.sale_item_id)
BEGIN
  SELECT RAISE(ABORT, 'RETURN_EXCEEDS_SOLD_QUANTITY');
END;

-- Cannot refund more than the line actually netted, across all returns.
CREATE TRIGGER trg_return_items_refund_limit
BEFORE INSERT ON return_items
WHEN NEW.refund_minor > (SELECT line_net_minor FROM sale_items WHERE id = NEW.sale_item_id)
                      - (SELECT COALESCE(SUM(refund_minor), 0) FROM return_items WHERE sale_item_id = NEW.sale_item_id)
BEGIN
  SELECT RAISE(ABORT, 'REFUND_EXCEEDS_LINE_TOTAL');
END;

CREATE TRIGGER trg_returns_no_delete BEFORE DELETE ON returns
BEGIN SELECT RAISE(ABORT, 'RETURNS_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_returns_no_update BEFORE UPDATE ON returns
BEGIN SELECT RAISE(ABORT, 'RETURNS_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_return_items_no_delete BEFORE DELETE ON return_items
BEGIN SELECT RAISE(ABORT, 'RETURNS_ARE_IMMUTABLE'); END;
CREATE TRIGGER trg_return_items_no_update BEFORE UPDATE ON return_items
BEGIN SELECT RAISE(ABORT, 'RETURNS_ARE_IMMUTABLE'); END;

-- ───────────── expenses ─────────────
CREATE TABLE expense_categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
) STRICT;

CREATE TABLE expenses (
  id                  INTEGER PRIMARY KEY,
  category_id         INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  expense_date        TEXT NOT NULL CHECK (date(expense_date) IS expense_date),
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  payment_method_code TEXT REFERENCES payment_methods(code),
  notes               TEXT NOT NULL DEFAULT '',
  created_by          INTEGER REFERENCES users(id),
  voided_at           TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_category ON expenses(category_id);

-- ───────────── audit trail ─────────────
CREATE TABLE audit_logs (
  id              INTEGER PRIMARY KEY,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  user_id         INTEGER REFERENCES users(id),
  username        TEXT NOT NULL DEFAULT '',
  action          TEXT NOT NULL CHECK (length(action) > 0),
  entity_type     TEXT NOT NULL DEFAULT '',
  entity_id       TEXT NOT NULL DEFAULT '',
  details         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details))
) STRICT;
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_user ON audit_logs(user_id);

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IS_APPEND_ONLY'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IS_APPEND_ONLY'); END;

-- ───────────── defaults (configuration only, no demo data) ─────────────
INSERT INTO settings (key, value) VALUES
  ('shop.name', 'My Boutique'),
  ('shop.address', ''),
  ('shop.phone', ''),
  ('shop.email', ''),
  ('currency.code', 'LKR'),
  ('currency.symbol', 'Rs'),
  ('currency.decimals', '2'),
  ('locale', 'en-LK'),
  ('receipt.footer', 'Thank you for shopping with us.'),
  ('receipt.paper_width_mm', '80'),
  ('tax.enabled', '0'),
  ('tax.label', 'Tax'),
  ('tax.rate_bps', '0'),
  ('tax.inclusive', '0'),
  ('inventory.allow_negative_stock', '0'),
  ('inventory.low_stock_default', '5'),
  ('inventory.sizes', '["XS","S","M","L","XL","XXL"]'),
  ('backup.auto_enabled', '0'),
  ('backup.interval_hours', '24'),
  ('backup.keep_count', '14'),
  ('backup.directory', '');

INSERT INTO payment_methods (code, name, is_cash, reference_mode, sort_order) VALUES
  ('cash', 'Cash', 1, 'none', 1),
  ('card', 'Card', 0, 'optional', 2),
  ('bank_transfer', 'Bank transfer', 0, 'required', 3),
  ('other', 'Other', 0, 'optional', 4);

INSERT INTO expense_categories (name) VALUES
  ('Rent'), ('Transport'), ('Electricity'), ('Salaries'), ('Packaging'), ('Other');
`,
};
