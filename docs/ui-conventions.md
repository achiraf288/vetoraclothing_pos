# Vetora POS — renderer conventions

Angular 21, **standalone components, zoneless** (no zone.js). Strict TypeScript and strict templates.

## Rules
- **State = signals.** Zoneless: after any `await`, update a `signal(...)`; never rely on plain fields for async data
  (event handlers/`ngModel` changes are fine). Use `computed`, `input()`, `output()`, `inject()`, `@if/@for/@switch`.
- **Always `@for (...; track x.id)`.**
- **Data access** only via `inject(ApiService).api`, a typed, promise-based, error-throwing view of the preload bridge
  (`window.maison`): `await this.api.catalog.listProducts({...})` returns the data directly and throws `ApiError`.
  Show failures with `inject(ToastService).error(messageOf(e))` or inline notices. Never import `electron` or Node modules.
  Types come from `@shared/api` (`import type { ... } from '@shared/api'`).
- **Money is integer minor units everywhere.** Display with the `money` pipe (`{{ x | money }}`) or `SettingsStore.money()`;
  parse user text with `SettingsStore.parse()` (returns `null` if invalid); use `<app-money-input [(ngModel)]="minor">` for inputs.
  Never use floats for totals. Percentages are basis points (`percentOfMinor` logic lives in the backend).
- **Dates:** business dates are local `YYYY-MM-DD` (`core/dates.ts`: `today()`, `startOfMonth()` …); timestamps are UTC ISO
  strings shown with `| dateTime`; business dates with `| bizDate`.
- **Permissions:** `inject(SessionService).can('inventory.adjust')` to show/hide actions. The server enforces them too.
- **Destructive actions** need `inject(ConfirmService).ask({ title, message, confirmLabel, danger: true })` first.
- **Forms:** Reactive Forms or template-driven; show field errors after touch; disable submit while busy to prevent double
  submits; map `ApiError.field` to the field when present.
- **Every list page has** a loading state (`<app-loading>`), an empty state (`<app-empty-state>`), an error notice, and
  pagination (`<app-pagination>`) where the API pages. Search inputs are debounced (`core/util.ts#debounce`).
- **Accessibility:** real `<button>`/`<label for>`; icon-only buttons need `aria-label`; modals use `<app-modal>`.
- **Styling:** use global classes from `src/styles.scss` (`card`, `card-head`, `btn btn-primary|accent|danger|ghost btn-sm`,
  `input`, `select`, `textarea`, `field`, `form-grid`, `table`, `badge badge-ok|warn|bad|info`, `notice notice-*`, `tabs`/`tab`,
  `kpi`, `grid grid-2|3|4`, `stack`, `row`, `toolbar`, `muted`, `num`) and design tokens (`var(--accent)` …). Component
  styles stay small. Page headings use `<app-page-header title subtitle><div actions>…</div></app-page-header>`.
  Palette: cream #F7F4EE, charcoal #282821, beige borders, clay accent. No gradients, no gratuitous animation.
- No remote fonts, scripts, images or CDNs: the app is fully offline and CSP forbids them.
- Product images are served from `maison://app/product-images/<file>` (the API returns ready-to-use `imageUrl`s).

## Layout
`src/app/core` services/helpers · `src/app/ui` shared components · `src/app/features/<area>` pages (`*.page.ts`).
Routes are declared in `src/app/app.routes.ts` and already point at each page file/class name.

## Checking your work
`cd renderer && NG_BUILD_CACHE=0 npx ng build --configuration development --output-path <your scratch dir>`
must compile without errors in your files.
