import { z } from 'zod';

/**
 * Zod schemas for every IPC channel. They enforce shape, type and size limits at
 * the process boundary; the services then enforce business rules.
 * Money is always an integer number of minor units.
 */

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const minor = z.number().int().min(0).max(100_000_000_000);
const qty = z.number().int().min(1).max(1_000_000);
const str = (max: number) => z.string().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.');
const page = z.number().int().min(1).max(1_000_000).optional();
const pageSize = z.number().int().min(1).max(500).optional();
const optDate = isoDate.optional();

export const none = z.undefined();
export const idOnly = id;
export const optBool = z.boolean().optional();

export const auth = {
  setupAdmin: z.object({ username: str(40), displayName: str(80), password: str(200) }),
  login: z.object({ username: str(40), password: str(200) }),
  changePassword: z.object({ currentPassword: str(200), newPassword: str(200) }),
  createUser: z.object({ username: str(40), displayName: str(80), role: z.enum(['admin', 'cashier']), password: str(200) }),
  updateUser: z.object({ id, displayName: str(80), role: z.enum(['admin', 'cashier']), isActive: z.boolean() }),
  resetPassword: z.object({ id, newPassword: str(200) }),
};

export const settings = {
  update: z.object({
    shopName: str(120), shopAddress: str(300), shopPhone: str(60), shopEmail: str(120),
    currencyCode: str(8), currencySymbol: str(8), currencyDecimals: z.number().int().min(0).max(4),
    receiptFooter: str(300), receiptPaperWidthMm: z.number().int().min(40).max(120),
    taxEnabled: z.boolean(), taxLabel: str(40), taxRateBps: z.number().int().min(0).max(10_000),
    allowNegativeStock: z.boolean(), lowStockDefault: z.number().int().min(0).max(100_000),
    sizes: z.array(str(20)).max(40),
    backupAutoEnabled: z.boolean(), backupIntervalHours: z.number().int().min(1).max(24 * 31),
    backupKeepCount: z.number().int().min(1).max(365), backupDirectory: str(500),
  }).partial(),
  savePaymentMethod: z.object({
    code: z.string().regex(/^[a-z0-9_]{1,30}$/, 'Code may use lowercase letters, digits and underscores.'),
    name: str(60), isCash: z.boolean(), referenceMode: z.enum(['none', 'optional', 'required']),
    isActive: z.boolean(), sortOrder: z.number().int().min(0).max(1000).optional(),
  }),
  saveDiscountCode: z.object({ code:z.string().regex(/^[A-Za-z0-9_-]{2,32}$/), kind:z.enum(['fixed','percent']), amount:z.number().int().min(1).max(10000), minimumMinor:minor, usageLimit:z.number().int().min(1).nullable(), isActive:z.boolean() }),
};

const namedSave = z.object({ id: id.optional(), name: str(80), isActive: z.boolean().optional() });

const productInput = z.object({
  sku: str(60), name: str(160), categoryId: id.nullable(), brand: str(80), description: str(2000),
  defaultCostMinor: minor, defaultPriceMinor: minor,
});
const variantInput = z.object({
  sku: str(60), barcode: str(60).nullable().optional(), size: str(20), colour: str(40),
  costMinor: minor, priceMinor: minor, reorderThreshold: z.number().int().min(0).max(100_000),
});

export const catalog = {
  saveCategory: namedSave,
  listProducts: z.object({
    search: str(100).optional(), categoryId: id.nullable().optional(),
    status: z.enum(['active', 'archived', 'all']).optional(), lowStockOnly: z.boolean().optional(),
    sort: z.enum(['name', 'sku', 'category', 'stock', 'price', 'created']).optional(),
    dir: z.enum(['asc', 'desc']).optional(), page, pageSize,
  }),
  checkSku: z.object({ sku: str(60), excludeProductId: id.nullable().optional() }),
  createProduct: z.object({
    product: productInput,
    variants: z.array(variantInput.extend({ openingStock: z.number().int().min(0).max(1_000_000).optional() })).max(200),
  }),
  updateProduct: z.object({ id, product: productInput }),
  setArchived: z.object({ id, archived: z.boolean() }),
  createVariant: z.object({
    productId: id,
    variant: variantInput.extend({ openingStock: z.number().int().min(0).max(1_000_000).optional() }),
  }),
  updateVariant: z.object({ id, variant: variantInput }),
};

export const inventory = {
  listStock: z.object({ search: str(100).optional(), lowOnly: z.boolean().optional(), categoryId: id.nullable().optional(), page, pageSize }),
  listMovements: z.object({
    variantId: id.optional(),
    type: z.enum(['opening_stock', 'purchase_receipt', 'sale', 'sale_cancellation', 'customer_return', 'supplier_return', 'adjustment_increase', 'adjustment_decrease', 'damaged', 'lost']).optional(),
    search: str(100).optional(), from: optDate, to: optDate, page, pageSize,
  }),
  adjust: z.object({ variantId: id, kind: z.enum(['opening', 'increase', 'decrease', 'damaged', 'lost']), quantity: qty, reason: str(300) }),
};

export const suppliers = {
  save: z.object({
    id: id.optional(), name: str(120), contactName: str(120), phone: str(60), email: str(120),
    address: str(300), notes: str(1000), isActive: z.boolean().optional(),
  }),
};

export const purchases = {
  list: z.object({ status: z.enum(['draft', 'received', 'cancelled']).optional(), supplierId: id.optional(), from: optDate, to: optDate, page, pageSize }),
  saveDraft: z.object({
    id: id.optional(), supplierId: id, supplierRef: str(80), notes: str(1000), purchaseDate: isoDate,
    items: z.array(z.object({ variantId: id, quantity: qty, unitCostMinor: minor })).min(1).max(500),
  }),
  receive: z.object({ id, updateCosts: z.boolean() }),
  supplierReturn: z.object({
    supplierId: id, purchaseId: id.nullable().optional(), reason: str(300), returnDate: isoDate,
    items: z.array(z.object({ variantId: id, quantity: qty })).min(1).max(500),
  }),
  listSupplierReturns: z.object({ page, pageSize }),
};

export const sales = {
  previewDiscount: z.object({ code:str(32), subtotalMinor:minor }),
  lookup: z.object({ query: str(100) }),
  scan: z.object({ code: str(100) }),
  checkout: z.object({
    idempotencyKey: z.string().min(8).max(80),
    items: z.array(z.object({ variantId: id, quantity: qty, discountMinor: minor })).min(1).max(300),
    orderDiscountMinor: minor, discountCode: str(32).optional(), customerName: str(120), customerPhone: str(60), notes: str(500),
    payments: z.array(z.object({
      methodCode: str(30), amountMinor: minor, tenderedMinor: minor.nullable().optional(), reference: str(80).optional(),
    })).min(1).max(6),
  }),
  list: z.object({ search: str(60).optional(), from: optDate, to: optDate, status: z.enum(['completed', 'cancelled', 'all']).optional(), page, pageSize }),
  cancel: z.object({
    saleId: id, reason: str(300),
    override: z.object({ username: str(40), password: str(200) }).optional(),
  }),
};

export const orders = {
  list: z.object({ search: str(100).optional(), status: z.enum(['pending','confirmed','cancelled','dispatched','in_transit','delivered','failed','returned']).optional(), page, pageSize }),
  create: z.object({
    source: z.enum(['facebook','instagram','whatsapp','phone','website','walk_in','other']),
    customerName: str(120), customerPhone: str(60), deliveryAddress: str(500), recipientName: str(120), recipientPhone: str(60),
    paymentMethod: z.enum(['cash','card','bank_transfer','cod']), discountMinor: minor, deliveryFeeMinor: minor, codAmountMinor: minor, discountCode:str(32).optional(),
    notes: str(1000), items: z.array(z.object({ variantId:id, quantity:qty })).min(1).max(100),
  }),
  updateStatus: z.object({ id, status:z.enum(['pending','confirmed','cancelled','dispatched','in_transit','delivered','failed','returned']), courierName:str(100).optional(), trackingNumber:str(100).optional() }),
  settleCourier: z.object({ id, amountMinor:minor, reference:str(100) }),
};

export const returns = {
  create: z.object({
    saleId: id, reason: str(300), notes: str(500), refundMethodCode: str(30).nullable(),
    items: z.array(z.object({
      saleItemId: id, quantity: qty, condition: z.enum(['resalable', 'damaged']), restock: z.boolean(),
    })).min(1).max(300),
  }),
  list: z.object({ saleId: id.optional(), from: optDate, to: optDate, page, pageSize }),
};

export const expenses = {
  list: z.object({ from: optDate, to: optDate, categoryId: id.optional(), includeVoided: z.boolean().optional(), page, pageSize }),
  save: z.object({
    id: id.optional(), categoryId: id, expenseDate: isoDate, amountMinor: minor,
    paymentMethodCode: str(30).nullable(), notes: str(500),
  }),
  saveCategory: namedSave,
};

export const reports = {
  sales: z.object({ from: isoDate, to: isoDate, groupBy: z.enum(['day', 'week', 'month']) }),
  bestSellers: z.object({ from: isoDate, to: isoDate, limit: z.number().int().min(1).max(100).optional() }),
  purchases: z.object({ from: isoDate, to: isoDate }),
  operations: z.object({ from:isoDate, to:isoDate }),
  exportCsv: z.object({
    report: z.enum(['sales', 'best-sellers', 'stock-valuation', 'low-stock', 'movements', 'purchases', 'expenses']),
    from: optDate, to: optDate, groupBy: z.enum(['day', 'week', 'month']).optional(),
  }),
};

export const audit = {
  list: z.object({ search: str(100).optional(), from: optDate, to: optDate, page, pageSize }),
};

export const backup = {
  file: str(1024),
};
