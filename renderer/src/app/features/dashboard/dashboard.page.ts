import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DashboardData } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-dashboard-page',imports:[RouterLink,PageHeaderComponent],template:`
 <app-page-header title="Overview" subtitle="Today’s sales, stock and business performance." />
 @if(error()){<div class="notice notice-bad">{{error()}}</div>}@if(data();as d){<section class="metrics"><article class="card metric"><span>Net sales today</span><b>{{settings.money(d.financials.netSalesMinor)}}</b></article><article class="card metric"><span>Net operating profit</span><b>{{settings.money(d.financials.netProfitMinor)}}</b></article><article class="card metric"><span>Units in stock</span><b>{{d.totalUnitsInStock}}</b></article><article class="card metric alert"><span>Low-stock variants</span><b>{{d.lowStockCount}}</b></article></section>
 <section class="grid"><div class="card"><div class="head"><h2>Low stock</h2><a routerLink="/inventory/stock">View stock</a></div>@if(d.lowStock.length){<div class="list">@for(x of d.lowStock;track x.variantId){<div><span><b>{{x.productName}}</b><small>{{x.sku}} · {{x.size}} {{x.colour}}</small></span><strong>{{x.stockQty}} / {{x.reorderThreshold}}</strong></div>}</div>}@else{<p class="empty">Stock levels look good.</p>}</div>
 <div class="card"><div class="head"><h2>Best sellers · 30 days</h2><a routerLink="/reports">Reports</a></div>@if(d.bestSellers.length){<div class="list">@for(x of d.bestSellers;track x.productId){<div><span><b>{{x.name}}</b><small>{{settings.money(x.revenueMinor)}} revenue</small></span><strong>{{x.unitsSold}} sold</strong></div>}</div>}@else{<p class="empty">No sales in this period yet.</p>}</div>
 <div class="card recent"><div class="head"><h2>Recent sales</h2><a routerLink="/sales">All sales</a></div>@if(d.recentSales.length){<div class="list">@for(x of d.recentSales;track x.id){<div><span><b>{{x.receiptNo}}</b><small>{{x.customerName||'Walk-in customer'}} · {{x.itemCount}} items</small></span><strong>{{settings.money(x.totalMinor)}}</strong></div>}</div>}@else{<p class="empty">No sales yet.</p>}</div></section>}
`,styles:`.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}.metric{padding:16px;display:grid;gap:8px}.metric span{font-size:12px;color:var(--ink-3)}.metric b{font-size:22px}.alert b{color:#9a5b25}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid>.card{padding:15px}.recent{grid-column:1/-1}.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.head h2{font:600 18px var(--font-serif)}.head a{font-size:12px}.list>div{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--beige);padding:10px 0;gap:10px}.list small{display:block;color:var(--ink-3);margin-top:3px}.empty{padding:18px;color:var(--ink-3)}@media(max-width:850px){.metrics{grid-template-columns:1fr 1fr}}@media(max-width:650px){.grid{grid-template-columns:1fr}.recent{grid-column:auto}}`})
export class DashboardPage {
 private readonly api=inject(ApiService).api;protected readonly settings=inject(SettingsStore);protected readonly data=signal<DashboardData|null>(null);protected readonly error=signal('');
 constructor(){void this.load();}private async load(){try{this.data.set(await this.api.dashboard.get());}catch(e){this.error.set(messageOf(e));}}
}
