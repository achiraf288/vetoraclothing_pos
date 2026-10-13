# Testing

## Automated (any OS)

```bash
npm test            # Vitest, real SQLite, ~15 s
npm run build       # Angular production build + Electron compile (must be error-free)
```

Last verified run (Linux x64, Node 22): 9 test files, 141 tests passing; both builds succeed;
the packaged-style app starts under Xvfb, creates its database and applies migration 1.

What the automated suites cover: schema creation and constraints, migrations (including safety
backup), products/variants and duplicate SKUs, variant-level stock, invalid money/quantity input,
checkout success, stock deduction, full rollback on failure, duplicate-checkout protection,
returns and refund limits, financial formulas, expenses, purchases receiving, backup/restore and
validation, authentication, lockout and permission enforcement.

What they do **not** cover: the Angular screens themselves, real printers, installers.

## Manual end-to-end checklist (macOS and Windows)

Run on a clean machine or after deleting the app-data folder (see README for its location).

1. **First launch** - app opens to the setup screen; create an admin. Relaunch: goes to login.
2. **Catalogue** - add a product with variants (e.g. Black T-shirt: M and L, different stock).
   Try a duplicate SKU: it must be rejected. Archive and restore a product.
3. **Purchase** - create a supplier and a purchase; stock must not change until you press
   Receive. After receiving, check Inventory > Movements shows the entry.
4. **Sale** - on POS, add items by search and by typing a SKU/barcode + Enter. Apply a line
   discount and an order discount. Pay cash with a tendered amount: change is correct. Complete.
   Stock for that exact variant dropped; the other size did not.
5. **Price immutability** - change that product's selling price; open the earlier sale: its
   line prices are unchanged.
6. **Receipt** - preview, print and reprint. Switch paper width 58/80 mm in Settings and check
   the layout. Print to a real thermal printer if you have one (not verified by the author).
7. **Return** - return part of a sale; try returning more than sold (must be refused). Restock
   one return and mark another damaged; check stock and the reports differ accordingly.
8. **Cancel** - cancel a sale as admin with a reason; it stays in history marked cancelled and
   stock returns.
9. **Expenses and reports** - add expenses; check Dashboard and Reports show gross profit and net
   profit separately; export a CSV and open it in a spreadsheet.
10. **Roles** - create a cashier. Cashier must not see Settings, Reports, Expenses, Purchases or
    stock adjustment; direct URL navigation must bounce to the forbidden page.
11. **Backup** - make a manual backup, add a sale, restore the backup: the sale is gone and a
    safety backup of the pre-restore state exists. Try restoring a random non-database file: refused.
12. **Upgrade** - install a newer build over the old one; data must remain.
13. **Offline** - disable the network and repeat steps 4-6; everything must work.

Windows extras: install per-user via NSIS, check Start-menu shortcut, uninstall and confirm the
data folder is kept. macOS extras: DMG drag-install, first-run Gatekeeper prompt, Apple Silicon
and Intel builds if you ship both.
