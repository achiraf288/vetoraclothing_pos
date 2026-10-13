# Feature checklist

Legend: **T** = covered by automated tests on the underlying logic; **M** = implemented, verify
manually (UI or hardware dependent); **-** = not done.

| Area | Status |
|---|---|
| Secure Electron setup (isolation, sandbox, CSP, navigation limits, validated IPC) | Implemented, **M** (settings present in code; no automated Electron-level test) |
| SQLite schema, constraints, versioned migrations, safety backup before migrating | **T** |
| Products, variants (size/colour/SKU/prices/threshold/archive), categories | **T** (service), **M** (UI) |
| Product images, activity history | Implemented, **M** |
| Inventory ledger, adjustments with reason, damaged/lost, negative-stock setting | **T** |
| Suppliers, purchases, receive-in-one-transaction, supplier returns | **T** (service), **M** (UI) |
| POS: search, barcode entry, discounts, payments, change | **T** (checkout logic), **M** (POS screen) |
| Discount codes with limits and minimum spend | Implemented in checkout and Settings; manual UI review pending |
| Phone, website and social-channel order capture | Implemented as staff-entered order channels; platform auto-import is not included |
| Courier selection, waybills, shipment statuses and COD reconciliation | Implemented; manual courier/printer review pending |
| Atomic checkout, rollback, duplicate-submit protection, price/cost snapshots | **T** |
| Receipts, reprint, 58/80 mm layout | **M** (never run on a physical thermal printer) |
| Returns and refunds, restock vs damaged, over-return prevention | **T** |
| Sale cancellation (history kept) | **T** |
| Expenses | **T** (calculations), **M** (UI) |
| Dashboard and reports, financial definitions, CSV export | **T** (figures), **M** (screens, CSV save dialog, print layout) |
| Settings (shop, currency, receipt, tax off by default, low-stock) | **M** |
| Roles, scrypt hashing, lockout, last-admin protection, audit log | **T** |
| Backup (`VACUUM INTO`), validation, safety backup, restore, scheduled backup | **T** (backup/restore), **M** (scheduler timing) |
| macOS DMG installer | Configured, **not built** (needs a Mac) |
| Windows NSIS installer | Configured, **not built** (needs Windows) |
| Code signing / notarisation | - (needs your certificates) |
| Automated UI/end-to-end tests | - (manual checklist in TESTING.md) |
