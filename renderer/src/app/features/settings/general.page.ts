import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SettingsDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';

@Component({selector:'app-general-settings-page',imports:[FormsModule,PageHeaderComponent],template:`
  <app-page-header title="Shop details" subtitle="These details appear on receipts and in Vetora POS." />
  @if(error()){<div class="notice notice-bad">{{error()}}</div>}@if(saved()){<div class="notice notice-good">Settings saved.</div>}
  @if(form();as f){<section class="card form"><div class="grid"><label>Shop name<input class="input" [(ngModel)]="f.shopName" /></label><label>Phone<input class="input" [(ngModel)]="f.shopPhone" /></label><label>Email<input class="input" [(ngModel)]="f.shopEmail" /></label><label>Currency code<input class="input" maxlength="8" [(ngModel)]="f.currencyCode" /></label><label>Currency symbol<input class="input" maxlength="8" [(ngModel)]="f.currencySymbol" /></label><label>Decimal places<input class="input" type="number" min="0" max="4" [(ngModel)]="f.currencyDecimals" /></label><label class="wide">Address<textarea class="input" rows="2" [(ngModel)]="f.shopAddress"></textarea></label><label>Receipt width<select class="select" [(ngModel)]="f.receiptPaperWidthMm"><option [ngValue]="58">58 mm</option><option [ngValue]="80">80 mm</option></select></label><label>Receipt footer<input class="input" [(ngModel)]="f.receiptFooter" /></label><label>Default low-stock alert<input class="input" type="number" min="0" [(ngModel)]="f.lowStockDefault" /></label><label>Clothing sizes (comma separated)<input class="input" [ngModel]="f.sizes.join(', ')" (ngModelChange)="setSizes(f,$event)" /></label><label class="check"><input type="checkbox" [(ngModel)]="f.taxEnabled" /> Enable tax</label>@if(f.taxEnabled){<label>Tax label<input class="input" [(ngModel)]="f.taxLabel" /></label><label>Tax rate (%)<input class="input" type="number" min="0" max="100" step="0.01" [ngModel]="f.taxRateBps/100" (ngModelChange)="setTaxRate(f,$event)" /></label>}<label class="check"><input type="checkbox" [(ngModel)]="f.allowNegativeStock" /> Allow sales below zero stock</label></div><button class="btn btn-primary" type="button" [disabled]="saving()" (click)="save()">{{saving()?'Saving…':'Save settings'}}</button></section>}
`,styles:`.form{padding:18px;display:grid;gap:16px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.grid label{display:grid;gap:5px;font-size:12px}.wide{grid-column:1/-1}.check{display:flex!important;align-items:center;gap:8px}@media(max-width:700px){.grid{grid-template-columns:1fr}}`})
export class GeneralSettingsPage {
  private readonly api=inject(ApiService).api;private readonly settings=inject(SettingsStore);
  protected readonly form=signal<SettingsDto|null>(null);protected readonly error=signal('');protected readonly saved=signal(false);protected readonly saving=signal(false);
  constructor(){void this.load();}
  private async load(){try{this.form.set(await this.api.settings.get());}catch(e){this.error.set(messageOf(e));}}
  protected setSizes(f:SettingsDto,value:string){f.sizes=value.split(',').map(x=>x.trim()).filter(Boolean);}
  protected setTaxRate(f:SettingsDto,value:number|string){f.taxRateBps=Math.round(Number(value)*100);}
  protected async save(){const f=this.form();if(!f)return;this.error.set('');this.saved.set(false);this.saving.set(true);try{const updated=await this.api.settings.update(f);this.form.set(updated);await this.settings.refresh();this.saved.set(true);}catch(e){this.error.set(messageOf(e));}finally{this.saving.set(false);}}
}
