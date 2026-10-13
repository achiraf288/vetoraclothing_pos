import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { SaleListItem } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { PaginationComponent } from '../../ui/pagination.component';
import { ReceiptDialogComponent } from './receipt-dialog.component';
import { SessionService } from '../../core/session.service';

@Component({selector:'app-sales-page',imports:[FormsModule,DatePipe,RouterLink,PageHeaderComponent,PaginationComponent,ReceiptDialogComponent],template:`
 <app-page-header title="Sales" subtitle="Receipts, completed checkouts and sale history."><div actions><a class="btn btn-primary" routerLink="/pos">New sale</a></div></app-page-header>
 @if(error()){<div class="notice notice-bad">{{error()}}</div>}<section class="card"><div class="toolbar"><input class="input" placeholder="Search receipt, customer or phone" [(ngModel)]="search" (ngModelChange)="load(1)"/><select class="select" [(ngModel)]="status" (ngModelChange)="load(1)"><option value="all">All</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select><label>From <input class="input" type="date" [(ngModel)]="from" (ngModelChange)="load(1)" /></label><label>To <input class="input" type="date" [(ngModel)]="to" (ngModelChange)="load(1)" /></label></div>
 @if(rows().length){<div class="table-wrap"><table class="table"><thead><tr><th>Receipt</th><th>Date</th><th>Customer</th><th>Cashier</th><th>Items</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>@for(s of rows();track s.id){<tr><td><a class="strong" [routerLink]="['/sales',s.id]">{{s.receiptNo}}</a></td><td>{{s.createdAt|date:'short'}}</td><td>{{s.customerName||'Walk-in'}}</td><td>{{s.cashierName}}</td><td>{{s.itemCount}}</td><td class="num">{{settings.money(s.totalMinor)}}</td><td>{{s.status}}</td><td><button class="btn btn-sm" (click)="receiptId.set(s.id)">Receipt</button></td></tr>}</tbody></table></div><app-pagination [page]="page()" [pageSize]="pageSize" [total]="total()" (pageChange)="load($event)"/>} @else {<div class="empty">No sales found for these filters.</div>}</section>
 @if(receiptId();as id){<app-receipt-dialog [saleId]="id" (closed)="receiptId.set(null)"/>}
`,styles:`.toolbar{display:flex;align-items:end;gap:10px;padding:12px;flex-wrap:wrap}.toolbar>.input{min-width:240px}.toolbar label{display:grid;gap:4px;font-size:11px}.num{text-align:right}.empty{padding:40px;text-align:center;color:var(--ink-3)}.strong{font-weight:600}`})
export class SalesPage {
 private readonly api=inject(ApiService).api;protected readonly settings=inject(SettingsStore);protected readonly session=inject(SessionService);
 protected readonly rows=signal<SaleListItem[]>([]);protected readonly total=signal(0);protected readonly page=signal(1);protected readonly receiptId=signal<number|null>(null);protected readonly error=signal('');protected readonly pageSize=25;
 protected search='';protected status:'all'|'completed'|'cancelled'='all';protected from='';protected to='';
 constructor(){void this.load();}
 protected async load(page=1){this.error.set('');try{const result=await this.api.sales.list({search:this.search||undefined,status:this.status,from:this.from||undefined,to:this.to||undefined,page,pageSize:this.pageSize});this.rows.set(result.items);this.total.set(result.total);this.page.set(result.page);}catch(e){this.error.set(messageOf(e));}}
}
