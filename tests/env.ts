import { AuthService } from '../electron/services/auth-service';
import { CatalogService } from '../electron/services/catalog-service';
import { DashboardService } from '../electron/services/dashboard-service';
import { ExpenseService } from '../electron/services/expense-service';
import { InventoryService } from '../electron/services/inventory-service';
import type { Actor } from '../electron/services/permissions';
import { PurchasingService } from '../electron/services/purchasing-service';
import { AuditService, ReportService } from '../electron/services/report-service';
import { ReturnsService } from '../electron/services/returns-service';
import { SalesService } from '../electron/services/sales-service';
import { SettingsService } from '../electron/services/settings-service';
import type { CheckoutRequest, SaleDetail } from '../electron/shared/api';
import { memoryDb } from './helpers';

export const ADMIN_PASSWORD = 'correct horse battery';
export const CASHIER_PASSWORD = 'cashier-password-1';

let keyCounter = 0;
export const newKey = (): string => `test-key-${++keyCounter}-${Math.random().toString(36).slice(2, 10)}`;

/** A fully wired set of services over an in-memory database, with an admin and a cashier. */
export function makeEnv() {
  const db = memoryDb();
  const auth = new AuthService(db);
  auth.setupAdmin({ username: 'owner', displayName: 'Shop Owner', password: ADMIN_PASSWORD });
  const admin: Actor = auth.requireActor();
  const cashierUser = auth.createUser(admin, { username: 'cashier1', displayName: 'Cashier One', role: 'cashier', password: CASHIER_PASSWORD });
  const cashier: Actor = { userId: cashierUser.id, username: 'cashier1', role: 'cashier' };

  const settings = new SettingsService(db);
  const catalog = new CatalogService(db);
  const inventory = new InventoryService(db);
  const purchasing = new PurchasingService(db);
  const sales = new SalesService(db, auth);
  const returns = new ReturnsService(db);
  const expenses = new ExpenseService(db);
  const reports = new ReportService(db, inventory);
  const dashboard = new DashboardService(db);
  const audit = new AuditService(db);

  let skuN = 0;
  /** Creates a product with one variant and opening stock. Returns ids. */
  function seedVariant(opts: { name?: string; size?: string; colour?: string; cost?: number; price?: number; stock?: number; reorder?: number; barcode?: string | null } = {}) {
    skuN++;
    const detail = catalog.createProduct(admin, {
      product: {
        sku: `P-${skuN}`,
        name: opts.name ?? `Product ${skuN}`,
        categoryId: null,
        brand: '',
        description: '',
        defaultCostMinor: opts.cost ?? 100_000,
        defaultPriceMinor: opts.price ?? 250_000,
      },
      variants: [
        {
          sku: `V-${skuN}`,
          barcode: opts.barcode ?? null,
          size: opts.size ?? 'M',
          colour: opts.colour ?? 'Black',
          costMinor: opts.cost ?? 100_000,
          priceMinor: opts.price ?? 250_000,
          reorderThreshold: opts.reorder ?? 2,
          openingStock: opts.stock ?? 10,
        },
      ],
    });
    return { productId: detail.product.id, variantId: detail.variants[0].id };
  }

  function sell(
    items: Array<{ variantId: number; quantity: number; discountMinor?: number }>,
    extra: Partial<CheckoutRequest> & { cash?: boolean } = {},
    actor: Actor = cashier,
  ): SaleDetail {
    const total = items.reduce((a, i) => {
      const v = db.prepare('SELECT price_minor FROM product_variants WHERE id = ?').get(i.variantId) as { price_minor: number };
      return a + v.price_minor * i.quantity - (i.discountMinor ?? 0);
    }, 0) - (extra.orderDiscountMinor ?? 0);
    const tax = settings.getDisplay().taxEnabled ? Math.round((total * settings.getDisplay().taxRateBps) / 10_000) : 0;
    return sales.checkout(actor, {
      idempotencyKey: newKey(),
      items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, discountMinor: i.discountMinor ?? 0 })),
      orderDiscountMinor: 0,
      customerName: '',
      customerPhone: '',
      notes: '',
      payments: [{ methodCode: 'cash', amountMinor: total + tax }],
      ...extra,
    });
  }

  const stock = (variantId: number): number =>
    (db.prepare('SELECT stock_qty AS q FROM product_variants WHERE id = ?').get(variantId) as { q: number }).q;
  const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  return { db, auth, admin, cashier, settings, catalog, inventory, purchasing, sales, returns, expenses, reports, dashboard, audit, seedVariant, sell, stock, count };
}

export type Env = ReturnType<typeof makeEnv>;
