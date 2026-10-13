import { Component, ElementRef, HostListener, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { StockRow } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { MoneyPipe } from '../../core/format.pipes';
import { debounce } from '../../core/util';

/** Debounced variant search over stock (carries cost). Emits the chosen StockRow. */
@Component({
  selector: 'app-variant-picker',
  imports: [FormsModule, MoneyPipe],
  template: `
    <div class="vp">
      <input class="input" type="search" autocomplete="off" [placeholder]="placeholder" aria-label="Search products by name, SKU or barcode"
        [ngModel]="text()" (ngModelChange)="onText($event)" (focus)="open.set(true)" />
      @if (open() && text().trim()) {
        <div class="pop card" role="listbox">
          @if (busy()) { <div class="muted small pad">Searching…</div> }
          @else if (error()) { <div class="error-text pad">{{ error() }}</div> }
          @else if (!results().length) { <div class="muted small pad">No matching variants.</div> }
          @else {
            @for (r of results(); track r.variantId) {
              <button type="button" class="opt" role="option" (click)="pick(r)">
                <span><span class="strong">{{ r.productName }}</span> <span class="muted">· {{ r.size }} / {{ r.colour }}</span>
                  <span class="muted small"> {{ r.sku }}</span></span>
                <span class="muted small nowrap">Stock {{ r.stockQty }} · Cost {{ r.costMinor | money }}</span>
              </button>
            }
          }
        </div>
      }
    </div>
  `,
  styles: `
    .vp { position: relative; }
    .pop { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 20; max-height: 280px; overflow: auto; box-shadow: var(--shadow-lg); }
    .opt { display: flex; justify-content: space-between; gap: 12px; width: 100%; text-align: left; padding: 9px 12px; border: 0; background: transparent; cursor: pointer; font: inherit; color: inherit; border-bottom: 1px solid #eee7da; }
    .opt:hover, .opt:focus-visible { background: #faf6ee; outline: none; }
    .pad { padding: 12px; }
  `,
})
export class VariantPickerComponent {
  private readonly api = inject(ApiService).api;
  private readonly el = inject(ElementRef<HTMLElement>);
  readonly picked = output<StockRow>();
  protected placeholder = 'Search product, SKU or barcode to add…';
  protected readonly text = signal('');
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly results = signal<StockRow[]>([]);
  private seq = 0;

  private readonly run = debounce(() => void this.search(), 250);

  protected onText(v: string): void {
    this.text.set(v);
    this.open.set(true);
    if (!v.trim()) { this.results.set([]); return; }
    this.busy.set(true);
    this.run();
  }

  private async search(): Promise<void> {
    const q = this.text().trim();
    if (!q) return;
    const my = ++this.seq;
    try {
      const page = await this.api.inventory.listStock({ search: q, pageSize: 12 });
      if (my !== this.seq) return;
      this.results.set(page.items.filter((r) => r.isActive));
      this.error.set('');
    } catch (e) {
      if (my !== this.seq) return;
      this.error.set(messageOf(e));
    } finally {
      if (my === this.seq) this.busy.set(false);
    }
  }

  protected pick(r: StockRow): void {
    this.picked.emit(r);
    this.text.set('');
    this.results.set([]);
    this.open.set(false);
  }

  @HostListener('document:mousedown', ['$event'])
  onDoc(e: MouseEvent): void {
    if (!(this.el.nativeElement as HTMLElement).contains(e.target as Node)) this.open.set(false);
  }
}
