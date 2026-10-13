/**
 * Typed contract between the renderer and the main process.
 * Only type information lives here (it is erased at compile time), so the
 * sandboxed preload script can import it without pulling in extra modules.
 * All money values are integer minor units (e.g. cents).
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'INSUFFICIENT_STOCK'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'RETURN_LIMIT'
  | 'IMMUTABLE'
  | 'INTERNAL';

export interface PublicError {
  code: ErrorCode;
  message: string;
  field?: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: PublicError };

export type Role = 'admin' | 'cashier';

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
  electron: string;
  sqlite: string;
  schemaVersion: number;
  databasePath: string;
  logPath: string;
  backupDirectory: string;
  upgradedFromVersion: number | null;
}

/** Settings the UI needs to render money, sizes and shop details. */
export interface DisplaySettings {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  shopEmail: string;
  receiptFooter: string;
  receiptPaperWidthMm: number;
  taxEnabled: boolean;
  taxLabel: string;
  taxRateBps: number;
  currencyCode: string;
  currencySymbol: string;
  currencyDecimals: number;
  locale: string;
  sizes: string[];
  lowStockDefault: number;
  allowNegativeStock: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ───────────── catalogue ─────────────
export interface CategoryDto {
  id: number;
  name: string;
  isActive: boolean;
  productCount: number;
}

export type ProductSort = 'name' | 'sku' | 'category' | 'stock' | 'price' | 'created';

export interface ProductListQuery {
  search?: string;
  categoryId?: number | null;
  status?: 'active' | 'archived' | 'all';
  lowStockOnly?: boolean;
  sort?: ProductSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ProductListItem {
  id: number;
  sku: string;
  name: string;
  brand: string;
  categoryId: number | null;
  categoryName: string | null;
  imageUrl: string | null;
  isActive: boolean;
  variantCount: number;
  totalStock: number;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  lowStockVariants: number;
  createdAt: string;
}

export interface VariantDto {
  id: number;
  productId: number;
  sku: string;
  barcode: string | null;
  size: string;
  colour: string;
  costMinor: number;
  priceMinor: number;
  stockQty: number;
  reorderThreshold: number;
  isActive: boolean;
}

export interface ProductDto {
  id: number;
  sku: string;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  brand: string;
  description: string;
  imageUrl: string | null;
  defaultCostMinor: number;
  defaultPriceMinor: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductDetail {
  product: ProductDto;
  variants: VariantDto[];
}

export interface ProductInput {
  sku: string;
  name: string;
  categoryId: number | null;
  brand: string;
  description: string;
  defaultCostMinor: number;
  defaultPriceMinor: number;
}

export interface VariantInput {
  sku: string;
  barcode?: string | null;
  size: string;
  colour: string;
  costMinor: number;
  priceMinor: number;
  reorderThreshold: number;
  /** Only honoured when creating a variant; recorded as an opening-stock movement. */
  openingStock?: number;
}

export interface CreateProductRequest {
  product: ProductInput;
  variants: VariantInput[];
}

export interface ActivityEntry {
  at: string;
  kind: 'audit' | 'stock';
  actor: string;
  action: string;
  summary: string;
}

// ───────────── dashboard & financials ─────────────
export interface FinancialSummary {
  /** POS line totals plus delivered online order totals before discounts and excluding tax. */
  grossSalesMinor: number;
  discountsMinor: number;
  /** Money refunded on returns processed in the period. */
  refundsMinor: number;
  /** gross − discounts − refunds */
  netSalesMinor: number;
  /** Cost of items sold, less the cost of returned items put back into stock. */
  cogsMinor: number;
  /** net sales − COGS */
  grossProfitMinor: number;
  operatingExpensesMinor: number;
  /** gross profit − operating expenses */
  netProfitMinor: number;
  taxCollectedMinor: number;
  saleCount: number;
}

export interface LowStockItem {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  stockQty: number;
  reorderThreshold: number;
}

export interface RecentSale {
  id: number;
  receiptNo: string;
  createdAt: string;
  totalMinor: number;
  status: 'completed' | 'cancelled';
  customerName: string;
  itemCount: number;
}

export interface BestSeller {
  productId: number;
  name: string;
  unitsSold: number;
  revenueMinor: number;
}

export interface TrendPoint {
  date: string;
  grossSalesMinor: number;
  saleCount: number;
}

export interface DashboardData {
  today: string;
  financials: FinancialSummary;
  totalUnitsInStock: number;
  lowStockCount: number;
  lowStock: LowStockItem[];
  recentSales: RecentSale[];
  bestSellers: BestSeller[];
  trend: TrendPoint[];
}

// ───────────── auth & users ─────────────
export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
}

export interface SessionDto {
  user: SessionUser;
  permissions: string[];
}

export interface AuthStatus {
  needsSetup: boolean;
  session: SessionDto | null;
}

export interface UserDto extends SessionUser {
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

// ───────────── settings ─────────────
export interface SettingsDto {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  shopEmail: string;
  currencyCode: string;
  currencySymbol: string;
  currencyDecimals: number;
  receiptFooter: string;
  receiptPaperWidthMm: number;
  taxEnabled: boolean;
  taxLabel: string;
  taxRateBps: number;
  allowNegativeStock: boolean;
  lowStockDefault: number;
  sizes: string[];
  backupAutoEnabled: boolean;
  backupIntervalHours: number;
  backupKeepCount: number;
  backupDirectory: string;
}

export interface PaymentMethodDto {
  code: string;
  name: string;
  isCash: boolean;
  referenceMode: 'none' | 'optional' | 'required';
  isActive: boolean;
  sortOrder: number;
}
export interface DiscountCodeDto { code: string; kind: 'fixed' | 'percent'; amount: number; minimumMinor: number; usageLimit: number | null; usageCount: number; isActive: boolean }

// ───────────── inventory ─────────────
export type MovementTypeDto =
  | 'opening_stock' | 'purchase_receipt' | 'sale' | 'sale_cancellation' | 'customer_return'
  | 'supplier_return' | 'adjustment_increase' | 'adjustment_decrease' | 'damaged' | 'lost';

export interface MovementQuery {
  variantId?: number;
  type?: MovementTypeDto;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface MovementDto {
  id: number;
  createdAt: string;
  variantId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  type: MovementTypeDto;
  quantityDelta: number;
  balanceAfter: number;
  unitCostMinor: number | null;
  reason: string | null;
  refType: string | null;
  refId: number | null;
  refLabel: string | null;
  username: string | null;
}

export type AdjustKind = 'opening' | 'increase' | 'decrease' | 'damaged' | 'lost';

export interface AdjustStockRequest {
  variantId: number;
  kind: AdjustKind;
  quantity: number;
  reason: string;
}

export interface StockQuery {
  search?: string;
  lowOnly?: boolean;
  categoryId?: number | null;
  page?: number;
  pageSize?: number;
}

export interface StockRow {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  barcode: string | null;
  size: string;
  colour: string;
  categoryName: string | null;
  stockQty: number;
  reservedQty?: number;
  reorderThreshold: number;
  costMinor: number;
  priceMinor: number;
  isActive: boolean;
}

export interface ValuationRow {
  variantId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  stockQty: number;
  costMinor: number;
  priceMinor: number;
  costValueMinor: number;
  retailValueMinor: number;
}

export interface ValuationReport {
  rows: ValuationRow[];
  totalUnits: number;
  totalCostValueMinor: number;
  totalRetailValueMinor: number;
}

// ───────────── suppliers & purchases ─────────────
export interface SupplierDto {
  id: number;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
}

export type SupplierInput = Omit<SupplierDto, 'id' | 'isActive'> & { id?: number; isActive?: boolean };

export interface PurchaseItemDto {
  id: number;
  variantId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  quantity: number;
  unitCostMinor: number;
  lineTotalMinor: number;
}

export interface PurchaseListItem {
  id: number;
  purchaseNo: string;
  supplierId: number;
  supplierName: string;
  status: 'draft' | 'received' | 'cancelled';
  purchaseDate: string;
  totalCostMinor: number;
  itemCount: number;
  receivedAt: string | null;
}

export interface PurchaseDetail extends PurchaseListItem {
  supplierRef: string;
  notes: string;
  items: PurchaseItemDto[];
}

export interface PurchaseQuery {
  status?: 'draft' | 'received' | 'cancelled';
  supplierId?: number;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PurchaseDraftInput {
  id?: number;
  supplierId: number;
  supplierRef: string;
  notes: string;
  purchaseDate: string;
  items: Array<{ variantId: number; quantity: number; unitCostMinor: number }>;
}

export interface SupplierReturnInput {
  supplierId: number;
  purchaseId?: number | null;
  reason: string;
  returnDate: string;
  items: Array<{ variantId: number; quantity: number }>;
}

export interface SupplierReturnDto {
  id: number;
  returnNo: string;
  supplierName: string;
  reason: string;
  returnDate: string;
  totalCostMinor: number;
  itemCount: number;
}

// ───────────── sales / POS ─────────────
export interface PosVariant {
  variantId: number;
  productId: number;
  productName: string;
  sku: string;
  barcode: string | null;
  size: string;
  colour: string;
  priceMinor: number;
  stockQty: number;
  imageUrl: string | null;
}

export interface CheckoutItem {
  variantId: number;
  quantity: number;
  /** Total discount for this line (all units), in minor units. */
  discountMinor: number;
}

export interface CheckoutPayment {
  methodCode: string;
  amountMinor: number;
  /** Cash only: amount handed over (>= amount); change is derived. */
  tenderedMinor?: number | null;
  reference?: string;
}

export interface CheckoutRequest {
  idempotencyKey: string;
  items: CheckoutItem[];
  orderDiscountMinor: number;
  discountCode?: string;
  customerName: string;
  customerPhone: string;
  notes: string;
  payments: CheckoutPayment[];
}

export interface SaleItemDto {
  id: number;
  variantId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  quantity: number;
  unitPriceMinor: number;
  unitCostMinor: number;
  lineDiscountMinor: number;
  orderDiscountShareMinor: number;
  lineNetMinor: number;
  returnedQty: number;
}

export interface PaymentDto {
  id: number;
  methodCode: string;
  methodName: string;
  amountMinor: number;
  tenderedMinor: number | null;
  changeMinor: number | null;
  reference: string;
}

export interface SaleListItem {
  id: number;
  receiptNo: string;
  createdAt: string;
  saleDate: string;
  status: 'completed' | 'cancelled';
  customerName: string;
  cashierName: string;
  totalMinor: number;
  itemCount: number;
  refundedMinor: number;
}

export interface SaleDetail extends SaleListItem {
  customerPhone: string;
  notes: string;
  subtotalMinor: number;
  lineDiscountTotalMinor: number;
  orderDiscountMinor: number;
  taxMinor: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  items: SaleItemDto[];
  payments: PaymentDto[];
}

export interface SaleQuery {
  search?: string;
  from?: string;
  to?: string;
  status?: 'completed' | 'cancelled' | 'all';
  page?: number;
  pageSize?: number;
}

export interface CancelSaleRequest {
  saleId: number;
  reason: string;
  /** Required when the signed-in user lacks permission: an administrator authorises it. */
  override?: { username: string; password: string };
}

export interface ReceiptDto {
  shop: { name: string; address: string; phone: string; email: string; footer: string; paperWidthMm: number };
  currency: { code: string; symbol: string; decimals: number; locale: string };
  taxLabel: string;
  sale: SaleDetail;
}

// ───────────── customer returns ─────────────
export interface ReturnableItem {
  saleItemId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  soldQty: number;
  returnedQty: number;
  remainingQty: number;
  lineNetMinor: number;
  refundedMinor: number;
  remainingRefundMinor: number;
}

export interface ReturnableSale {
  sale: SaleListItem;
  items: ReturnableItem[];
}

export interface CreateReturnRequest {
  saleId: number;
  reason: string;
  notes: string;
  refundMethodCode: string | null;
  items: Array<{
    saleItemId: number;
    quantity: number;
    condition: 'resalable' | 'damaged';
    /** Only honoured when the item is resalable AND the user confirmed it. */
    restock: boolean;
  }>;
}

export interface ReturnDto {
  id: number;
  returnNo: string;
  saleId: number;
  receiptNo: string;
  returnDate: string;
  createdAt: string;
  refundMethodName: string | null;
  refundAmountMinor: number;
  reason: string;
  notes: string;
  username: string;
  items: Array<{
    productName: string;
    size: string;
    colour: string;
    quantity: number;
    refundMinor: number;
    condition: 'resalable' | 'damaged';
    restocked: boolean;
  }>;
}

export interface ReturnQuery {
  saleId?: number;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

// ───────────── expenses ─────────────
export interface ExpenseCategoryDto {
  id: number;
  name: string;
  isActive: boolean;
}

export interface ExpenseDto {
  id: number;
  categoryId: number;
  categoryName: string;
  expenseDate: string;
  amountMinor: number;
  paymentMethodCode: string | null;
  paymentMethodName: string | null;
  notes: string;
  voidedAt: string | null;
  createdBy: string;
}

export interface ExpenseInput {
  id?: number;
  categoryId: number;
  expenseDate: string;
  amountMinor: number;
  paymentMethodCode: string | null;
  notes: string;
}

export interface ExpenseQuery {
  from?: string;
  to?: string;
  categoryId?: number;
  includeVoided?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ExpensePage extends Page<ExpenseDto> {
  totalMinor: number;
}

// ───────────── reports ─────────────
export type ReportGroup = 'day' | 'week' | 'month';

export interface SalesReportRow extends FinancialSummary {
  period: string;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: ReportGroup;
  totals: FinancialSummary;
  rows: SalesReportRow[];
}
export interface OperationsBreakdown {
  payments: Array<{ methodCode:string; methodName:string; amountMinor:number }>;
  deliveredOrders:number; returnedOrders:number; openOrders:number; codPendingMinor:number;
}

export interface PurchaseReportRow {
  purchaseNo: string;
  purchaseDate: string;
  supplierName: string;
  status: string;
  itemCount: number;
  totalCostMinor: number;
}

// ───────────── phone, social and web orders ─────────────
export type OrderSource = 'facebook' | 'instagram' | 'whatsapp' | 'phone' | 'website' | 'walk_in' | 'other';
export type OrderStatus = 'pending' | 'confirmed' | 'cancelled' | 'dispatched' | 'in_transit' | 'delivered' | 'failed' | 'returned';
export interface OrderItemInput { variantId: number; quantity: number }
export interface OrderInput {
  source: OrderSource; customerName: string; customerPhone: string; deliveryAddress: string;
  recipientName: string; recipientPhone: string; paymentMethod: 'cash' | 'card' | 'bank_transfer' | 'cod';
  discountMinor: number; deliveryFeeMinor: number; codAmountMinor: number; notes: string;
  discountCode?: string;
  items: OrderItemInput[];
}
export interface OrderItemDto extends OrderItemInput {
  productName: string; sku: string; size: string; colour: string; unitPriceMinor: number;
}
export interface OrderDto {
  id: number; orderNo: string; source: OrderSource; status: OrderStatus; customerName: string;
  customerPhone: string; deliveryAddress: string; recipientName: string; recipientPhone: string;
  courierName: string; trackingNumber: string; paymentMethod: OrderInput['paymentMethod'];
  paymentStatus: 'unpaid' | 'prepaid' | 'cod_pending' | 'settled' | 'refunded';
  subtotalMinor: number; discountMinor: number; deliveryFeeMinor: number; codAmountMinor: number;
  courierPaidMinor: number; totalMinor: number; notes: string; createdAt: string; deliveredAt:string|null; returnedAt:string|null; items: OrderItemDto[];
}

export type CsvReportName =
  | 'sales' | 'best-sellers' | 'stock-valuation' | 'low-stock' | 'movements' | 'purchases' | 'expenses';

export interface CsvExportRequest {
  report: CsvReportName;
  from?: string;
  to?: string;
  groupBy?: ReportGroup;
}

// ───────────── audit & backups ─────────────
export interface AuditEntry {
  id: number;
  createdAt: string;
  username: string;
  action: string;
  entityType: string;
  entityId: string;
  details: string;
}

export interface AuditQuery {
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface BackupInfo {
  file: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'manual' | 'auto' | 'safety' | 'pre-migration' | 'other';
}

export interface BackupValidation {
  ok: boolean;
  problems: string[];
  schemaVersion: number | null;
  createdAt: string | null;
  sizeBytes: number;
}

export interface BackupPick {
  file: string;
  name: string;
  validation: BackupValidation;
}

export interface RestoreResult {
  safetyBackup: string;
  restoredFrom: string;
}

export type ActionOutcome = { saved: boolean; path?: string };

type R<T> = Promise<IpcResult<T>>;

export interface MaisonApi {
  app: {
    getInfo(): R<AppInfo>;
  };
  auth: {
    status(): R<AuthStatus>;
    setupAdmin(req: { username: string; displayName: string; password: string }): R<SessionDto>;
    login(req: { username: string; password: string }): R<SessionDto>;
    logout(): R<null>;
    changePassword(req: { currentPassword: string; newPassword: string }): R<null>;
    listUsers(): R<UserDto[]>;
    createUser(req: { username: string; displayName: string; role: Role; password: string }): R<UserDto>;
    updateUser(req: { id: number; displayName: string; role: Role; isActive: boolean }): R<UserDto>;
    resetPassword(req: { id: number; newPassword: string }): R<null>;
  };
  settings: {
    getDisplay(): R<DisplaySettings>;
    get(): R<SettingsDto>;
    update(patch: Partial<SettingsDto>): R<SettingsDto>;
    listPaymentMethods(includeInactive?: boolean): R<PaymentMethodDto[]>;
    savePaymentMethod(req: Omit<PaymentMethodDto, 'sortOrder'> & { sortOrder?: number }): R<PaymentMethodDto[]>;
    listDiscountCodes(): R<DiscountCodeDto[]>;
    saveDiscountCode(req: Omit<DiscountCodeDto, 'usageCount'>): R<DiscountCodeDto[]>;
  };
  dashboard: {
    get(): R<DashboardData>;
  };
  catalog: {
    listCategories(): R<CategoryDto[]>;
    saveCategory(req: { id?: number; name: string; isActive?: boolean }): R<CategoryDto>;
    listProducts(query: ProductListQuery): R<Page<ProductListItem>>;
    getProduct(id: number): R<ProductDetail>;
    checkSku(req: { sku: string; excludeProductId?: number | null }): R<{ available: boolean }>;
    createProduct(req: CreateProductRequest): R<ProductDetail>;
    updateProduct(req: { id: number; product: ProductInput }): R<ProductDetail>;
    setProductArchived(req: { id: number; archived: boolean }): R<ProductDetail>;
    createVariant(req: { productId: number; variant: VariantInput }): R<ProductDetail>;
    updateVariant(req: { id: number; variant: Omit<VariantInput, 'openingStock'> }): R<ProductDetail>;
    setVariantArchived(req: { id: number; archived: boolean }): R<ProductDetail>;
    getHistory(productId: number): R<ActivityEntry[]>;
    pickProductImage(productId: number): R<ProductDetail | null>;
    removeProductImage(productId: number): R<ProductDetail>;
  };
  inventory: {
    listStock(query: StockQuery): R<Page<StockRow>>;
    listMovements(query: MovementQuery): R<Page<MovementDto>>;
    adjust(req: AdjustStockRequest): R<StockRow>;
    valuation(): R<ValuationReport>;
  };
  suppliers: {
    list(includeInactive?: boolean): R<SupplierDto[]>;
    save(req: SupplierInput): R<SupplierDto>;
  };
  purchases: {
    list(query: PurchaseQuery): R<Page<PurchaseListItem>>;
    get(id: number): R<PurchaseDetail>;
    saveDraft(req: PurchaseDraftInput): R<PurchaseDetail>;
    receive(req: { id: number; updateCosts: boolean }): R<PurchaseDetail>;
    cancel(id: number): R<PurchaseDetail>;
    createSupplierReturn(req: SupplierReturnInput): R<SupplierReturnDto>;
    listSupplierReturns(query: { page?: number; pageSize?: number }): R<Page<SupplierReturnDto>>;
  };
  sales: {
    previewDiscount(req: { code: string; subtotalMinor: number }): R<{ discountMinor: number }>;
    lookup(req: { query: string }): R<PosVariant[]>;
    scan(req: { code: string }): R<PosVariant | null>;
    checkout(req: CheckoutRequest): R<SaleDetail>;
    list(query: SaleQuery): R<Page<SaleListItem>>;
    get(id: number): R<SaleDetail>;
    receipt(id: number): R<ReceiptDto>;
    cancel(req: CancelSaleRequest): R<SaleDetail>;
  };
  orders: {
    list(query: { search?: string; status?: OrderStatus; page?: number; pageSize?: number }): R<Page<OrderDto>>;
    create(input: OrderInput): R<OrderDto>;
    updateStatus(req: { id: number; status: OrderStatus; courierName?: string; trackingNumber?: string }): R<OrderDto>;
    settleCourier(req: { id: number; amountMinor: number; reference: string }): R<OrderDto>;
  };
  returns: {
    getReturnable(saleId: number): R<ReturnableSale>;
    create(req: CreateReturnRequest): R<ReturnDto>;
    list(query: ReturnQuery): R<Page<ReturnDto>>;
  };
  expenses: {
    list(query: ExpenseQuery): R<ExpensePage>;
    save(req: ExpenseInput): R<ExpenseDto>;
    void(id: number): R<ExpenseDto>;
    listCategories(): R<ExpenseCategoryDto[]>;
    saveCategory(req: { id?: number; name: string; isActive?: boolean }): R<ExpenseCategoryDto[]>;
  };
  reports: {
    sales(req: { from: string; to: string; groupBy: ReportGroup }): R<SalesReport>;
    bestSellers(req: { from: string; to: string; limit?: number }): R<BestSeller[]>;
    lowStock(): R<StockRow[]>;
    purchases(req: { from: string; to: string }): R<PurchaseReportRow[]>;
    operations(req: { from:string; to:string }): R<OperationsBreakdown>;
    exportCsv(req: CsvExportRequest): R<ActionOutcome>;
  };
  audit: {
    list(query: AuditQuery): R<Page<AuditEntry>>;
  };
  backup: {
    list(): R<BackupInfo[]>;
    create(): R<BackupInfo>;
    chooseDirectory(): R<string | null>;
    pickFile(): R<BackupPick | null>;
    validate(file: string): R<BackupValidation>;
    restore(file: string): R<RestoreResult>;
    runIntegrityCheck(): R<{ ok: boolean; messages: string[] }>;
  };
}
