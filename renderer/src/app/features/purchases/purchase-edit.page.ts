import { Component, computed, inject, input, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { PurchaseDetail, StockRow, SupplierDto } from '@shared/api';
import { ApiError, ApiService, messageOf } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { today } from '../../core/dates';
import { BizDatePipe, DateTimePipe, MoneyPipe } from '../../core/format.pipes';
import { ToastService } from '../../core/toast.service';
import { titleCase } from '../../core/util';
import { LoadingComponent } from '../../ui/loading.component';
import { ModalComponent } from '../../ui/modal.component';
import { MoneyInputComponent } from '../../ui/money-input.component';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { VariantPickerComponent } from './variant-picker.component';

interface Line {
  variantId: number;
  productName: string;
  sku: string;
  size: string;
  colour: string;
  stockQty: number;
  quantity: number | null;
  unitCostMinor: number | null;
}

@Component({
  selector: 'app-purchase-edit-page',
  imports: [FormsModule, RouterLink, PageHeaderComponent, LoadingComponent, ModalComponent, MoneyInputComponent, VariantPickerComponent, MoneyPipe, BizDatePipe, DateTimePipe],
  template: `
    <app-page-header [title]="title()" [subtitle]="subtitle()">
      <div actions>
        <a class="btn" routerLink="/purchases">Back to purchases</a>
        @if (editable() && purchase()) {
          <button class="btn btn-danger" type="button" [disabled]="busy()" (click)="cancelPurchase()">Cancel purchase</button>
        }
      </div>
    </app-page-header>

    @if (loading()) {
      <div class="card"><app-loading [count]="6" /></div>
    } @else if (loadError()) {
      <div class="notice notice-bad" role="alert">{{ loadError() }} <a class="btn btn-sm" routerLink="/purchases">Back to purchases</a></div>
    } @else {
      @if (purchase(); as p) {
        <div class="row" style="margin-bottom:16px">
          <span class="badge" [class]="badgeClass()">{{ statusLabel() }}</span>
          @if (p.receivedAt) { <span class="muted small">Received {{ p.receivedAt | dateTime }}</span> }
        </div>
      }
      @if (formError()) { <div class="notice notice-bad" role="alert" style="margin-bottom:16px">{{ formError() }}</div> }

      <div class="stack">
        <div class="card card-pad">
          <div class="form-grid">
            <div class="field">
              <label for="p-sup">Supplier <span class="req">*</span></label>
              @if (editable()) {
                <select id="p-sup" class="select" [ngModel]="supplierId()" (ngModelChange)="supplierId.set($event); touch()">
                  <option [ngValue]="null" disabled>Select a supplier</option>
                  @for (s of supplierOptions(); track s.id) { <option [ngValue]="s.id">{{ s.name }}{{ s.isActive ? '' : ' (inactive)' }}</option> }
                </select>
                @if (fieldErrors()['supplierId']) { <span class="error">{{ fieldErrors()['supplierId'] }}</span> }
              } @else { <div>{{ purchase()?.supplierName }}</div> }
            </div>
            <div class="field">
              <label for="p-ref">Supplier reference</label>
              @if (editable()) { <input id="p-ref" class="input" maxlength="80" [ngModel]="supplierRef()" (ngModelChange)="supplierRef.set($event); touch()" placeholder="Invoice or order no." /> }
              @else { <div>{{ purchase()?.supplierRef || '—' }}</div> }
            </div>
            <div class="field">
              <label for="p-date">Purchase date <span class="req">*</span></label>
              @if (editable()) {
                <input id="p-date" class="input" type="date" [ngModel]="purchaseDate()" (ngModelChange)="purchaseDate.set($event); touch()" />
                @if (fieldErrors()['purchaseDate']) { <span class="error">{{ fieldErrors()['purchaseDate'] }}</span> }
              } @else { <div>{{ purchase()?.purchaseDate | bizDate }}</div> }
            </div>
            <div class="field span-all">
              <label for="p-notes">Notes</label>
              @if (editable()) { <textarea id="p-notes" class="textarea" rows="2" maxlength="500" [ngModel]="notes()" (ngModelChange)="notes.set($event); touch()"></textarea> }
              @else { <div>{{ purchase()?.notes || '—' }}</div> }
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Items</h3></div>
          @if (editable()) {
            <div class="card-pad" style="padding-bottom:0">
              <app-variant-picker (picked)="addLine($event)" />
              @if (fieldErrors()['items']) { <div class="error-text" style="margin-top:6px">{{ fieldErrors()['items'] }}</div> }
            </div>
          }
          @if (lines().length === 0) {
            <p class="muted card-pad">No items yet. {{ editable() ? 'Search above to add products.' : '' }}</p>
          } @else {
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Product</th><th>SKU</th><th class="num" style="width:110px">Quantity</th><th class="num" style="width:170px">Unit cost</th><th class="num">Line total</th>@if (editable()) { <th></th> }</tr></thead>
                <tbody>
                  @for (l of lines(); track l.variantId) {
                    <tr>
                      <td><span class="strong">{{ l.productName }}</span><div class="muted small">{{ l.size }} / {{ l.colour }}</div></td>
                      <td class="muted">{{ l.sku }}</td>
                      @if (editable()) {
                        <td class="num">
                          <input class="input num" type="number" min="1" step="1" inputmode="numeric" [attr.aria-label]="'Quantity for ' + l.productName"
                            [ngModel]="l.quantity" (ngModelChange)="setQty(l.variantId, $event)" [class.invalid]="!validQty(l)" />
                        </td>
                        <td class="num"><app-money-input [ngModel]="l.unitCostMinor" (ngModelChange)="setCost(l.variantId, $event)" /></td>
                      } @else {
                        <td class="num">{{ l.quantity }}</td>
                        <td class="num">{{ l.unitCostMinor | money }}</td>
                      }
                      <td class="num">{{ lineTotal(l) | money }}</td>
                      @if (editable()) { <td class="right"><button class="btn btn-sm btn-ghost" type="button" [attr.aria-label]="'Remove ' + l.productName" (click)="removeLine(l.variantId)">Remove</button></td> }
                    </tr>
                  }
                </tbody>
                <tfoot>
                  <tr><td [attr.colspan]="editable() ? 4 : 3">{{ unitCount() }} unit{{ unitCount() === 1 ? '' : 's' }} across {{ lines().length }} line{{ lines().length === 1 ? '' : 's' }}</td>
                    <td class="num">{{ total() | money }}</td>@if (editable()) { <td></td> }</tr>
                </tfoot>
              </table>
            </div>
          }
        </div>

        @if (editable()) {
          <div class="row spread">
            <span class="muted small">
              @if (purchase() && dirty()) { You have unsaved changes. Save the draft before receiving stock. }
            </span>
            <div class="row">
              <button class="btn" type="button" [disabled]="busy() || !canSave()" (click)="save()">{{ saving() ? 'Saving…' : 'Save draft' }}</button>
              @if (purchase()) {
                <button class="btn btn-accent" type="button" [disabled]="busy() || dirty() || lines().length === 0" (click)="receiveOpen.set(true)">Receive stock</button>
              }
            </div>
          </div>
        } @else {
          <div class="notice notice-info">This purchase is {{ statusLabel().toLowerCase() }} and can no longer be edited. @if (purchase()?.status === 'received') { To send stock back, record a supplier return. }</div>
        }
      </div>
    }

    @if (receiveOpen()) {
      <app-modal title="Receive stock" (closed)="closeReceive()">
        <div class="stack-sm">
          <p>Receiving <strong>{{ purchase()?.purchaseNo }}</strong> will add <strong>{{ unitCount() }} unit{{ unitCount() === 1 ? '' : 's' }}</strong> across {{ lines().length }} line{{ lines().length === 1 ? '' : 's' }} to your stock ({{ total() | money }}).</p>
          <div class="notice notice-warn">Stock increases only now and this cannot be undone. If something was received by mistake, record a supplier return afterwards.</div>
          <label class="check"><input type="checkbox" [(ngModel)]="updateCosts" /> Update variant cost prices to this purchase's unit costs</label>
          @if (receiveError()) { <div class="notice notice-bad" role="alert">{{ receiveError() }}</div> }
        </div>
        <ng-container footer>
          <button class="btn" type="button" (click)="closeReceive()">Not yet</button>
          <button class="btn btn-accent" type="button" [disabled]="busy()" (click)="receive()">{{ receiving() ? 'Receiving…' : 'Receive stock' }}</button>
        </ng-container>
      </app-modal>
    }
  `,
  styles: `
    input.invalid { border-color: var(--danger); }
    td .input { text-align: right; }
  `,
})
export class PurchaseEditPage implements OnInit {
  private readonly api = inject(ApiService).api;
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  /** Route param; undefined on /purchases/new. */
  readonly id = input<string | undefined>(undefined);

  readonly purchase = signal<PurchaseDetail | null>(null);
  readonly suppliers = signal<SupplierDto[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal('');
  readonly formError = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});

  readonly supplierId = signal<number | null>(null);
  readonly supplierRef = signal('');
  readonly purchaseDate = signal(today());
  readonly notes = signal('');
  readonly lines = signal<Line[]>([]);
  readonly dirty = signal(false);

  readonly saving = signal(false);
  readonly receiving = signal(false);
  readonly cancelling = signal(false);
  readonly busy = computed(() => this.saving() || this.receiving() || this.cancelling());
  readonly receiveOpen = signal(false);
  readonly receiveError = signal('');
  updateCosts = false;

  readonly editable = computed(() => { const p = this.purchase(); return !p || p.status === 'draft'; });
  readonly title = computed(() => { const p = this.purchase(); return p ? p.purchaseNo : 'New purchase'; });
  readonly subtitle = computed(() => (this.purchase() ? 'Purchase details' : 'Draft a stock order. Nothing changes in stock until you receive it.'));
  readonly statusLabel = computed(() => titleCase(this.purchase()?.status ?? 'draft'));
  readonly badgeClass = computed(() => { const s = this.purchase()?.status; return s === 'received' ? 'badge-ok' : s === 'cancelled' ? 'badge-bad' : 'badge-warn'; });
  readonly total = computed(() => this.lines().reduce((a, l) => a + this.lineTotal(l), 0));
  readonly unitCount = computed(() => this.lines().reduce((a, l) => a + (this.validQty(l) ? (l.quantity as number) : 0), 0));
  readonly supplierOptions = computed(() => {
    const cur = this.supplierId();
    return this.suppliers().filter((s) => s.isActive || s.id === cur);
  });
  readonly canSave = computed(() =>
    this.supplierId() !== null && !!this.purchaseDate() && this.lines().length > 0 &&
    this.lines().every((l) => this.validQty(l) && l.unitCostMinor !== null),
  );

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      this.suppliers.set(await this.api.suppliers.list(true));
      const raw = this.id();
      if (raw !== undefined) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new ApiError('NOT_FOUND', 'Purchase not found.');
        this.applyPurchase(await this.api.purchases.get(n));
      }
    } catch (e) {
      this.loadError.set(messageOf(e));
    } finally {
      this.loading.set(false);
    }
  }

  private applyPurchase(p: PurchaseDetail): void {
    this.purchase.set(p);
    this.supplierId.set(p.supplierId);
    this.supplierRef.set(p.supplierRef);
    this.purchaseDate.set(p.purchaseDate);
    this.notes.set(p.notes);
    this.lines.set(p.items.map((i) => ({
      variantId: i.variantId, productName: i.productName, sku: i.sku, size: i.size, colour: i.colour,
      stockQty: 0, quantity: i.quantity, unitCostMinor: i.unitCostMinor,
    })));
    this.dirty.set(false);
  }

  touch(): void { this.dirty.set(true); this.formError.set(''); }
  validQty(l: Line): boolean { return Number.isInteger(l.quantity) && (l.quantity as number) >= 1; }
  lineTotal(l: Line): number { return this.validQty(l) && l.unitCostMinor !== null ? (l.quantity as number) * l.unitCostMinor : 0; }

  addLine(r: StockRow): void {
    const existing = this.lines().find((l) => l.variantId === r.variantId);
    if (existing) {
      this.patch(r.variantId, { quantity: (this.validQty(existing) ? (existing.quantity as number) : 0) + 1 });
      this.toast.info('Already on the purchase — quantity increased.');
      return;
    }
    this.lines.update((ls) => [...ls, {
      variantId: r.variantId, productName: r.productName, sku: r.sku, size: r.size, colour: r.colour,
      stockQty: r.stockQty, quantity: 1, unitCostMinor: r.costMinor,
    }]);
    this.touch();
  }
  removeLine(id: number): void { this.lines.update((ls) => ls.filter((l) => l.variantId !== id)); this.touch(); }
  setQty(id: number, v: number | null): void { this.patch(id, { quantity: v }); }
  setCost(id: number, v: number | null): void { this.patch(id, { unitCostMinor: v }); }
  private patch(id: number, change: Partial<Line>): void {
    this.lines.update((ls) => ls.map((l) => (l.variantId === id ? { ...l, ...change } : l)));
    this.touch();
  }

  async save(): Promise<void> {
    if (this.busy() || !this.canSave()) return;
    this.saving.set(true);
    this.formError.set('');
    this.fieldErrors.set({});
    try {
      const p = this.purchase();
      const saved = await this.api.purchases.saveDraft({
        ...(p ? { id: p.id } : {}),
        supplierId: this.supplierId() as number,
        supplierRef: this.supplierRef().trim(),
        notes: this.notes().trim(),
        purchaseDate: this.purchaseDate(),
        items: this.lines().map((l) => ({ variantId: l.variantId, quantity: l.quantity as number, unitCostMinor: l.unitCostMinor as number })),
      });
      this.toast.success('Draft saved.');
      if (!p) {
        await this.router.navigate(['/purchases', saved.id], { replaceUrl: true });
      } else {
        this.applyPurchase(saved);
      }
    } catch (e) {
      if (e instanceof ApiError && e.field) this.fieldErrors.set({ [e.field]: e.message });
      this.formError.set(messageOf(e));
    } finally {
      this.saving.set(false);
    }
  }

  closeReceive(): void { if (!this.receiving()) { this.receiveOpen.set(false); this.receiveError.set(''); } }

  async receive(): Promise<void> {
    const p = this.purchase();
    if (!p || this.busy()) return;
    this.receiving.set(true);
    this.receiveError.set('');
    try {
      const done = await this.api.purchases.receive({ id: p.id, updateCosts: this.updateCosts });
      this.receiveOpen.set(false);
      this.applyPurchase(done);
      this.toast.success(`${done.purchaseNo} received. Stock updated.`);
    } catch (e) {
      this.receiveError.set(messageOf(e));
    } finally {
      this.receiving.set(false);
    }
  }

  async cancelPurchase(): Promise<void> {
    const p = this.purchase();
    if (!p || this.busy()) return;
    const ok = await this.confirm.ask({
      title: 'Cancel this purchase?',
      message: `${p.purchaseNo} will be marked as cancelled and can no longer be received or edited.`,
      confirmLabel: 'Cancel purchase',
      cancelLabel: 'Keep draft',
      danger: true,
    });
    if (!ok) return;
    this.cancelling.set(true);
    try {
      this.applyPurchase(await this.api.purchases.cancel(p.id));
      this.toast.success('Purchase cancelled.');
    } catch (e) {
      this.toast.error(messageOf(e));
    } finally {
      this.cancelling.set(false);
    }
  }
}
