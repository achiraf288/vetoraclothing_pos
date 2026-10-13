import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PaymentMethodDto, PosVariant, ReceiptDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SettingsStore } from '../../core/settings.store';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { ReceiptComponent } from '../sales/receipt.component';

interface CartLine { item: PosVariant; quantity: number; discount: number }
@Component({
  selector: 'app-pos-page', imports: [FormsModule, PageHeaderComponent, ReceiptComponent],
  template: `
    <app-page-header title="Point of sale" subtitle="Scan or search items, apply discounts and take payment." />
    @if (receipt(); as r) {
      <div class="card done"><div><h2>Sale complete · {{ r.sale.receiptNo }}</h2><p class="muted">{{ settings.money(r.sale.totalMinor) }}</p></div>
        <button class="btn btn-primary" type="button" (click)="printReceipt()">Print receipt</button><button class="btn" type="button" (click)="newSale()">New sale</button>
        <app-receipt [data]="r" />
      </div>
    } @else {
      <div class="columns">
        <section class="card panel">
          <div class="searchrow"><input class="input" autofocus placeholder="Search product, SKU or barcode" aria-label="Search products" [ngModel]="query()" (ngModelChange)="search($event)" (keydown.enter)="scan()"/><button class="btn" type="button" (click)="scan()">Scan code</button></div>
          @if (error()) { <div class="notice notice-bad">{{ error() }}</div> }
          @if (matches().length) { <div class="matches">@for (p of matches(); track p.variantId) { <button class="match" type="button" (click)="add(p)"><span><b>{{p.productName}}</b><small>{{p.sku}} · {{p.size}} {{p.colour}} · {{p.stockQty}} in stock</small></span><strong>{{settings.money(p.priceMinor)}}</strong></button> }</div> }
          @if (cart().length) { <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Qty</th><th>Discount</th><th class="num">Line total</th><th></th></tr></thead><tbody>@for (line of cart(); track line.item.variantId) { <tr><td><b>{{line.item.productName}}</b><div class="muted small">{{line.item.size}} {{line.item.colour}}</div></td><td><input class="input qty" type="number" min="1" [ngModel]="line.quantity" (ngModelChange)="qty(line,$event)" /></td><td><input class="input amt" type="number" min="0" step="0.01" [ngModel]="settings.toInput(line.discount)" (ngModelChange)="lineDiscount(line,$event)" /></td><td class="num">{{settings.money(line.item.priceMinor*line.quantity-line.discount)}}</td><td><button class="btn btn-sm" type="button" (click)="remove(line)">Remove</button></td></tr> }</tbody></table></div> } @else { <div class="empty">Scan a barcode or search for an item to add it to the sale.</div> }
        </section>
        <aside class="card summary"><h2>Payment</h2><label>Customer name <input class="input" [(ngModel)]="customerName" placeholder="Walk-in customer" /></label><label>Phone <input class="input" [(ngModel)]="customerPhone" /></label>
          <label>Order discount <input class="input" type="number" min="0" step="0.01" [ngModel]="orderDiscountInput" (ngModelChange)="setOrderDiscount($event)" /></label>
          <div class="promo"><label>Discount code<input class="input" [(ngModel)]="promoInput" placeholder="Enter code" [disabled]="promoDiscount()>0" /></label>@if(promoDiscount()){<button class="btn btn-sm" type="button" (click)="clearPromo()">Remove {{settings.money(promoDiscount())}}</button>}@else{<button class="btn btn-sm" type="button" (click)="applyPromo()">Apply code</button>}</div>
          <div class="totals"><div><span>Subtotal</span><b>{{settings.money(subtotal())}}</b></div><div><span>Discounts</span><b>−{{settings.money(discounts())}}</b></div>@if(tax()){<div><span>{{settings.settings().taxLabel}}</span><b>{{settings.money(tax())}}</b></div>}<div class="grand"><span>Total</span><b>{{settings.money(total())}}</b></div></div>
          <label>Payment method <select class="select" [(ngModel)]="methodCode">@for(m of methods();track m.code){<option [value]="m.code">{{m.name}}</option>}</select></label>
          @if(activeMethod()?.referenceMode==='required'){<label>Payment reference <input class="input" [(ngModel)]="paymentReference" required /></label>}
          @if (cashMethod()) { <label>Cash tendered <input class="input" type="number" min="0" step="0.01" [ngModel]="tenderedInput" (ngModelChange)="tenderedInput=$event" /></label> }
          @if (error()) { <div class="notice notice-bad">{{error()}}</div> }
          <button class="btn btn-primary checkout" type="button" [disabled]="busy() || !cart().length" (click)="checkout()">{{busy()?'Saving…':'Complete sale'}}</button>
        </aside>
      </div>
    }
  `,
  styles: `:host{display:block}.columns{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px;align-items:start}.panel,.summary{padding:18px}.searchrow{display:flex;gap:8px}.searchrow .input{flex:1}.matches{margin:12px 0;border:1px solid var(--beige);border-radius:8px;max-height:260px;overflow:auto}.match{width:100%;display:flex;justify-content:space-between;align-items:center;padding:11px 12px;border:0;border-bottom:1px solid var(--beige);background:white;text-align:left;cursor:pointer}.match:hover{background:var(--cream)}.match small{display:block;color:var(--ink-3);margin-top:3px}.match strong{white-space:nowrap}.empty{padding:60px 20px;text-align:center;color:var(--ink-3)}.summary{display:grid;gap:14px}.summary h2{font:600 20px var(--font-serif)}label{display:grid;gap:5px;font-size:12px;color:var(--ink-2)}.promo{display:flex;gap:8px;align-items:end}.promo label{flex:1}.totals{border-top:1px solid var(--beige);border-bottom:1px solid var(--beige);padding:10px 0;display:grid;gap:8px}.totals div{display:flex;justify-content:space-between}.grand{font-size:17px;padding-top:8px;border-top:1px solid var(--beige)}.checkout{width:100%}.qty{width:70px}.amt{width:110px}.done{padding:20px;display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center}.done app-receipt{grid-column:1/-1;justify-self:center}.done h2{font:600 22px var(--font-serif)}@media(max-width:900px){.columns{grid-template-columns:1fr}.done{grid-template-columns:1fr}}`,
})
export class PosPage {
  private readonly api = inject(ApiService).api;
  protected readonly settings = inject(SettingsStore);
  protected readonly query = signal(''); protected readonly matches = signal<PosVariant[]>([]); protected readonly cart = signal<CartLine[]>([]);
  protected readonly methods = signal<PaymentMethodDto[]>([]); protected readonly receipt = signal<ReceiptDto|null>(null);
  protected readonly error = signal(''); protected readonly busy = signal(false);
  private readonly receiptView = viewChild(ReceiptComponent);
  protected customerName = 'Walk-in customer'; protected customerPhone=''; protected methodCode='cash'; protected tenderedInput=''; protected orderDiscountInput='0'; protected promoInput=''; protected discountCode=''; protected paymentReference=''; protected readonly promoDiscount=signal(0);
  protected readonly subtotal = computed(()=>this.cart().reduce((s,l)=>s+l.item.priceMinor*l.quantity,0));
  protected readonly discounts = computed(()=>this.cart().reduce((s,l)=>s+l.discount,0)+(this.settings.parse(this.orderDiscountInput)??0)+this.promoDiscount());
  protected readonly tax = computed(()=>{const base=Math.max(0,this.subtotal()-this.discounts());return this.settings.settings().taxEnabled?Math.floor((base*this.settings.settings().taxRateBps+5000)/10000):0;});
  protected readonly total = computed(()=>Math.max(0,this.subtotal()-this.discounts())+this.tax());
  protected readonly cashMethod = computed(()=>this.methods().find(m=>m.code===this.methodCode)?.isCash??false);
  protected readonly activeMethod = computed(()=>this.methods().find(m=>m.code===this.methodCode));
  constructor(){void this.loadMethods();}
  private async loadMethods(){try{this.methods.set((await this.api.settings.listPaymentMethods()).filter(m=>m.code!=='cod'));}catch(e){this.error.set(messageOf(e));}}
  protected async search(v:string){this.query.set(v);this.error.set('');if(!v.trim()){this.matches.set([]);return;}try{this.matches.set(await this.api.sales.lookup({query:v}));}catch(e){this.error.set(messageOf(e));}}
  protected async scan(){const code=this.query().trim();if(!code)return;try{const p=await this.api.sales.scan({code});if(p){this.add(p);this.query.set('');this.matches.set([]);}else this.error.set('No product matches that barcode or SKU.');}catch(e){this.error.set(messageOf(e));}}
  protected add(item:PosVariant){this.clearPromo();this.error.set('');this.cart.update(rows=>{const found=rows.find(x=>x.item.variantId===item.variantId);return found?rows.map(x=>x===found?{...x,quantity:x.quantity+1}:x):[...rows,{item,quantity:1,discount:0}];});this.query.set('');this.matches.set([]);}
  protected qty(line:CartLine,value:string|number){this.clearPromo();const n=Math.max(1,Math.floor(Number(value)||1));this.cart.update(rows=>rows.map(x=>x.item.variantId===line.item.variantId?{...x,quantity:n}:x));}
  protected lineDiscount(line:CartLine,value:string){this.clearPromo();const minor=this.settings.parse(value)??0;this.cart.update(rows=>rows.map(x=>x.item.variantId===line.item.variantId?{...x,discount:Math.min(minor,x.item.priceMinor*x.quantity)}:x));}
  protected setOrderDiscount(v:string){this.clearPromo();this.orderDiscountInput=v;const parsed=this.settings.parse(v);if(parsed!==null&&parsed>this.subtotal()-this.cart().reduce((s,l)=>s+l.discount,0))this.orderDiscountInput=this.settings.toInput(this.subtotal()-this.cart().reduce((s,l)=>s+l.discount,0));}
  protected async applyPromo(){this.error.set('');try{const base=this.subtotal()-this.cart().reduce((s,l)=>s+l.discount,0);const result=await this.api.sales.previewDiscount({code:this.promoInput,subtotalMinor:base});this.discountCode=this.promoInput.trim().toUpperCase();this.promoDiscount.set(result.discountMinor);}catch(e){this.error.set(messageOf(e));}}
  protected clearPromo(){this.promoDiscount.set(0);this.discountCode='';this.promoInput='';}
  protected remove(line:CartLine){this.clearPromo();this.cart.update(rows=>rows.filter(x=>x.item.variantId!==line.item.variantId));}
  protected async checkout(){this.error.set('');const total=this.total();const method=this.methods().find(m=>m.code===this.methodCode);if(!method){this.error.set('Select a payment method.');return;}if(method.referenceMode==='required'&&!this.paymentReference.trim()){this.error.set('Enter the payment reference.');return;}const tender=method.isCash?(this.settings.parse(this.tenderedInput)||total):undefined;if(method.isCash&&(tender??0)<total){this.error.set('Cash tendered is less than the total.');return;}this.busy.set(true);try{const sale=await this.api.sales.checkout({idempotencyKey:crypto.randomUUID(),items:this.cart().map(x=>({variantId:x.item.variantId,quantity:x.quantity,discountMinor:x.discount})),orderDiscountMinor:this.settings.parse(this.orderDiscountInput)??0,discountCode:this.discountCode,customerName:this.customerName,customerPhone:this.customerPhone,notes:'',payments:total?[{methodCode:method.code,amountMinor:total,tenderedMinor:tender,reference:this.paymentReference}]:[]});this.receipt.set(await this.api.sales.receipt(sale.id));}catch(e){this.error.set(messageOf(e));}finally{this.busy.set(false);}}
  protected printReceipt(){this.receiptView()?.print();}
  protected newSale(){this.receipt.set(null);this.cart.set([]);this.customerName='Walk-in customer';this.customerPhone='';this.orderDiscountInput='0';this.tenderedInput='';this.paymentReference='';this.clearPromo();this.error.set('');}
}
