import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { SaleDetail } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { ReceiptDialogComponent } from './receipt-dialog.component';
import { SessionService } from '../../core/session.service';

@Component({selector:'app-sale-detail-page',imports:[DatePipe,RouterLink,PageHeaderComponent,ReceiptDialogComponent],template:`
 @if(sale();as s){<app-page-header [title]="s.receiptNo" [subtitle]="(s.createdAt|date:'medium')+' · '+(s.customerName||'Walk-in customer')"><div actions><button class="btn" (click)="receiptOpen.set(true)">Print receipt</button><a class="btn" routerLink="/sales">Back to sales</a>@if(s.status==='completed'&&session.can('sales.cancel')){<button class="btn btn-danger" (click)="cancel()">Cancel sale</button>}</div></app-page-header>
 @if(error()){<div class="notice notice-bad">{{error()}}</div>}<section class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>Qty</th><th>Unit price</th><th>Discount</th><th class="num">Net</th></tr></thead><tbody>@for(i of s.items;track i.id){<tr><td>{{i.productName}}<div class="muted small">{{i.sku}} · {{i.size}} {{i.colour}}</div></td><td>{{i.quantity}}</td><td>{{settings.money(i.unitPriceMinor)}}</td><td>{{settings.money(i.lineDiscountMinor+i.orderDiscountShareMinor)}}</td><td class="num">{{settings.money(i.lineNetMinor)}}</td></tr>}</tbody></table></div><div class="summary"><p><span>Subtotal</span><b>{{settings.money(s.subtotalMinor)}}</b></p><p><span>Discounts</span><b>−{{settings.money(s.lineDiscountTotalMinor+s.orderDiscountMinor)}}</b></p><p><span>Tax</span><b>{{settings.money(s.taxMinor)}}</b></p><p class="total"><span>Total</span><b>{{settings.money(s.totalMinor)}}</b></p><p><span>Status</span><b>{{s.status}}</b></p></div><h2>Payments</h2><div class="table-wrap"><table class="table"><thead><tr><th>Method</th><th>Reference</th><th>Amount</th><th>Cash tendered</th><th>Change</th></tr></thead><tbody>@for(p of s.payments;track p.id){<tr><td>{{p.methodName}}</td><td>{{p.reference||'—'}}</td><td>{{settings.money(p.amountMinor)}}</td><td>{{p.tenderedMinor===null?'—':settings.money(p.tenderedMinor)}}</td><td>{{p.changeMinor===null?'—':settings.money(p.changeMinor)}}</td></tr>}</tbody></table></div>@if(s.refundedMinor){<p class="refund">Refunded to date: {{settings.money(s.refundedMinor)}}</p>}</section>}
 @if(receiptOpen()){<app-receipt-dialog [saleId]="saleId" (closed)="receiptOpen.set(false)"/>}
`,styles:`.summary{padding:16px 20px;max-width:430px;margin-left:auto}.summary p{display:flex;justify-content:space-between;margin:8px 0}.total{border-top:1px solid var(--beige);padding-top:10px;font-size:18px}.card h2{font:600 18px var(--font-serif);padding:14px 18px 8px}.refund{padding:12px 18px;color:#8a4c18}.small{font-size:11px}.num{text-align:right}`})
export class SaleDetailPage {
 private readonly api=inject(ApiService).api;private readonly route=inject(ActivatedRoute);protected readonly settings=inject(SettingsStore);protected readonly session=inject(SessionService);
 protected readonly sale=signal<SaleDetail|null>(null);protected readonly error=signal('');protected readonly receiptOpen=signal(false);protected readonly saleId=Number(this.route.snapshot.paramMap.get('id'));
 constructor(){void this.load();}private async load(){try{this.sale.set(await this.api.sales.get(this.saleId));}catch(e){this.error.set(messageOf(e));}}
 protected async cancel(){const reason=window.prompt('Reason for cancelling this sale:');if(!reason?.trim())return;try{const s=await this.api.sales.cancel({saleId:this.saleId,reason});this.sale.set(s);}catch(e){this.error.set(messageOf(e));}}
}
