import type { Db } from '../db/connection';
import { localDate } from '../db/sequence';
import type { BestSeller, DashboardData, LowStockItem, RecentSale, TrendPoint } from '../shared/api';
import { computeFinancials } from './financials';
import { assertCan, type Actor } from './permissions';

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

export class DashboardService {
  constructor(private readonly db: Db) {}

  get(actor: Actor, now: Date = new Date()): DashboardData {
    assertCan(actor, 'dashboard.read');
    const today = localDate(now);
    const trendStart = addDays(today, -13);
    const bestFrom = addDays(today, -29);

    const stock = this.db
      .prepare(
        `SELECT COALESCE(SUM(v.stock_qty), 0) AS units,
                COALESCE(SUM(CASE WHEN v.stock_qty-COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0) <= v.reorder_threshold THEN 1 ELSE 0 END), 0) AS low
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE v.is_active = 1 AND p.is_active = 1`,
      )
      .get() as { units: number; low: number };

    const lowStock = (
      this.db
        .prepare(
          `SELECT v.id AS variantId, p.id AS productId, p.name AS productName, v.sku, v.size, v.colour,
                  MAX(0,v.stock_qty-COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0)) AS stockQty, v.reorder_threshold AS reorderThreshold
             FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE v.is_active = 1 AND p.is_active = 1 AND (v.stock_qty-COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.variant_id=v.id AND o.status IN ('confirmed','dispatched','in_transit','failed')),0)) <= v.reorder_threshold
            ORDER BY (v.stock_qty - v.reorder_threshold), p.name COLLATE NOCASE
            LIMIT 8`,
        )
        .all() as LowStockItem[]
    );

    const recentSales = (
      this.db
        .prepare(
          `SELECT s.id, s.receipt_no AS receiptNo, s.created_at AS createdAt, s.total_minor AS totalMinor,
                  s.status, s.customer_name AS customerName,
                  COALESCE((SELECT SUM(quantity) FROM sale_items WHERE sale_id = s.id), 0) AS itemCount
             FROM sales s ORDER BY s.id DESC LIMIT 8`,
        )
        .all() as RecentSale[]
    );

    const bestSellers = (
      this.db
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
           ) GROUP BY productId HAVING unitsSold>0 ORDER BY unitsSold DESC,revenueMinor DESC LIMIT 5`,
        )
        .all(bestFrom, today, bestFrom, today) as BestSeller[]
    );

    const byDay = new Map(
      (
        this.db
          .prepare(
            `SELECT date AS date,SUM(grossSalesMinor) AS grossSalesMinor,SUM(saleCount) AS saleCount FROM (
               SELECT sale_date AS date,COALESCE(SUM(subtotal_minor),0) AS grossSalesMinor,COUNT(*) AS saleCount
                 FROM sales WHERE status='completed' AND sale_date BETWEEN ? AND ? GROUP BY sale_date
               UNION ALL
               SELECT delivered_date AS date,COALESCE(SUM(subtotal_minor+delivery_fee_minor),0) AS grossSalesMinor,COUNT(*) AS saleCount
                 FROM orders WHERE delivered_date BETWEEN ? AND ? GROUP BY delivered_date
             ) GROUP BY date`,
          )
          .all(trendStart, today, trendStart, today) as TrendPoint[]
      ).map((r) => [r.date, r]),
    );
    const trend: TrendPoint[] = [];
    for (let i = 0; i < 14; i++) {
      const date = addDays(trendStart, i);
      trend.push(byDay.get(date) ?? { date, grossSalesMinor: 0, saleCount: 0 });
    }

    return {
      today,
      financials: computeFinancials(this.db, today, today),
      totalUnitsInStock: stock.units,
      lowStockCount: stock.low,
      lowStock,
      recentSales,
      bestSellers,
      trend,
    };
  }
}
