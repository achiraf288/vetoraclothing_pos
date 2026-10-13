import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { AuditEntry } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { PaginationComponent } from '../../ui/pagination.component';

@Component({selector:'app-audit-page',imports:[DatePipe,FormsModule,PageHeaderComponent,PaginationComponent],template:`
 <app-page-header title="Activity log" subtitle="A record of sales, inventory changes and administrative actions."/>@if(error()){<div class="notice notice-bad">{{error()}}</div>}
 <section class="card"><div class="toolbar"><input class="input" placeholder="Search activity, user or record" [(ngModel)]="search" (ngModelChange)="load(1)"/><label>From<input class="input" type="date" [(ngModel)]="from" (ngModelChange)="load(1)"/></label><label>To<input class="input" type="date" [(ngModel)]="to" (ngModelChange)="load(1)"/></label></div>@if(rows().length){<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>User</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>@for(r of rows();track r.id){<tr><td>{{r.createdAt|date:'short'}}</td><td>{{r.username}}</td><td>{{r.action}}</td><td>{{r.entityType}} {{r.entityId}}</td><td>{{r.details}}</td></tr>}</tbody></table></div><app-pagination [page]="page()" [pageSize]="25" [total]="total()" (pageChange)="load($event)"/>} @else{<p class="empty">No activity found.</p>}</section>
`,styles:`.toolbar{display:flex;align-items:end;gap:10px;padding:12px;flex-wrap:wrap}.toolbar>.input{min-width:240px}.toolbar label{display:grid;gap:4px;font-size:11px}.empty{padding:30px;text-align:center}`})
export class AuditPage {
 private readonly api=inject(ApiService).api;protected readonly rows=signal<AuditEntry[]>([]);protected readonly total=signal(0);protected readonly page=signal(1);protected readonly error=signal('');protected search='';protected from='';protected to='';
 constructor(){void this.load();}protected async load(page=1){try{const r=await this.api.audit.list({search:this.search,from:this.from||undefined,to:this.to||undefined,page,pageSize:25});this.rows.set(r.items);this.total.set(r.total);this.page.set(r.page);}catch(e){this.error.set(messageOf(e));}}
}
