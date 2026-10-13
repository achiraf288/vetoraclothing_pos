# Vetora POS

Offline desktop point-of-sale and inventory management for a clothing boutique.
Angular (standalone components) + Electron + SQLite (`better-sqlite3`). Runs natively on
macOS and Windows 10/11. No cloud, no remote backend, no external database server.

Vetora POS supports in-store checkout, apparel variants and stock, returns and refunds, expenses,
and manually recorded phone, website and social-channel orders with courier tracking and COD
reconciliation. Social and website orders are entered by staff; the offline app does not import
orders directly from those platforms.

| Layer | Technology |
|---|---|
| UI | Angular 21, standalone components, signals, SCSS |
| Desktop shell | Electron 44 (`contextIsolation`, sandbox, strict CSP) |
| Database | SQLite via `better-sqlite3` 13 (WAL mode, foreign keys ON) |
| Validation | `zod` on every IPC input, in the main process |
| Packaging | electron-builder 26 (macOS DMG, Windows NSIS) |
| Tests | Vitest (database and business-logic tests against real SQLite) |

Requires **Node.js 22.12 or newer**.

## Directory structure

```
electron/
  main/        Electron entry, window, CSP, IPC registration, handlers, logger
  preload/     contextBridge API (the only bridge between UI and main process)
  shared/      Typed API contract shared by preload and renderer
  db/          Connection, versioned migrations, migrator, money, audit, sequences
  services/    Business logic (sales, inventory, purchasing, returns, auth, backup, reports)
renderer/      Angular app (features/, core/, ui/)
tests/         Vitest suites
docs/          UI conventions, testing and checklist
```

Security boundary: the renderer never imports Electron, Node or SQLite. It calls a fixed list
of typed methods exposed by the preload script. The main process owns the database, checks
the caller's role for every command and validates every payload. There is no generic
"run SQL" or "read file" channel.

## Development

### macOS (Apple Silicon or Intel)

```bash
xcode-select --install          # once, if you have no compiler tools
cd maison-pos
npm install                     # also installs the renderer's dependencies
npm run dev                     # Angular dev server + Electron with hot reload
```

### Windows 10/11 (PowerShell)

```powershell
cd maison-pos
npm install
npm run dev
```

`better-sqlite3` 13 ships prebuilt N-API binaries for macOS (arm64/x64) and Windows (x64), so a
compiler is normally not needed. If a prebuild is missing, see Troubleshooting.

### Other scripts

| Script | What it does |
|---|---|
| `npm run build` | Production Angular build + compile Electron code |
| `npm start` | Build, then run the production build in Electron (no dev server) |
| `npm test` | Run all automated tests |
| `npm run rebuild:native` | Rebuild `better-sqlite3` against the installed Electron |
| `npm run dist:mac` | Build the macOS DMG (run **on a Mac**) |
| `npm run dist:win` | Build the Windows NSIS installer (run **on Windows**) |

## First launch

1. The database is created automatically in the OS app-data folder:
   - macOS: `~/Library/Application Support/Maison POS/data/maison-pos.sqlite` (legacy data folder retained across the Vetora POS rename)
   - Windows: `%APPDATA%\Maison POS\data\maison-pos.sqlite` (legacy data folder retained across the Vetora POS rename)
2. With no users present, the app shows a one-time **setup screen** to create the first
   Administrator. There are no default credentials. Setup is refused once any user exists.
3. The Administrator then creates cashier accounts under Settings > Users.

Backups default to the same app-data folder (`backups/`) and can be redirected to any folder
(an external drive is recommended). Logs are in `logs/`.

## Build installers

Build each installer on its own operating system (or in CI). Do not cross-build: native
modules and code signing differ per platform.

```bash
# On a Mac: produces release/*.dmg for arm64 and x64
npm install && npm test && npm run dist:mac

# On Windows 10/11: produces release\*.exe (NSIS, x64)
npm install && npm test && npm run dist:win
```

Notes:
- Installers are **unsigned**. macOS Gatekeeper will require right-click > Open on first run;
  Windows SmartScreen will show a warning. Signing needs your own Apple/Windows certificates.
- The installer never touches the app-data folder, and the NSIS uninstaller keeps user data
  (`deleteAppDataOnUninstall: false`). Upgrading keeps your database.
- After building, verify the installed app: it starts, shows version in Settings > About, and
  the database path matches the location above.

## Money

All amounts are stored as **integer minor units** (cents). The currency scale is fixed once data
exists, because changing it would silently re-price history. Default currency: LKR.

## Financial definitions (used by the dashboard and reports)

```
gross sales      = completed POS sales and delivered customer orders in the period
discounts        = line discounts and order discounts on those transactions
refunds          = returns processed in the period, including returned delivered orders
net sales        = gross sales - discounts - refunds
COGS             = sum(quantity x sale-time unit cost)
                   - cost of returned items put back into stock
                   (damaged / not-restocked returns stay in COGS: the cost is lost)
gross profit     = net sales - COGS
operating exp.   = non-voided expenses dated in the period
net profit       = gross profit - operating expenses   ("net operating profit")
```

Assumptions: cancelled sales and undelivered orders are excluded; returns count in the period they are
processed, not the original sale's period; tax is tracked separately and is not part of sales or
profit; "net operating profit" is before income tax, interest and depreciation. Tax is disabled
by default and no tax rates are pre-filled: configure it yourself after checking local
requirements. This software makes no claim of tax compliance.

## Authentication and its limits

- Roles: **admin** (everything) and **cashier** (sell, view catalogue/stock/sales, process returns).
- Passwords are hashed with scrypt with a per-user salt. Plaintext passwords are never stored or logged.
- Permissions are enforced in the main process, not just by hiding screens.
- Limits: this is local, single-machine authentication. Anyone with operating-system access to
  the computer can copy or open the SQLite file directly (it is not encrypted), and anyone with
  the admin password has full control. Use OS user accounts, disk encryption (FileVault /
  BitLocker) and keep backups somewhere safe. There is no password recovery by email: if the only
  admin password is lost, restore from a backup or have another admin reset it.

## Backup and restore

- Settings > Backup: manual backup, optional scheduled backup (interval and number kept), and
  restore from a chosen file.
- Backups use SQLite `VACUUM INTO`, which produces a consistent snapshot even while the database
  is in WAL mode. The app never copies the live `.sqlite` file directly.
- Each backup is validated (opens, integrity check, expected schema) before it is accepted.
- Restore asks for confirmation, takes a **safety backup of the current data first**, validates
  the selected file, swaps it in, and rolls back to the original if the restored file will not
  open or migrate.
- Migrations also take a safety backup before changing an existing database.

## Testing

```bash
npm test
```

Tests run against real SQLite databases (temporary files / in-memory), not mocks. Coverage areas:
database initialisation, migrations, products and duplicate SKUs, variant-level stock, invalid
prices and quantities, atomic checkout and rollback, duplicate-checkout protection, returns and
refund limits, financial calculations, backup and restore, and permission enforcement.

See [docs/TESTING.md](docs/TESTING.md) for the manual end-to-end checklist for macOS and Windows,
and [docs/CHECKLIST.md](docs/CHECKLIST.md) for what is implemented, tested and still open.

## Troubleshooting

**`better-sqlite3` fails to load: "was compiled against a different Node.js version" /
`NODE_MODULE_VERSION` mismatch.** The binary was built for Node, not Electron (or the other way
round). Run `npm run rebuild:native`. Vitest runs under Node and the app runs under Electron;
the bundled N-API prebuilds work in both, so this usually means a stale `node_modules`. Delete
`node_modules` and `renderer/node_modules`, then `npm install`.

**No prebuilt binary / `node-gyp` errors on install.**
- macOS: `xcode-select --install`.
- Windows: install "Desktop development with C++" from Visual Studio Build Tools and Python 3,
  then `npm run rebuild:native`.
- Confirm Node is 22.12 or newer (`node -v`).

**Installed app opens to a blank window.** Run `npm start` from source to see whether it is a
packaging issue. Check `logs/` in the app-data folder.

**Corporate proxy or offline machine during `npm install`.** Configure npm's proxy, or install on
a connected machine. The built app itself needs no network access.

**Linux/headless note.** Electron needs a display (for example `xvfb-run`) and `--no-sandbox` when
run as root in a container. That flag is for container testing only; the app itself enables the
Chromium sandbox.
