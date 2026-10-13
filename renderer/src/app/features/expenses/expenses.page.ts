import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { ExpenseCategoryDto, ExpenseDto, PaymentMethodDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { startOfMonth, today } from '../../core/dates';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-expenses-page',imports:[FormsModule,DatePipe,PageHeaderComponent],template:`
 <app-page-header title="Expenses" subtitle="Record operating expenses for accurate profit reporting."><div actions><button class="btn btn-primary" (click)="showForm.set(!showForm())">{{showForm()?'Close':'Add expense'}}</button></div></app-page-header>
 @if(error()){<div class="notice notice-bad">{{error()}}</div>}
 @if(showForm()){<section class="card form"><h2>New expense</h2><div class="fields"><label>Date<input class="input" type="date" [(ngModel)]="date"/></label><label>Category<select class="select" [(ngModel)]="categoryId"><option [ngValue]="0">Choose category</option>@for(c of categories();track c.id){<option [ngValue]="c.id">{{c.name}}</option>}</select></label><label>Amount<input class="input" type="number" min="0.01" step="0.01" [(ngModel)]="amount"/></label><label>Paid by<select class="select" [(ngModel)]="method"><option value="">Not specified</option>@for(m of methods();track m.code){<option [value]="m.code">{{m.name}}</option>}</select></label><label class="wide">Notes<input class="input" [(ngModel)]="notes"/></label></div><button class="btn btn-primary" (click)="save()">Save expense</button></section>}
 <section class="card"><div class="toolbar"><label>From<input class="input" type="date" [(ngModel)]="from" (ngModelChange)="load()"/></label><label>To<input class="input" type="date" [(ngModel)]="to" (ngModelChange)="load()"/></label></div>@if(rows().length){<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Category</th><th>Notes</th><th>Paid by</th><th class="num">Amount</th><th></th></tr></thead><tbody>@for(e of rows();track e.id){<tr [class.voided]="e.voidedAt"><td>{{e.expenseDate|date:'mediumDate'}}</td><td>{{e.categoryName}}</td><td>{{e.notes}}</td><td>{{e.paymentMethodName||'—'}}</td><td class="num">{{settings.money(e.amountMinor)}}</td><td>@if(!e.voidedAt){<button class="btn btn-sm" (click)="void(e)">Void</button>}@else{Voided}</td></tr>}</tbody></table></div><div class="total">Total: {{settings.money(totalMinor())}}</div>}@else{<div class="empty">No expenses in this period.</div>}</section>
`,styles:`.form{padding:18px;margin-bottom:16px}.form h2{font:600 20px var(--font-serif);margin-bottom:12px}.fields{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.fields label,.toolbar label{display:grid;gap:4px;font-size:12px}.wide{grid-column:span 2}.toolbar{display:flex;gap:10px;padding:12px}.num{text-align:right}.voided{opacity:.5;text-decoration:line-through}.total{text-align:right;padding:12px;font-weight:700}.empty{padding:35px;text-align:center;color:var(--ink-3)}@media(max-width:700px){.fields{grid-template-columns:1fr 1fr}}`})
export class ExpensesPage {
 private readonly api=inject(ApiService).api;protected readonly settings=inject(SettingsStore);
 protected readonly rows=signal<ExpenseDto[]>([]);protected readonly categories=signal<ExpenseCategoryDto[]>([]);protected readonly methods=signal<PaymentMethodDto[]>([]);protected readonly totalMinor=signal(0);protected readonly error=signal('');protected readonly showForm=signal(false);
 protected date=today();protected from=startOfMonth();protected to=today();protected categoryId=0;protected amount='';protected method='';protected notes='';
 constructor(){void this.init();}
 private async init(){try{const [c,m]=await Promise.all([this.api.expenses.listCategories(),this.api.settings.listPaymentMethods()]);this.categories.set(c);this.methods.set(m);}catch(e){this.error.set(messageOf(e));}await this.load();}
 protected async load(){try{const r=await this.api.expenses.list({from:this.from,to:this.to,pageSize:200});this.rows.set(r.items);this.totalMinor.set(r.totalMinor);}catch(e){this.error.set(messageOf(e));}}
 protected async save(){try{const amountMinor=this.settings.parse(this.amount);if(!amountMinor)throw new Error('Enter an expense amount.');await this.api.expenses.save({categoryId:Number(this.categoryId),expenseDate:this.date,amountMinor,paymentMethodCode:this.method||null,notes:this.notes});this.showForm.set(false);this.amount='';this.notes='';await this.load();}catch(e){this.error.set(messageOf(e));}}
 protected async void(e:ExpenseDto){if(!window.confirm(`Void expense ${this.settings.money(e.amountMinor)}?`))return;try{await this.api.expenses.void(e.id);await this.load();}catch(err){this.error.set(messageOf(err));}}
}
