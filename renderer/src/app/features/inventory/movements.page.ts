import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { MovementDto, MovementTypeDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { PaginationComponent } from '../../ui/pagination.component';

@Component({selector:'app-movements-page',imports:[FormsModule,DatePipe,PageHeaderComponent,PaginationComponent],template:`
 <app-page-header title="Stock movements" subtitle="Every purchase, sale, return and manual stock adjustment." />@if(error()){<div class="notice notice-bad">{{error()}}</div>}
 <section class="card"><div class="toolbar"><input class="input" placeholder="Search product, SKU or reason" [(ngModel)]="search" (ngModelChange)="load(1)"/><select class="select" [(ngModel)]="type" (ngModelChange)="load(1)"><option value="">All movement types</option>@for(t of types;track t){<option [value]="t">{{label(t)}}</option>}</select><label>From<input class="input" type="date" [(ngModel)]="from" (ngModelChange)="load(1)"/></label><label>To<input class="input" type="date" [(ngModel)]="to" (ngModelChange)="load(1)"/></label></div>@if(rows().length){<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Product / variant</th><th>Type</th><th>Change</th><th>Balance</th><th>Reference / reason</th><th>User</th></tr></thead><tbody>@for(m of rows();track m.id){<tr><td>{{m.createdAt|date:'short'}}</td><td><b>{{m.productName}}</b><div class="muted small">{{m.sku}} · {{m.size}} {{m.colour}}</div></td><td>{{label(m.type)}}</td><td [class.positive]="m.quantityDelta>0" [class.negative]="m.quantityDelta<0">{{m.quantityDelta>0?'+':''}}{{m.quantityDelta}}</td><td>{{m.balanceAfter}}</td><td>{{m.refLabel||m.reason||'—'}}</td><td>{{m.username||'System'}}</td></tr>}</tbody></table></div><app-pagination [page]="page()" [pageSize]="25" [total]="total()" (pageChange)="load($event)"/>} @else{<div class="empty">No stock movements found.</div>}</section>
`,styles:`.toolbar{display:flex;gap:9px;align-items:end;padding:12px;flex-wrap:wrap}.toolbar>.input{min-width:210px}.toolbar label{display:grid;gap:4px;font-size:11px}.small{font-size:11px}.positive{color:#2f794d}.negative{color:#a04d27}.empty{padding:40px;text-align:center;color:var(--ink-3)}`})
export class MovementsPage {
 private readonly api=inject(ApiService).api;protected readonly settings=inject(SettingsStore);protected readonly rows=signal<MovementDto[]>([]);protected readonly total=signal(0);protected readonly page=signal(1);protected readonly error=signal('');
 protected search='';protected type:MovementTypeDto|''='';protected from='';protected to='';protected readonly types:MovementTypeDto[]=['opening_stock','purchase_receipt','sale','sale_cancellation','customer_return','supplier_return','adjustment_increase','adjustment_decrease','damaged','lost'];
 constructor(){void this.load();}protected async load(page=1){try{const r=await this.api.inventory.listMovements({search:this.search,type:this.type||undefined,from:this.from||undefined,to:this.to||undefined,page,pageSize:25});this.rows.set(r.items);this.total.set(r.total);this.page.set(r.page);}catch(e){this.error.set(messageOf(e));}}
 protected label(v:string){return v.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
}
