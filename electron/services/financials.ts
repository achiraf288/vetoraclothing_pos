import type { Db } from '../db/connection';
import type { FinancialSummary } from '../shared/api';

/**
 * Financial definitions (single source of truth for dashboard and reports).
 * Period = inclusive range of LOCAL business dates (YYYY-MM-DD).
 *
 *  gross sales      = completed POS sales and delivered customer orders in the period
 *  discounts        = line and order discounts on those transactions
 *  refunds          = POS refunds and returned delivered orders in the period processed
 *  net sales        = gross sales − discounts − refunds
 *  COGS             = Σ quantity × sale-time unit cost of those sales
 *                     − cost of returned items that were put back into stock (restocked)
 *                     (damaged / not-restocked returns stay in COGS: the cost is lost)
 *  gross profit     = net sales − COGS
 *  operating exp.   = non-voided expenses dated in the period
 *  net profit       = gross profit − operating expenses   ("net operating profit")
 *
 * Cancelled sales are excluded entirely. Tax is tracked separately and is NOT
 * part of sales or profit. Returns are counted in the period they are
 * processed, not the period of the original sale.
 */
export function computeFinancials(db: Db, from: string, to: string): FinancialSummary {
  const sales = db
    .prepare(
      `SELECT COUNT(*)                              AS sale_count,
              COALESCE(SUM(s.subtotal_minor), 0)     AS gross,
              COALESCE(SUM(s.line_discount_total_minor + s.order_discount_minor), 0) AS discounts,
              COALESCE(SUM(s.tax_minor), 0)          AS tax
         FROM sales s
        WHERE s.status = 'completed' AND s.sale_date BETWEEN ? AND ?`,
    )
    .get(from, to) as { sale_count: number; gross: number; discounts: number; tax: number };

  const orders = db.prepare(`SELECT COUNT(*) AS sale_count,COALESCE(SUM(o.subtotal_minor+o.delivery_fee_minor),0) AS gross,
      COALESCE(SUM(o.discount_minor),0) AS discounts
    FROM orders o WHERE o.delivered_date BETWEEN ? AND ?`).get(from,to) as {sale_count:number;gross:number;discounts:number};

  const cogsSold = (
    db
      .prepare(
        `SELECT COALESCE(SUM(si.quantity * si.unit_cost_minor), 0) AS v
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.status = 'completed' AND s.sale_date BETWEEN ? AND ?`,
      )
      .get(from, to) as { v: number }
  ).v;
  const orderCogsSold=(db.prepare(`SELECT COALESCE(SUM(oi.quantity*oi.unit_cost_minor),0) AS v FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.delivered_date BETWEEN ? AND ?`).get(from,to) as {v:number}).v;

  const refunds = (
    db
      .prepare(
        `SELECT COALESCE(SUM(r.refund_amount_minor), 0) AS v
           FROM returns r JOIN sales s ON s.id = r.sale_id
          WHERE s.status = 'completed' AND r.return_date BETWEEN ? AND ?`,
      )
      .get(from, to) as { v: number }
  ).v;
  const orderRefunds=(db.prepare(`SELECT COALESCE(SUM(o.subtotal_minor-o.discount_minor+o.delivery_fee_minor),0) AS v FROM orders o
    WHERE o.returned_date BETWEEN ? AND ?`).get(from,to) as {v:number}).v;

  const cogsRecovered = (
    db
      .prepare(
        `SELECT COALESCE(SUM(ri.quantity * si.unit_cost_minor), 0) AS v
           FROM return_items ri
           JOIN returns r     ON r.id = ri.return_id
           JOIN sale_items si ON si.id = ri.sale_item_id
           JOIN sales s       ON s.id = r.sale_id
          WHERE ri.restocked = 1 AND s.status = 'completed' AND r.return_date BETWEEN ? AND ?`,
      )
      .get(from, to) as { v: number }
  ).v;
  const orderCogsRecovered=(db.prepare(`SELECT COALESCE(SUM(oi.quantity*oi.unit_cost_minor),0) AS v FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.delivered_date IS NOT NULL AND o.returned_date BETWEEN ? AND ?`).get(from,to) as {v:number}).v;

  const expenses = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS v FROM expenses
          WHERE voided_at IS NULL AND expense_date BETWEEN ? AND ?`,
      )
      .get(from, to) as { v: number }
  ).v;

  const netSales = sales.gross + orders.gross - sales.discounts - orders.discounts - refunds - orderRefunds;
  const cogs = cogsSold + orderCogsSold - cogsRecovered - orderCogsRecovered;
  const grossProfit = netSales - cogs;
  return {
    grossSalesMinor: sales.gross + orders.gross,
    discountsMinor: sales.discounts + orders.discounts,
    refundsMinor: refunds + orderRefunds,
    netSalesMinor: netSales,
    cogsMinor: cogs,
    grossProfitMinor: grossProfit,
    operatingExpensesMinor: expenses,
    netProfitMinor: grossProfit - expenses,
    taxCollectedMinor: sales.tax,
    saleCount: sales.sale_count + orders.sale_count,
  };
}
