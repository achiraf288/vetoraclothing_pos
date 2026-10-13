import type { Db } from '../db/connection';
import { localDate, nextDocumentNumber } from '../db/sequence';
import { writeAudit } from '../db/audit';
import { AppError } from '../main/errors';
import type { OrderDto, OrderInput, OrderStatus, Page } from '../shared/api';
import { recordMovement } from './inventory-core';
import { assertCan, type Actor } from './permissions';
import { escapeLike, nonNegativeMinor, pageParams, positiveInt, text } from './validate';

const ACTIVE_RESERVATION = "status IN ('confirmed','dispatched','in_transit','failed')";
export class OrdersService {
  constructor(private readonly db: Db) {}

  list(actor: Actor, query: { search?: string; status?: OrderStatus; page?: number; pageSize?: number } = {}): Page<OrderDto> {
    assertCan(actor, 'sales.read');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.status) { where.push('o.status = ?'); args.push(query.status); }
    if (query.search?.trim()) {
      const like = `%${escapeLike(query.search.trim())}%`;
      where.push("(o.order_no LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR o.customer_phone LIKE ? ESCAPE '\\' OR o.tracking_number LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM orders o ${filter}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT o.id FROM orders o ${filter} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, offset) as Array<{ id: number }>;
    return { items: rows.map((r) => this.get(r.id)), total, page, pageSize };
  }

  create(actor: Actor, input: OrderInput): OrderDto {
    assertCan(actor, 'sales.create');
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new AppError('VALIDATION', 'Add between 1 and 100 order lines.', 'items');
    const customer = text(input.customerName, 'Customer name', 120, true);
    const phone = text(input.customerPhone, 'Customer phone', 60, true);
    const discount = nonNegativeMinor(input.discountMinor, 'Discount');
    const discountCode = text(input.discountCode ?? '', 'Discount code', 32).toUpperCase();
    const delivery = nonNegativeMinor(input.deliveryFeeMinor, 'Delivery fee');
    const cod = nonNegativeMinor(input.codAmountMinor, 'COD amount');
    const lines = new Map<number, number>();
    for (const item of input.items) lines.set(item.variantId, (lines.get(item.variantId) ?? 0) + positiveInt(item.quantity, 'Quantity'));
    const orderId = this.db.transaction(() => {
      const priced = [...lines].map(([variantId, quantity]) => {
        const variant = this.db.prepare(`SELECT v.id,v.sku,v.size,v.colour,v.price_minor,v.cost_minor,p.name,v.is_active,p.is_active AS product_active
          FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=?`).get(variantId) as
          { id:number;sku:string;size:string;colour:string;price_minor:number;cost_minor:number;name:string;is_active:number;product_active:number } | undefined;
        if (!variant || !variant.is_active || !variant.product_active) throw new AppError('VALIDATION', 'An order item is unavailable.');
        return { ...variant, quantity };
      });
      const subtotal = priced.reduce((sum, line) => sum + line.quantity * line.price_minor, 0);
      let codeDiscount=0;
      if(discountCode){
        const code=this.db.prepare('SELECT kind,amount,minimum_minor,usage_limit,usage_count,is_active FROM discount_codes WHERE code=?').get(discountCode) as {kind:'fixed'|'percent';amount:number;minimum_minor:number;usage_limit:number|null;usage_count:number;is_active:number}|undefined;
        if(!code||!code.is_active)throw new AppError('VALIDATION','That discount code is invalid or inactive.','discountCode');
        if(subtotal<code.minimum_minor)throw new AppError('VALIDATION','The order does not meet this code’s minimum spend.','discountCode');
        if(code.usage_limit!==null&&code.usage_count>=code.usage_limit)throw new AppError('VALIDATION','That discount code has reached its usage limit.','discountCode');
        codeDiscount=Math.min(subtotal,code.kind==='fixed'?code.amount:Math.floor(subtotal*code.amount/10_000));
      }
      const totalDiscount=discount+codeDiscount;
      if (totalDiscount > subtotal) throw new AppError('VALIDATION', 'Discount exceeds the items subtotal.');
      const total = subtotal - totalDiscount + delivery;
      if (input.paymentMethod === 'cod' ? cod !== total : cod !== 0) throw new AppError('VALIDATION', 'COD amount must equal the full order total for cash-on-delivery orders.');
      const id = Number(this.db.prepare(`INSERT INTO orders(order_no,source,customer_name,customer_phone,delivery_address,recipient_name,recipient_phone,
        payment_method,payment_status,subtotal_minor,discount_minor,delivery_fee_minor,cod_amount_minor,notes,created_by,order_date,discount_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nextDocumentNumber(this.db,'ORD'), input.source, customer, phone,
        text(input.deliveryAddress,'Delivery address',500), text(input.recipientName,'Recipient name',120), text(input.recipientPhone,'Recipient phone',60),
        input.paymentMethod, input.paymentMethod === 'cod' ? 'cod_pending' : 'prepaid', subtotal, totalDiscount, delivery, cod,
        text(input.notes,'Notes',1000), actor.userId,localDate(),discountCode).lastInsertRowid);
      const insert = this.db.prepare(`INSERT INTO order_items(order_id,variant_id,product_name,sku,size,colour,quantity,unit_price_minor,unit_cost_minor) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const line of priced) insert.run(id,line.id,line.name,line.sku,line.size,line.colour,line.quantity,line.price_minor,line.cost_minor);
      if(discountCode)this.db.prepare('UPDATE discount_codes SET usage_count=usage_count+1 WHERE code=?').run(discountCode);
      writeAudit(this.db,actor,'order.create','order',id,{source:input.source,subtotal,total});
      return id;
    }).immediate();
    return this.get(orderId);
  }

  updateStatus(actor: Actor, req: { id: number; status: OrderStatus; courierName?: string; trackingNumber?: string }): OrderDto {
    assertCan(actor, 'sales.create');
    this.db.transaction(() => {
      const order = this.db.prepare('SELECT status,payment_status FROM orders WHERE id=?').get(req.id) as { status: OrderStatus; payment_status:string } | undefined;
      if (!order) throw new AppError('NOT_FOUND','Order not found.');
      const allowed: Record<OrderStatus, OrderStatus[]> = {
        pending:['confirmed','cancelled'], confirmed:['dispatched','cancelled'], cancelled:[], dispatched:['in_transit','delivered','failed'],
        in_transit:['delivered','failed'], delivered:['returned'], failed:['dispatched','cancelled','returned'], returned:[],
      };
      if (!allowed[order.status].includes(req.status)) throw new AppError('CONFLICT',`Cannot move an order from ${order.status} to ${req.status}.`);
      if (req.status === 'confirmed') {
        const items = this.db.prepare(`SELECT oi.variant_id,oi.quantity,v.stock_qty,
          COALESCE((SELECT SUM(r.quantity) FROM order_items r JOIN orders ro ON ro.id=r.order_id WHERE r.variant_id=oi.variant_id AND ro.${ACTIVE_RESERVATION} AND ro.id<>?),0) AS reserved
          FROM order_items oi JOIN product_variants v ON v.id=oi.variant_id WHERE oi.order_id=?`).all(req.id,req.id) as Array<{variant_id:number;quantity:number;stock_qty:number;reserved:number}>;
        for (const i of items) if (i.stock_qty-i.reserved < i.quantity) throw new AppError('INSUFFICIENT_STOCK','There is not enough unreserved stock to confirm this order.');
      }
      const courier = text(req.courierName ?? '', 'Courier', 100);
      const tracking = text(req.trackingNumber ?? '', 'Tracking number', 100);
      if (req.status === 'dispatched' && (!courier || !tracking)) throw new AppError('VALIDATION','Choose a courier and enter the parcel tracking number before dispatch.');
      if (req.status === 'delivered') {
        const items = this.db.prepare('SELECT variant_id,quantity FROM order_items WHERE order_id=?').all(req.id) as Array<{variant_id:number;quantity:number}>;
        for (const item of items) recordMovement(this.db,{variantId:item.variant_id,type:'sale',quantityDelta:-item.quantity,refType:'manual',refId:req.id,userId:actor.userId,reason:'Online order fulfilled'});
        if (order.status !== 'delivered') this.db.prepare("UPDATE orders SET payment_status=CASE WHEN payment_method='cod' THEN 'cod_pending' ELSE payment_status END WHERE id=?").run(req.id);
      }
      if (req.status === 'returned' && order.status === 'delivered') {
        const items = this.db.prepare('SELECT variant_id,quantity FROM order_items WHERE order_id=?').all(req.id) as Array<{variant_id:number;quantity:number}>;
        for (const item of items) recordMovement(this.db,{variantId:item.variant_id,type:'customer_return',quantityDelta:item.quantity,refType:'manual',refId:req.id,userId:actor.userId,reason:'Courier parcel returned'});
      }
      this.db.prepare('UPDATE orders SET status=?,returned_at=CASE WHEN ?=\'returned\' THEN strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') ELSE returned_at END,delivered_at=CASE WHEN ?=\'delivered\' THEN strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') ELSE delivered_at END,refunded_at=CASE WHEN ? IN (\'cancelled\',\'returned\') AND payment_status=\'prepaid\' THEN strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') ELSE refunded_at END,refund_amount_minor=CASE WHEN ? IN (\'cancelled\',\'returned\') AND payment_status=\'prepaid\' THEN subtotal_minor-discount_minor+delivery_fee_minor ELSE refund_amount_minor END,payment_status=CASE WHEN ? IN (\'cancelled\',\'returned\') AND payment_status=\'prepaid\' THEN \'refunded\' ELSE payment_status END,courier_name=CASE WHEN ?<>\'\' THEN ? ELSE courier_name END,tracking_number=CASE WHEN ?<>\'\' THEN ? ELSE tracking_number END,updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?')
        .run(req.status,req.status,req.status,req.status,req.status,req.status,courier,courier,tracking,tracking,req.id);
      if(req.status==='delivered')this.db.prepare('UPDATE orders SET delivered_date=? WHERE id=?').run(localDate(),req.id);
      if(req.status==='returned')this.db.prepare('UPDATE orders SET returned_date=?,refunded_date=CASE WHEN ?=1 THEN ? ELSE refunded_date END WHERE id=?').run(localDate(),order.payment_status==='prepaid'?1:0,localDate(),req.id);
      if(req.status==='cancelled'&&order.payment_status==='prepaid')this.db.prepare('UPDATE orders SET refunded_date=? WHERE id=?').run(localDate(),req.id);
      writeAudit(this.db,actor,'order.status','order',req.id,{from:order.status,to:req.status,courier,tracking});
    }).immediate();
    return this.get(req.id);
  }

  settleCourier(actor: Actor, req: { id:number; amountMinor:number; reference:string }): OrderDto {
    assertCan(actor,'reports.read');
    this.db.transaction(() => {
      const o = this.db.prepare('SELECT status,payment_method,cod_amount_minor,courier_paid_minor FROM orders WHERE id=?').get(req.id) as
        {status:OrderStatus;payment_method:string;cod_amount_minor:number;courier_paid_minor:number}|undefined;
      if (!o) throw new AppError('NOT_FOUND','Order not found.');
      const amount = nonNegativeMinor(req.amountMinor,'Settlement amount');
      if (o.payment_method !== 'cod' || !['delivered','returned'].includes(o.status) || amount <= 0 || amount > o.cod_amount_minor-o.courier_paid_minor) throw new AppError('VALIDATION','Enter a positive settlement up to the outstanding COD amount for a delivered COD order.');
      const reference = text(req.reference,'Reference',100);
      this.db.prepare('INSERT INTO courier_settlements(order_id,amount_minor,reference,received_by,received_date) VALUES(?,?,?,?,?)').run(req.id,amount,reference,actor.userId,localDate());
      this.db.prepare('UPDATE orders SET courier_paid_minor=courier_paid_minor+?,payment_status=CASE WHEN courier_paid_minor+?=cod_amount_minor THEN \'settled\' ELSE \'cod_pending\' END,updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?').run(amount,amount,req.id);
      writeAudit(this.db,actor,'courier.settlement','order',req.id,{amount,reference});
    }).immediate();
    return this.get(req.id);
  }

  private get(id:number): OrderDto {
    const r = this.db.prepare('SELECT * FROM orders WHERE id=?').get(id) as Record<string,any>|undefined;
    if (!r) throw new AppError('NOT_FOUND','Order not found.');
    const items = this.db.prepare('SELECT variant_id AS variantId,product_name AS productName,sku,size,colour,quantity,unit_price_minor AS unitPriceMinor FROM order_items WHERE order_id=? ORDER BY id').all(id) as OrderDto['items'];
    return {id:r.id,orderNo:r.order_no,source:r.source,status:r.status,customerName:r.customer_name,customerPhone:r.customer_phone,
      deliveryAddress:r.delivery_address,recipientName:r.recipient_name,recipientPhone:r.recipient_phone,courierName:r.courier_name,trackingNumber:r.tracking_number,
      paymentMethod:r.payment_method,paymentStatus:r.payment_status,subtotalMinor:r.subtotal_minor,discountMinor:r.discount_minor,deliveryFeeMinor:r.delivery_fee_minor,
      codAmountMinor:r.cod_amount_minor,courierPaidMinor:r.courier_paid_minor,totalMinor:r.subtotal_minor-r.discount_minor+r.delivery_fee_minor,notes:r.notes,createdAt:r.created_at,deliveredAt:r.delivered_at,returnedAt:r.returned_at,items};
  }
}
