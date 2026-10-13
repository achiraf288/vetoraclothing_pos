import { Component, inject, signal } from '@angular/core';
import type { ValuationReport } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-valuation-page',imports:[PageHeaderComponent],template:`
 <app-page-header title="Stock valuation" subtitle="Inventory at purchase cost and current retail price." />@if(error()){<div class="notice notice-bad">{{error()}}</div>}
 @if(report();as r){<div class="cards"><section class="card stat"><span>Units in stock</span><b>{{r.totalUnits}}</b></section><section class="card stat"><span>Value at purchase cost</span><b>{{settings.money(r.totalCostValueMinor)}}</b></section><section class="card stat"><span>Potential retail value</span><b>{{settings.money(r.totalRetailValueMinor)}}</b></section></div><section class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>SKU</th><th>Size</th><th>Colour</th><th>Units</th><th>Cost each</th><th class="num">Cost value</th><th class="num">Retail value</th></tr></thead><tbody>@for(x of r.rows;track x.variantId){<tr><td>{{x.productName}}</td><td>{{x.sku}}</td><td>{{x.size}}</td><td>{{x.colour}}</td><td>{{x.stockQty}}</td><td>{{settings.money(x.costMinor)}}</td><td class="num">{{settings.money(x.costValueMinor)}}</td><td class="num">{{settings.money(x.retailValueMinor)}}</td></tr>}</tbody></table></div></section>}
`,styles:`.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}.stat{padding:16px;display:grid;gap:8px}.stat span{font-size:12px;color:var(--ink-3)}.stat b{font-size:20px}.num{text-align:right}@media(max-width:700px){.cards{grid-template-columns:1fr}}`})
export class ValuationPage {
 private readonly api=inject(ApiService).api;protected readonly settings=inject(SettingsStore);protected readonly report=signal<ValuationReport|null>(null);protected readonly error=signal('');
 constructor(){void this.load();}private async load(){try{this.report.set(await this.api.inventory.valuation());}catch(e){this.error.set(messageOf(e));}}
}
