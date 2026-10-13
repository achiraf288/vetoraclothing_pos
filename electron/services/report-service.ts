import type { Db } from '../db/connection';
import { localDate } from '../db/sequence';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type {
  AuditEntry,
  AuditQuery,
  BestSeller,
  CsvExportRequest,
  Page,
  PurchaseReportRow,
  ReportGroup,
  SalesReport,
  SalesReportRow,
  StockRow,
} from '../shared/api';
import { plainMoney, toCsv, type CsvCell } from './csv';
import { computeFinancials } from './financials';
import type { InventoryService } from './inventory-service';
import { assertCan, type Actor } from './permissions';
import { dateRange, escapeLike, pageParams } from './validate';

const MAX_DAYS = 731;

function parse(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}
const addDays = (d: string, n: number): string => {
  const t = parse(d);
  t.setDate(t.getDate() + n);
  return localDate(t);
};

/** Splits [from, to] into reporting periods (weeks start on Monday), clipped to the range. */
export function buildPeriods(from: string, to: string, groupBy: ReportGroup): Array<{ label: string; from: string; to: string }> {
  const out: Array<{ label: string; from: string; to: string }> = [];
  let cursor = from;
  while (cursor <= to) {
    let end: string;
    let label: string;
    if (groupBy === 'day') {
      end = cursor;
      label = cursor;
    } else if (groupBy === 'week') {
      const dow = (parse(cursor).getDay() + 6) % 7;
      end = addDays(cursor, 6 - dow);
      label = addDays(cursor, -dow);
    } else {
      const d = parse(cursor);
      end = localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      label = cursor.slice(0, 7);
    }
    if (end > to) end = to;
    out.push({ label, from: cursor, to: end });
    cursor = addDays(end, 1);
  }
  return out;
}

const localStamp = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * Reports. All figures use the single definition set in financials.ts:
 *   net sales = gross − discounts − refunds;  gross profit = net sales − COGS;
 *   net operating profit = gross profit − operating expenses.
 */
export class ReportService {
  private readonly settings: SettingsRepo;

  constructor(
    private readonly db: Db,
    private readonly inventory: InventoryService,
  ) {
    this.settings = new SettingsRepo(db);
  }

  sales(actor: Actor, req: { from: string; to: string; groupBy: ReportGroup }): SalesReport {
    assertCan(actor, 'reports.read');
    const { from, to } = dateRange(req.from, req.to);
    if (!['day', 'week', 'month'].includes(req.groupBy)) throw new AppError('VALIDATION', 'Choose day, week or month.', 'groupBy');
    const days = Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000) + 1;
    if (days > MAX_DAYS) throw new AppError('VALIDATION', 'Choose a range of two years or less.', 'to');
    const rows: SalesReportRow[] = buildPeriods(from, to, req.groupBy).map((p) => ({
      period: p.label,
      ...computeFinancials(this.db, p.from, p.to),
    }));
    return { from, to, groupBy: req.groupBy, totals: computeFinancials(this.db, from, to), rows };
  }

  bestSellers(actor: Actor, req: { from: string; to: string; limit?: number }): BestSeller[] {
    assertCan(actor, 'reports.read');
    const { from, to } = dateRange(req.from, req.to);
    const limit = Number.isInteger(req.limit) ? Math.min(Math.max(req.limit as number, 1), 100) : 10;
    return this.db
      .prepare(
        `SELECT productId,name,SUM(unitsSold) AS unitsSold,SUM(revenueMinor) AS revenueMinor FROM (
           SELECT p.id AS productId,p.name,SUM(si.quantity)-COALESCE(SUM((SELECT SUM(ri.quantity) FROM return_items ri WHERE ri.sale_item_id=si.id)),0) AS unitsSold,
             SUM(si.line_net_minor)-COALESCE(SUM((SELECT SUM(ri.refund_minor) FROM return_items ri WHERE ri.sale_item_id=si.id)),0) AS revenueMinor
             FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN product_variants v ON v.id=si.variant_id JOIN products p ON p.id=v.product_id
             WHERE s.status='completed' AND s.sale_date BETWEEN ? AND ? GROUP BY p.id
           UNION ALL
           SELECT p.id AS productId,p.name,SUM(oi.quantity) AS unitsSold,
             SUM(oi.quantity*oi.unit_price_minor)-SUM(CASE WHEN o.subtotal_minor>0 THEN CAST(o.discount_minor*(oi.quantity*oi.unit_price_minor)/o.subtotal_minor AS INTEGER) ELSE 0 END) AS revenueMinor
             FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN product_variants v ON v.id=oi.variant_id JOIN products p ON p.id=v.product_id
             WHERE o.delivered_date BETWEEN ? AND ? AND o.returned_date IS NULL GROUP BY p.id
         ) GROUP BY productId HAVING unitsSold>0 ORDER BY unitsSold DESC,revenueMinor DESC LIMIT ?`,
      )
      .all(from, to, from, to, limit) as BestSeller[];
  }

  lowStock(actor: Actor): StockRow[] {
    return this.inventory.listLowStock(actor);
  }

  purchases(actor: Actor, req: { from: string; to: string }): PurchaseReportRow[] {
    assertCan(actor, 'reports.read');
    const { from, to } = dateRange(req.from, req.to);
    return this.db
      .prepare(
        `SELECT pu.purchase_no AS purchaseNo, pu.purchase_date AS purchaseDate, s.name AS supplierName, pu.status,
                (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = pu.id) AS itemCount,
                pu.total_cost_minor AS totalCostMinor
           FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
          WHERE pu.purchase_date BETWEEN ? AND ? ORDER BY pu.purchase_date, pu.id`,
      )
      .all(from, to) as PurchaseReportRow[];
  }

  operations(actor: Actor, req:{from:string;to:string}): import('../shared/api').OperationsBreakdown {
    assertCan(actor,'reports.read');
    const {from,to}=dateRange(req.from,req.to);
    const payments=this.db.prepare(`SELECT x.methodCode,pm.name AS methodName,SUM(x.amountMinor) AS amountMinor FROM (
      SELECT p.method_code AS methodCode,p.amount_minor AS amountMinor FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.status='completed' AND p.payment_date BETWEEN ? AND ?
      UNION ALL SELECT o.payment_method,o.subtotal_minor-o.discount_minor+o.delivery_fee_minor FROM orders o WHERE o.payment_method<>'cod' AND o.payment_status IN ('prepaid','refunded') AND o.order_date BETWEEN ? AND ?
      UNION ALL SELECT o.payment_method,-o.refund_amount_minor FROM orders o WHERE o.payment_method<>'cod' AND o.refund_amount_minor>0 AND o.refunded_date BETWEEN ? AND ?
      UNION ALL SELECT 'cod',cs.amount_minor FROM courier_settlements cs WHERE cs.received_date BETWEEN ? AND ?
      UNION ALL SELECT r.refund_method_code,-r.refund_amount_minor FROM returns r JOIN sales s ON s.id=r.sale_id WHERE s.status='completed' AND r.refund_method_code IS NOT NULL AND r.return_date BETWEEN ? AND ?
    ) x JOIN payment_methods pm ON pm.code=x.methodCode GROUP BY x.methodCode,pm.name ORDER BY pm.name`).all(from,to,from,to,from,to,from,to,from,to) as import('../shared/api').OperationsBreakdown['payments'];
    const rows=this.db.prepare(`SELECT SUM(CASE WHEN delivered_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN returned_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS returned,
      SUM(CASE WHEN order_date BETWEEN ? AND ? AND status IN ('pending','confirmed','dispatched','in_transit','failed') THEN 1 ELSE 0 END) AS open,
      COALESCE(SUM(CASE WHEN delivered_date BETWEEN ? AND ? AND status IN ('delivered','returned') AND payment_method='cod' THEN cod_amount_minor-courier_paid_minor ELSE 0 END),0) AS pending
      FROM orders`).get(from,to,from,to,from,to,from,to) as {delivered:number|null;returned:number|null;open:number|null;pending:number};
    return {payments,deliveredOrders:rows.delivered??0,returnedOrders:rows.returned??0,openOrders:rows.open??0,codPendingMinor:rows.pending};
  }

  // ───────────── CSV ─────────────
  buildCsv(actor: Actor, req: CsvExportRequest): { fileName: string; content: string } {
    assertCan(actor, 'reports.read');
    const dec = this.settings.getInt('currency.decimals', 2);
    const m = (v: number): string => plainMoney(v, dec);
    const today = localDate();
    const range = (): { from: string; to: string } => dateRange(req.from ?? today, req.to ?? today);
    const suffix = (r: { from: string; to: string }): string => `${r.from}_to_${r.to}`;

    switch (req.report) {
      case 'sales': {
        const r = range();
        const rep = this.sales(actor, { ...r, groupBy: req.groupBy ?? 'day' });
        const row = (label: string, f: SalesReportRow): CsvCell[] => [
          label, f.saleCount, m(f.grossSalesMinor), m(f.discountsMinor), m(f.refundsMinor), m(f.netSalesMinor),
          m(f.cogsMinor), m(f.grossProfitMinor), m(f.operatingExpensesMinor), m(f.netProfitMinor), m(f.taxCollectedMinor),
        ];
        return {
          fileName: `sales-by-${rep.groupBy}_${suffix(r)}.csv`,
          content: toCsv(
            [req.groupBy === 'month' ? 'Month' : req.groupBy === 'week' ? 'Week starting' : 'Date', 'Sales', 'Gross sales', 'Discounts', 'Refunds', 'Net sales', 'Cost of goods sold', 'Gross profit', 'Operating expenses', 'Net operating profit', 'Tax collected'],
            [...rep.rows.map((x) => row(x.period, x)), row('TOTAL', { period: 'TOTAL', ...rep.totals })],
          ),
        };
      }
      case 'best-sellers': {
        const r = range();
        return {
          fileName: `best-sellers_${suffix(r)}.csv`,
          content: toCsv(['Product', 'Units sold (net of returns)', 'Net revenue'], this.bestSellers(actor, { ...r, limit: 100 }).map((b) => [b.name, b.unitsSold, m(b.revenueMinor)])),
        };
      }
      case 'stock-valuation': {
        const v = this.inventory.valuation(actor);
        return {
          fileName: `stock-valuation_${today}.csv`,
          content: toCsv(
            ['Product', 'SKU', 'Size', 'Colour', 'Quantity', 'Unit cost', 'Unit price', 'Cost value', 'Retail value'],
            [
              ...v.rows.map((x) => [x.productName, x.sku, x.size, x.colour, x.stockQty, m(x.costMinor), m(x.priceMinor), m(x.costValueMinor), m(x.retailValueMinor)]),
              ['TOTAL', '', '', '', v.totalUnits, '', '', m(v.totalCostValueMinor), m(v.totalRetailValueMinor)],
            ],
          ),
        };
      }
      case 'low-stock':
        return {
          fileName: `low-stock_${today}.csv`,
          content: toCsv(['Product', 'SKU', 'Size', 'Colour', 'In stock', 'Reorder level'], this.lowStock(actor).map((s) => [s.productName, s.sku, s.size, s.colour, s.stockQty, s.reorderThreshold])),
        };
      case 'movements': {
        const r = range();
        const page = this.inventory.listMovements(actor, { from: r.from, to: r.to }, true);
        if (page.total > 100_000) throw new AppError('VALIDATION', 'That range has too many movements to export; choose a shorter range.');
        return {
          fileName: `inventory-movements_${suffix(r)}.csv`,
          content: toCsv(
            ['Date and time', 'Product', 'SKU', 'Size', 'Colour', 'Type', 'Quantity change', 'Balance after', 'Unit cost', 'Reason', 'Reference', 'User'],
            page.items.map((x) => [localStamp(x.createdAt), x.productName, x.sku, x.size, x.colour, x.type.replace(/_/g, ' '), x.quantityDelta, x.balanceAfter, x.unitCostMinor === null ? '' : m(x.unitCostMinor), x.reason, x.refLabel, x.username]),
          ),
        };
      }
      case 'purchases': {
        const r = range();
        return {
          fileName: `purchases_${suffix(r)}.csv`,
          content: toCsv(['Purchase', 'Date', 'Supplier', 'Status', 'Lines', 'Total cost'], this.purchases(actor, r).map((p) => [p.purchaseNo, p.purchaseDate, p.supplierName, p.status, p.itemCount, m(p.totalCostMinor)])),
        };
      }
      case 'expenses': {
        const r = range();
        const rows = this.db
          .prepare(
            `SELECT e.expense_date, c.name AS category, e.amount_minor, pm.name AS method, e.notes, e.voided_at
               FROM expenses e JOIN expense_categories c ON c.id = e.category_id
               LEFT JOIN payment_methods pm ON pm.code = e.payment_method_code
              WHERE e.expense_date BETWEEN ? AND ? ORDER BY e.expense_date, e.id`,
          )
          .all(r.from, r.to) as Array<{ expense_date: string; category: string; amount_minor: number; method: string | null; notes: string; voided_at: string | null }>;
        return {
          fileName: `expenses_${suffix(r)}.csv`,
          content: toCsv(['Date', 'Category', 'Amount', 'Payment method', 'Notes', 'Voided'], rows.map((x) => [x.expense_date, x.category, m(x.amount_minor), x.method, x.notes, x.voided_at ? 'yes' : ''])),
        };
      }
      default:
        throw new AppError('VALIDATION', 'Unknown report.', 'report');
    }
  }
}

export class AuditService {
  constructor(private readonly db: Db) {}

  list(actor: Actor, query: AuditQuery = {}): Page<AuditEntry> {
    assertCan(actor, 'audit.read');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize, 200);
    const where: string[] = [];
    const params: unknown[] = [];
    const search = query.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push(`(action LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR entity_type LIKE ? ESCAPE '\\' OR entity_id LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }
    if (query.from && query.to) {
      const r = dateRange(query.from, query.to);
      const [y1, m1, d1] = r.from.split('-').map(Number);
      const [y2, m2, d2] = r.to.split('-').map(Number);
      where.push('created_at >= ? AND created_at < ?');
      params.push(new Date(y1, m1 - 1, d1).toISOString(), new Date(y2, m2 - 1, d2 + 1).toISOString());
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${w}`).get(...params) as { n: number }).n;
    const items = this.db
      .prepare(
        `SELECT id, created_at AS createdAt, username, action, entity_type AS entityType, entity_id AS entityId, details
           FROM audit_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset) as AuditEntry[];
    return { items, total, page, pageSize };
  }
}
