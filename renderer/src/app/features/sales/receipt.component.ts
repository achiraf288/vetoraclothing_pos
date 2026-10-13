import { Component, ElementRef, ViewEncapsulation, computed, inject, input } from '@angular/core';
import type { ReceiptDto } from '@shared/api';
import { formatDateTime } from '../../core/dates';
import { formatMinor } from '../../core/money';

/** Receipt styles. Used on screen (ViewEncapsulation.None) and inlined into the print iframe. */
export const RECEIPT_CSS = `
.rcpt { background: #fff; color: #111; font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, Menlo, monospace; font-size: 11px; line-height: 1.35; padding: 5mm 4mm 6mm; box-sizing: border-box; position: relative; }
.rcpt * { box-sizing: border-box; }
.rcpt .center { text-align: center; }
.rcpt .shop { font-size: 15px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.rcpt .muted { color: #444; }
.rcpt .sep { border: 0; border-top: 1px dashed #555; margin: 6px 0; }
.rcpt .sep.solid { border-top-style: solid; }
.rcpt .kv { display: flex; justify-content: space-between; gap: 8px; }
.rcpt .kv > span:last-child { text-align: right; white-space: nowrap; }
.rcpt .item { margin: 4px 0; }
.rcpt .item .name { font-weight: 700; word-break: break-word; }
.rcpt .item .sub { color: #444; }
.rcpt .total { font-size: 14px; font-weight: 700; }
.rcpt .stamp { margin: 6px auto; padding: 3px 8px; width: fit-content; border: 2px solid #111; font-weight: 700; letter-spacing: 0.18em; font-size: 14px; transform: rotate(-4deg); }
.rcpt .footer { white-space: pre-line; margin-top: 8px; }
.rcpt.cancelled .item, .rcpt.cancelled .kv.amt { text-decoration: line-through; text-decoration-thickness: 1px; }
.rcpt-preview { margin: 0 auto; box-shadow: 0 1px 2px rgba(40,40,33,0.12), 0 8px 24px rgba(40,40,33,0.14); border: 1px solid #e4dccd; }
`;

/**
 * Thermal-style receipt. Works as an on-screen preview (centred, paper-like) and prints ONLY the receipt
 * through a hidden same-origin iframe (`print()`), never the surrounding app.
 */
@Component({
  selector: 'app-receipt',
  encapsulation: ViewEncapsulation.None,
  styles: RECEIPT_CSS,
  template: `
    <div class="rcpt rcpt-preview" [class.cancelled]="sale().status === 'cancelled'" [style.width.mm]="widthMm()" data-receipt>
      <div class="center">
        <div class="shop">{{ data().shop.name }}</div>
        @if (data().shop.address) { <div class="muted" style="white-space: pre-line">{{ data().shop.address }}</div> }
        @if (data().shop.phone) { <div class="muted">Tel: {{ data().shop.phone }}</div> }
        @if (data().shop.email) { <div class="muted">{{ data().shop.email }}</div> }
      </div>
      @if (sale().status === 'cancelled') { <div class="stamp">CANCELLED</div> }
      <hr class="sep" />
      <div class="kv"><span>Receipt</span><span>{{ sale().receiptNo }}</span></div>
      <div class="kv"><span>Date</span><span>{{ when() }}</span></div>
      @if (sale().cashierName) { <div class="kv"><span>Cashier</span><span>{{ sale().cashierName }}</span></div> }
      @if (sale().customerName) { <div class="kv"><span>Customer</span><span>{{ sale().customerName }}</span></div> }
      @if (sale().status === 'cancelled' && sale().cancelReason) { <div class="muted">Reason: {{ sale().cancelReason }}</div> }
      <hr class="sep" />
      @for (i of sale().items; track i.id) {
        <div class="item">
          <div class="name">{{ i.productName }}</div>
          @if (i.size || i.colour) { <div class="sub">{{ variant(i.size, i.colour) }}</div> }
          <div class="kv"><span>{{ i.quantity }} x {{ m(i.unitPriceMinor) }}</span><span>{{ m(i.quantity * i.unitPriceMinor) }}</span></div>
          @if (i.lineDiscountMinor > 0) { <div class="kv sub"><span>Discount</span><span>-{{ m(i.lineDiscountMinor) }}</span></div> }
          @if (i.orderDiscountShareMinor > 0) { <div class="kv sub"><span>Order discount share</span><span>-{{ m(i.orderDiscountShareMinor) }}</span></div> }
          @if (i.lineDiscountMinor > 0 || i.orderDiscountShareMinor > 0) { <div class="kv"><span>Line total</span><span>{{ m(i.lineNetMinor) }}</span></div> }
        </div>
      }
      <hr class="sep" />
      <div class="kv amt"><span>Subtotal</span><span>{{ m(sale().subtotalMinor) }}</span></div>
      @if (sale().lineDiscountTotalMinor > 0) { <div class="kv amt"><span>Item discounts</span><span>-{{ m(sale().lineDiscountTotalMinor) }}</span></div> }
      @if (sale().orderDiscountMinor > 0) { <div class="kv amt"><span>Order discount</span><span>-{{ m(sale().orderDiscountMinor) }}</span></div> }
      @if (sale().taxMinor > 0) { <div class="kv amt"><span>{{ data().taxLabel || 'Tax' }}</span><span>{{ m(sale().taxMinor) }}</span></div> }
      <hr class="sep solid" />
      <div class="kv total amt"><span>TOTAL</span><span>{{ m(sale().totalMinor) }}</span></div>
      <hr class="sep" />
      @for (p of sale().payments; track p.id) {
        <div class="kv amt"><span>{{ p.methodName }}</span><span>{{ m(p.amountMinor) }}</span></div>
        @if (p.tenderedMinor !== null && p.tenderedMinor !== p.amountMinor) { <div class="kv sub amt"><span>Tendered</span><span>{{ m(p.tenderedMinor) }}</span></div> }
        @if (p.changeMinor !== null && p.changeMinor > 0) { <div class="kv sub amt"><span>Change</span><span>{{ m(p.changeMinor) }}</span></div> }
        @if (p.reference) { <div class="muted">Ref: {{ p.reference }}</div> }
      }
      @if (sale().refundedMinor > 0) {
        <hr class="sep" />
        <div class="kv"><span>Refunded</span><span>{{ m(sale().refundedMinor) }}</span></div>
      }
      @if (data().shop.footer) { <hr class="sep" /><div class="center footer">{{ data().shop.footer }}</div> }
    </div>
  `,
})
export class ReceiptComponent {
  readonly data = input.required<ReceiptDto>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly sale = computed(() => this.data().sale);
  protected readonly widthMm = computed(() => (this.data().shop.paperWidthMm === 58 ? 58 : 80));
  protected readonly when = computed(() => formatDateTime(this.sale().createdAt, this.data().currency.locale));

  protected m(minor: number): string {
    const c = this.data().currency;
    return formatMinor(minor, { decimals: c.decimals, symbol: c.symbol, locale: c.locale });
  }
  protected variant(size: string, colour: string): string { return [size, colour].filter(Boolean).join(' / '); }

  /** Prints only this receipt. */
  print(): void {
    const el = this.host.nativeElement.querySelector<HTMLElement>('[data-receipt]');
    if (el) ReceiptComponent.printHtml(el.outerHTML, this.widthMm());
  }

  /** Renders receipt markup into a hidden same-origin iframe and prints just that. */
  static printHtml(receiptHtml: string, widthMm: number): void {
    document.querySelectorAll('iframe[data-receipt-print]').forEach((n) => n.remove());
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-receipt-print', '');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthMm}mm;height:200px;border:0;`;
    const css = `${RECEIPT_CSS}
      @page { size: ${widthMm}mm auto; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .rcpt-preview { box-shadow: none; border: 0; margin: 0; width: ${widthMm}mm !important; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt</title><style>${css}</style></head><body>${receiptHtml}</body></html>`;
    iframe.onload = () => {
      const w = iframe.contentWindow;
      if (!w) { iframe.remove(); return; }
      const cleanup = () => setTimeout(() => iframe.remove(), 500);
      w.addEventListener('afterprint', cleanup, { once: true });
      setTimeout(() => iframe.remove(), 5 * 60 * 1000);
      w.focus();
      w.print();
    };
    document.body.appendChild(iframe);
  }
}
