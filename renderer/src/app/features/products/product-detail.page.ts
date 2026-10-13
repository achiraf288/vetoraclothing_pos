import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ActivityEntry, CategoryDto, ProductDetail, VariantInput } from '@shared/api';
import { ApiError, ApiService, messageOf } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { DateTimePipe, MoneyPipe } from '../../core/format.pipes';
import { SessionService } from '../../core/session.service';
import { SettingsStore } from '../../core/settings.store';
import { ToastService } from '../../core/toast.service';
import { debounce } from '../../core/util';
import { EmptyStateComponent, LoadingComponent, ModalComponent, MoneyInputComponent, PageHeaderComponent } from '../../ui';

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const BARCODE_RE = /^[A-Za-z0-9._-]+$/;
const CUSTOM = '__custom';

interface ProductForm {
  sku: string;
  name: string;
  categoryId: number | null;
  brand: string;
  description: string;
  defaultCostMinor: number | null;
  defaultPriceMinor: number | null;
}

/** One row of the variants table (a saved variant, or an unsaved draft while creating a product). */
interface VariantRow {
  key: number;
  id: number | null;
  sku: string;
  barcode: string;
  size: string;
  colour: string;
  costMinor: number;
  priceMinor: number;
  reorderThreshold: number;
  openingStock: number;
  stockQty: number;
  isActive: boolean;
}

interface VariantForm {
  sku: string;
  barcode: string;
  sizeChoice: string;
  customSize: string;
  colour: string;
  costMinor: number | null;
  priceMinor: number | null;
  reorderThreshold: number | null;
  openingStock: number | null;
}

type SkuState = 'idle' | 'checking' | 'ok' | 'taken';

const emptyProduct = (): ProductForm => ({ sku: '', name: '', categoryId: null, brand: '', description: '', defaultCostMinor: 0, defaultPriceMinor: null });

@Component({
  selector: 'app-product-detail-page',
  imports: [FormsModule, RouterLink, DateTimePipe, MoneyPipe, EmptyStateComponent, LoadingComponent, ModalComponent, MoneyInputComponent, PageHeaderComponent],
  template: `
    <p class="no-print" style="margin-bottom: 8px"><a routerLink="/products" class="muted small">← All products</a></p>

    @if (loading()) {
      <div class="card"><app-loading [count]="8" /></div>
    } @else if (loadError()) {
      <div class="card"><app-empty-state title="Product unavailable" [message]="loadError()">
        <a class="btn" routerLink="/products">Back to products</a>
      </app-empty-state></div>
    } @else {
      <app-page-header [title]="isNew() ? 'New product' : (detail()?.product?.name || 'Product')"
        [subtitle]="isNew() ? 'Describe the product, then add its sizes and colours.' : (detail()?.product?.sku || '')">
        <div actions>
          @if (!isNew() && !isActive()) { <span class="badge">Archived</span> }
          @if (canWrite && !isNew()) {
            <button class="btn" type="button" [disabled]="busy()" (click)="toggleProductArchive()">{{ isActive() ? 'Archive' : 'Restore' }}</button>
          }
          @if (canEdit()) {
            <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="saveProduct()">
              {{ busy() ? 'Saving…' : (isNew() ? 'Create product' : 'Save changes') }}
            </button>
          }
        </div>
      </app-page-header>

      @if (!isNew() && !isActive() && canWrite) {
        <div class="notice notice-warn" style="margin-bottom: 16px">This product is archived. It is hidden from the till. Restore it to make changes.</div>
      }
      @if (formError()) { <div class="notice notice-bad" style="margin-bottom: 16px" role="alert">{{ formError() }}</div> }

      <div class="layout">
        <div class="stack">
          <section class="card">
            <div class="card-head"><h2>Details</h2></div>
            <div class="card-body">
              @let e = productErrors();
              <div class="form-grid">
                <div class="field">
                  <label for="pd-name">Name <span class="req">*</span></label>
                  <input id="pd-name" class="input" [class.invalid]="submitted() && e.name" maxlength="120" [disabled]="!canEdit()"
                    [ngModel]="p.name" (ngModelChange)="p.name = $event" />
                  @if (submitted() && e.name) { <span class="error">{{ e.name }}</span> }
                </div>
                <div class="field">
                  <label for="pd-sku">SKU <span class="req">*</span></label>
                  <input id="pd-sku" class="input mono" [class.invalid]="(p.sku && e.sku) || skuState() === 'taken' || (submitted() && e.sku)" maxlength="40" [disabled]="!canEdit()"
                    [ngModel]="p.sku" (ngModelChange)="p.sku = $event; onSkuChange()" />
                  @if (p.sku && e.sku) { <span class="error">{{ e.sku }}</span> }
                  @else if (submitted() && e.sku) { <span class="error">{{ e.sku }}</span> }
                  @else if (skuState() === 'taken') { <span class="error">That SKU is already used by another product.</span> }
                  @else if (skuState() === 'checking') { <span class="help">Checking availability…</span> }
                  @else if (skuState() === 'ok') { <span class="help" style="color: var(--positive)">SKU is available.</span> }
                </div>
                <div class="field">
                  <label for="pd-cat">Category</label>
                  <select id="pd-cat" class="select" [disabled]="!canEdit()" [ngModel]="p.categoryId" (ngModelChange)="p.categoryId = $event">
                    <option [ngValue]="null">Uncategorised</option>
                    @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}{{ c.isActive ? '' : ' (inactive)' }}</option> }
                  </select>
                  @if (canEdit()) {
                    @if (addingCategory()) {
                      <div class="row-nowrap" style="gap: 6px">
                        <input class="input input-sm" aria-label="New category name" placeholder="Category name" maxlength="60"
                          [ngModel]="newCategory" (ngModelChange)="newCategory = $event" (keydown.enter)="addCategory()" />
                        <button class="btn btn-sm" type="button" [disabled]="busyCategory()" (click)="addCategory()">Add</button>
                        <button class="btn btn-sm btn-ghost" type="button" (click)="addingCategory.set(false)">Cancel</button>
                      </div>
                      @if (categoryError()) { <span class="error">{{ categoryError() }}</span> }
                    } @else {
                      <button class="btn btn-ghost btn-sm" style="align-self: flex-start" type="button" (click)="startAddCategory()">+ New category</button>
                    }
                  }
                </div>
                <div class="field">
                  <label for="pd-brand">Brand</label>
                  <input id="pd-brand" class="input" maxlength="60" [disabled]="!canEdit()" [ngModel]="p.brand" (ngModelChange)="p.brand = $event" />
                </div>
                @if (canWrite) {
                  <div class="field">
                    <label for="pd-cost">Default cost price</label>
                    <app-money-input inputId="pd-cost" [disabled]="!canEdit()" [ngModel]="p.defaultCostMinor" (ngModelChange)="p.defaultCostMinor = $event" />
                    @if (submitted() && e.cost) { <span class="error">{{ e.cost }}</span> }
                  </div>
                }
                <div class="field">
                  <label for="pd-price">Default selling price <span class="req">*</span></label>
                  <app-money-input inputId="pd-price" [disabled]="!canEdit()" [ngModel]="p.defaultPriceMinor" (ngModelChange)="p.defaultPriceMinor = $event" />
                  @if (submitted() && e.price) { <span class="error">{{ e.price }}</span> }
                  @else if (canEdit()) { <span class="help">Pre-fills new variants.</span> }
                </div>
                <div class="field span-all">
                  <label for="pd-desc">Description</label>
                  <textarea id="pd-desc" class="textarea" maxlength="2000" [disabled]="!canEdit()" [ngModel]="p.description" (ngModelChange)="p.description = $event"></textarea>
                </div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <h2>Variants</h2>
              @if (canEdit()) {
                <div class="row" style="gap: 8px">
                  <button class="btn btn-sm" type="button" (click)="toggleQuick()">Quick add sizes</button>
                  <button class="btn btn-sm btn-primary" type="button" (click)="openVariant(null)">Add variant</button>
                </div>
              }
            </div>

            @if (quickOpen() && canEdit()) {
              <div class="card-body quick">
                <div class="label" style="margin-bottom: 8px">Sizes</div>
                <div class="row" style="gap: 6px; margin-bottom: 12px">
                  @for (s of sizeOptions(); track s) {
                    <button type="button" class="btn btn-sm" [class.btn-primary]="quickSizes().includes(s)" [attr.aria-pressed]="quickSizes().includes(s)"
                      (click)="toggleQuickSize(s)">{{ s }}</button>
                  }
                </div>
                <div class="row" style="align-items: flex-end">
                  <div class="field" style="width: 220px">
                    <label for="qa-colour">Colour</label>
                    <input id="qa-colour" class="input" maxlength="30" placeholder="e.g. Ivory (optional)" [ngModel]="quickColour" (ngModelChange)="quickColour = $event" />
                  </div>
                  <button class="btn btn-accent" type="button" [disabled]="!quickSizes().length || busy()" (click)="runQuickAdd()">
                    Add {{ quickSizes().length || '' }} variant{{ quickSizes().length === 1 ? '' : 's' }}
                  </button>
                </div>
                <p class="help muted small" style="margin-top: 8px">
                  SKUs are generated from the product SKU; prices default to the product's. {{ isNew() ? '' : 'Variants are saved immediately.' }}
                </p>
              </div>
            }

            @if (!rows().length) {
              <app-empty-state title="No variants yet"
                [message]="isNew() ? 'Add at least one size or colour before creating the product.' : 'This product has no variants.'" />
              @if (submitted() && isNew()) { <div class="card-body"><span class="error">Add at least one variant.</span></div> }
            } @else {
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Size</th><th>Colour</th><th>SKU</th><th>Barcode</th>
                      @if (canWrite) { <th class="num">Cost</th> }
                      <th class="num">Price</th><th class="num">Reorder at</th>
                      <th class="num">{{ isNew() ? 'Opening stock' : 'In stock' }}</th>
                      <th>Status</th>
                      @if (canEdit()) { <th><span class="sr-only">Actions</span></th> }
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of rows(); track r.key) {
                      <tr [style.opacity]="r.isActive ? 1 : 0.6">
                        <td>{{ r.size || '—' }}</td>
                        <td>{{ r.colour || '—' }}</td>
                        <td class="mono">{{ r.sku }}</td>
                        <td class="mono muted">{{ r.barcode || '—' }}</td>
                        @if (canWrite) { <td class="num">{{ r.costMinor | money }}</td> }
                        <td class="num">{{ r.priceMinor | money }}</td>
                        <td class="num">{{ r.reorderThreshold }}</td>
                        <td class="num">
                          {{ isNew() ? r.openingStock : r.stockQty }}
                          @if (!isNew() && r.isActive && r.stockQty <= r.reorderThreshold) { <span class="badge badge-warn">Low</span> }
                        </td>
                        <td>@if (r.isActive) { <span class="badge badge-ok">Active</span> } @else { <span class="badge">Archived</span> }</td>
                        @if (canEdit()) {
                          <td class="nowrap right">
                            <button class="btn btn-sm btn-ghost" type="button" (click)="openVariant(r)">Edit</button>
                            @if (isNew()) {
                              <button class="btn btn-sm btn-ghost" type="button" [attr.aria-label]="'Remove variant ' + r.sku" (click)="removeDraft(r)">Remove</button>
                            } @else {
                              <button class="btn btn-sm btn-ghost" type="button" [disabled]="busy()" (click)="toggleVariantArchive(r)">{{ r.isActive ? 'Archive' : 'Restore' }}</button>
                            }
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="card-head"><h2>Image</h2></div>
            <div class="card-body stack-sm">
              @if (detail()?.product?.imageUrl; as img) {
                <img class="hero" [src]="img" [alt]="p.name" />
              } @else {
                <div class="hero ph" aria-hidden="true">{{ (p.name.trim()[0] || '·').toUpperCase() }}</div>
              }
              @if (isNew()) {
                <p class="muted small">Save the product first, then add an image.</p>
              } @else if (canEdit()) {
                <div class="row" style="gap: 8px">
                  <button class="btn btn-sm" type="button" [disabled]="busy()" (click)="pickImage()">{{ detail()?.product?.imageUrl ? 'Change image' : 'Choose image' }}</button>
                  @if (detail()?.product?.imageUrl) {
                    <button class="btn btn-sm btn-ghost" type="button" [disabled]="busy()" (click)="removeImage()">Remove</button>
                  }
                </div>
              }
            </div>
          </section>

          @if (!isNew()) {
            <section class="card">
              <div class="card-head"><h2>Activity</h2></div>
              @if (historyLoading() && !history().length) {
                <app-loading [count]="4" />
              } @else if (historyError()) {
                <div class="card-body"><div class="notice notice-bad">{{ historyError() }}</div></div>
              } @else if (!history().length) {
                <app-empty-state title="No activity yet" />
              } @else {
                <ul class="history">
                  @for (h of history(); track $index) {
                    <li>
                      <div class="small muted">{{ h.at | dateTime }} · {{ h.actor }}</div>
                      <div>{{ h.summary }}</div>
                      <span class="badge" [class.badge-info]="h.kind === 'stock'">{{ h.kind === 'stock' ? 'Stock' : 'Edit' }}</span>
                    </li>
                  }
                </ul>
              }
            </section>
          }
        </div>
      </div>

      @if (variantOpen()) {
        <app-modal [title]="editingRow() ? 'Edit variant' : 'Add variant'" [width]="640" (closed)="variantOpen.set(false)">
          @let ve = variantErrors();
          <div class="stack">
            @if (variantError()) { <div class="notice notice-bad" role="alert">{{ variantError() }}</div> }
            <div class="form-grid">
              <div class="field">
                <label for="vf-size">Size</label>
                <select id="vf-size" class="select" [ngModel]="vf.sizeChoice" (ngModelChange)="vf.sizeChoice = $event">
                  <option value="">No size</option>
                  @for (s of sizeOptions(); track s) { <option [value]="s">{{ s }}</option> }
                  <option [value]="CUSTOM">Custom…</option>
                </select>
                @if (vf.sizeChoice === CUSTOM) {
                  <input class="input" aria-label="Custom size" maxlength="20" placeholder="Custom size" [ngModel]="vf.customSize" (ngModelChange)="vf.customSize = $event" />
                }
                @if (variantSubmitted() && ve.size) { <span class="error">{{ ve.size }}</span> }
              </div>
              <div class="field">
                <label for="vf-colour">Colour</label>
                <input id="vf-colour" class="input" maxlength="30" [ngModel]="vf.colour" (ngModelChange)="vf.colour = $event" />
              </div>
              <div class="field">
                <label for="vf-sku">Variant SKU <span class="req">*</span></label>
                <div class="row-nowrap" style="gap: 6px">
                  <input id="vf-sku" class="input mono" maxlength="50" [class.invalid]="variantSubmitted() && ve.sku" [ngModel]="vf.sku" (ngModelChange)="vf.sku = $event" />
                  <button class="btn btn-sm" type="button" (click)="suggestSku()">Suggest</button>
                </div>
                @if (variantSubmitted() && ve.sku) { <span class="error">{{ ve.sku }}</span> }
              </div>
              <div class="field">
                <label for="vf-bar">Barcode</label>
                <input id="vf-bar" class="input mono" maxlength="64" [ngModel]="vf.barcode" (ngModelChange)="vf.barcode = $event" />
                @if (variantSubmitted() && ve.barcode) { <span class="error">{{ ve.barcode }}</span> }
              </div>
              @if (canWrite) {
                <div class="field">
                  <label for="vf-cost">Cost price <span class="req">*</span></label>
                  <app-money-input inputId="vf-cost" [ngModel]="vf.costMinor" (ngModelChange)="vf.costMinor = $event" />
                  @if (variantSubmitted() && ve.cost) { <span class="error">{{ ve.cost }}</span> }
                </div>
              }
              <div class="field">
                <label for="vf-price">Selling price <span class="req">*</span></label>
                <app-money-input inputId="vf-price" [ngModel]="vf.priceMinor" (ngModelChange)="vf.priceMinor = $event" />
                @if (variantSubmitted() && ve.price) { <span class="error">{{ ve.price }}</span> }
              </div>
              <div class="field">
                <label for="vf-reorder">Reorder threshold</label>
                <input id="vf-reorder" class="input" type="number" min="0" step="1" [ngModel]="vf.reorderThreshold" (ngModelChange)="vf.reorderThreshold = $event" />
                @if (variantSubmitted() && ve.reorder) { <span class="error">{{ ve.reorder }}</span> }
                @else { <span class="help">Flagged as low stock at or below this.</span> }
              </div>
              @if (isNew()) {
                <div class="field">
                  <label for="vf-open">Opening stock</label>
                  <input id="vf-open" class="input" type="number" min="0" step="1" [ngModel]="vf.openingStock" (ngModelChange)="vf.openingStock = $event" />
                  @if (variantSubmitted() && ve.opening) { <span class="error">{{ ve.opening }}</span> }
                </div>
              } @else if (editingRow(); as er) {
                <div class="field">
                  <label>Current stock</label>
                  <div class="input" style="display: flex; align-items: center; background: var(--cream-deep)">{{ er.stockQty }}</div>
                  <span class="help">Change stock from Inventory → Stock.</span>
                </div>
              }
            </div>
          </div>
          <div footer>
            <button class="btn" type="button" (click)="variantOpen.set(false)">Cancel</button>
            <button class="btn btn-primary" type="button" [disabled]="busy()" (click)="saveVariant()">{{ busy() ? 'Saving…' : (editingRow() ? 'Save variant' : 'Add variant') }}</button>
          </div>
        </app-modal>
      }
    }
  `,
  styles: `
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
    @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } }
    .hero { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; border: 1px solid var(--beige); background: var(--cream); display: block; }
    .hero.ph { display: flex; align-items: center; justify-content: center; font-family: var(--font-serif); font-size: 56px; color: var(--beige-2); }
    .quick { background: var(--cream); border-bottom: 1px solid var(--beige); }
    .history { list-style: none; margin: 0; padding: 0; max-height: 420px; overflow: auto; }
    .history li { padding: 10px 20px; border-bottom: 1px solid #eee7da; display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
    .history li:last-child { border-bottom: none; }
  `,
})
export class ProductDetailPage {
  private readonly api = inject(ApiService).api;
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly settings = inject(SettingsStore);
  protected readonly canWrite = inject(SessionService).can('catalog.write');
  protected readonly CUSTOM = CUSTOM;

  /** Route param (undefined on /products/new). */
  readonly id = input<string | undefined>(undefined);

  protected readonly isNew = computed(() => this.id() === undefined || this.id() === '');
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly detail = signal<ProductDetail | null>(null);
  protected readonly categories = signal<CategoryDto[]>([]);
  protected readonly history = signal<ActivityEntry[]>([]);
  protected readonly historyLoading = signal(false);
  protected readonly historyError = signal('');
  protected readonly busy = signal(false);
  protected readonly submitted = signal(false);
  protected readonly formError = signal('');
  protected readonly skuState = signal<SkuState>('idle');
  protected readonly drafts = signal<VariantRow[]>([]);

  protected readonly isActive = computed(() => this.isNew() || (this.detail()?.product.isActive ?? true));
  protected readonly canEdit = computed(() => this.canWrite && this.isActive());
  protected readonly sizeOptions = computed(() => this.settings.settings().sizes);
  protected readonly rows = computed<VariantRow[]>(() => {
    if (this.isNew()) return this.drafts();
    return (this.detail()?.variants ?? []).map((v) => ({
      key: v.id, id: v.id, sku: v.sku, barcode: v.barcode ?? '', size: v.size, colour: v.colour, costMinor: v.costMinor,
      priceMinor: v.priceMinor, reorderThreshold: v.reorderThreshold, openingStock: 0, stockQty: v.stockQty, isActive: v.isActive,
    }));
  });

  // Plain mutable form models (event-driven); async results go through signals.
  protected p: ProductForm = emptyProduct();
  protected vf: VariantForm = this.blankVariantForm();

  protected readonly addingCategory = signal(false);
  protected readonly busyCategory = signal(false);
  protected readonly categoryError = signal('');
  protected newCategory = '';

  protected readonly quickOpen = signal(false);
  protected readonly quickSizes = signal<string[]>([]);
  protected quickColour = '';

  protected readonly variantOpen = signal(false);
  protected readonly editingRow = signal<VariantRow | null>(null);
  protected readonly variantSubmitted = signal(false);
  protected readonly variantError = signal('');

  private draftSeq = 0;
  private skuSeq = 0;
  private readonly runSkuCheck = debounce(() => void this.checkSku(), 400);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.init(id));
    });
  }

  // ───────────── loading ─────────────
  private async init(id: string | undefined): Promise<void> {
    this.loading.set(true);
    this.loadError.set('');
    this.formError.set('');
    this.submitted.set(false);
    this.skuState.set('idle');
    this.detail.set(null);
    this.history.set([]);
    this.drafts.set([]);
    void this.loadCategories();
    if (!id) {
      this.p = emptyProduct();
      this.loading.set(false);
      return;
    }
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      this.loadError.set('That product could not be found.');
      this.loading.set(false);
      return;
    }
    try {
      const d = await this.api.catalog.getProduct(numeric);
      this.detail.set(d);
      this.p = this.toForm(d);
      void this.loadHistory(numeric);
    } catch (e) {
      this.loadError.set(messageOf(e));
    } finally {
      this.loading.set(false);
    }
  }

  private toForm(d: ProductDetail): ProductForm {
    const x = d.product;
    return { sku: x.sku, name: x.name, categoryId: x.categoryId, brand: x.brand, description: x.description, defaultCostMinor: x.defaultCostMinor, defaultPriceMinor: x.defaultPriceMinor };
  }

  private async loadCategories(): Promise<void> {
    try { this.categories.set(await this.api.catalog.listCategories()); } catch { /* optional */ }
  }

  private async loadHistory(productId: number): Promise<void> {
    this.historyLoading.set(true);
    this.historyError.set('');
    try { this.history.set(await this.api.catalog.getHistory(productId)); }
    catch (e) { this.historyError.set(messageOf(e)); }
    finally { this.historyLoading.set(false); }
  }

  private refreshHistory(): void {
    const d = this.detail();
    if (d) void this.loadHistory(d.product.id);
  }

  // ───────────── categories ─────────────
  protected startAddCategory(): void { this.newCategory = ''; this.categoryError.set(''); this.addingCategory.set(true); }

  protected async addCategory(): Promise<void> {
    const name = this.newCategory.trim();
    if (!name) { this.categoryError.set('Enter a category name.'); return; }
    this.busyCategory.set(true);
    this.categoryError.set('');
    try {
      const c = await this.api.catalog.saveCategory({ name });
      await this.loadCategories();
      this.p.categoryId = c.id;
      this.addingCategory.set(false);
      this.toast.success(`Category "${c.name}" added.`);
    } catch (e) {
      this.categoryError.set(messageOf(e));
    } finally {
      this.busyCategory.set(false);
    }
  }

  // ───────────── SKU ─────────────
  protected onSkuChange(): void {
    this.skuState.set('idle');
    const sku = this.p.sku.trim();
    if (!sku || !SKU_RE.test(sku)) return;
    const current = this.detail()?.product.sku;
    if (current !== undefined && current.toLowerCase() === sku.toLowerCase()) return;
    this.skuState.set('checking');
    this.runSkuCheck();
  }

  private async checkSku(): Promise<void> {
    const sku = this.p.sku.trim();
    if (!sku || !SKU_RE.test(sku)) { this.skuState.set('idle'); return; }
    const my = ++this.skuSeq;
    try {
      const r = await this.api.catalog.checkSku({ sku, excludeProductId: this.detail()?.product.id ?? null });
      if (my === this.skuSeq && sku === this.p.sku.trim()) this.skuState.set(r.available ? 'ok' : 'taken');
    } catch {
      if (my === this.skuSeq) this.skuState.set('idle'); // the server re-checks on save
    }
  }

  // ───────────── validation ─────────────
  protected productErrors(): { name?: string; sku?: string; cost?: string; price?: string } {
    const e: { name?: string; sku?: string; cost?: string; price?: string } = {};
    const p = this.p;
    if (!p.name.trim()) e.name = 'Enter a product name.';
    const sku = p.sku.trim();
    if (!sku) e.sku = 'Enter a SKU.';
    else if (!SKU_RE.test(sku)) e.sku = 'Use letters, numbers and . _ - / only (start with a letter or number).';
    if (this.canWrite && (p.defaultCostMinor === null || p.defaultCostMinor < 0)) e.cost = 'Enter a valid cost (0 is allowed).';
    if (p.defaultPriceMinor === null || p.defaultPriceMinor < 0) e.price = 'Enter a valid selling price.';
    return e;
  }

  private resolvedSize(): string { return (this.vf.sizeChoice === CUSTOM ? this.vf.customSize : this.vf.sizeChoice).trim(); }

  protected variantErrors(): { size?: string; sku?: string; barcode?: string; cost?: string; price?: string; reorder?: string; opening?: string } {
    const e: { size?: string; sku?: string; barcode?: string; cost?: string; price?: string; reorder?: string; opening?: string } = {};
    const f = this.vf;
    const size = this.resolvedSize();
    const colour = f.colour.trim();
    const sku = f.sku.trim();
    const barcode = f.barcode.trim();
    const self = this.editingRow();
    const others = this.rows().filter((r) => r.key !== self?.key);
    if (size.length > 20) e.size = 'Size must be at most 20 characters.';
    if (!sku) e.sku = 'Enter a variant SKU.';
    else if (!SKU_RE.test(sku)) e.sku = 'Use letters, numbers and . _ - / only.';
    else if (others.some((r) => r.sku.toLowerCase() === sku.toLowerCase())) e.sku = 'Another variant already uses this SKU.';
    if (barcode && !BARCODE_RE.test(barcode)) e.barcode = 'Use letters, numbers and . _ - only.';
    else if (barcode && others.some((r) => r.barcode && r.barcode.toLowerCase() === barcode.toLowerCase())) e.barcode = 'Another variant already uses this barcode.';
    if (!e.size && others.some((r) => r.size.toLowerCase() === size.toLowerCase() && r.colour.toLowerCase() === colour.toLowerCase())) {
      e.size = `This product already has a ${[size, colour].filter(Boolean).join(' / ') || 'default'} variant.`;
    }
    if (this.canWrite && (f.costMinor === null || f.costMinor < 0)) e.cost = 'Enter a valid cost (0 is allowed).';
    if (f.priceMinor === null || f.priceMinor < 0) e.price = 'Enter a valid selling price.';
    if (!this.isWhole(f.reorderThreshold)) e.reorder = 'Enter a whole number, 0 or more.';
    if (this.isNew() && !this.isWhole(f.openingStock)) e.opening = 'Enter a whole number, 0 or more.';
    return e;
  }

  private isWhole(v: number | null): v is number { return typeof v === 'number' && Number.isInteger(v) && v >= 0; }

  // ───────────── product save / archive ─────────────
  protected async saveProduct(): Promise<void> {
    this.submitted.set(true);
    this.formError.set('');
    const e = this.productErrors();
    if (Object.keys(e).length || this.skuState() === 'taken') { this.formError.set('Please fix the highlighted fields.'); return; }
    if (this.isNew() && !this.drafts().length) { this.formError.set('Add at least one variant (use Quick add sizes for a fast start).'); return; }
    this.busy.set(true);
    try {
      const product = this.buildProductInput();
      if (this.isNew()) {
        const variants: VariantInput[] = this.drafts().map((r) => this.toVariantInput(r, true));
        const d = await this.api.catalog.createProduct({ product, variants });
        this.toast.success(`"${d.product.name}" created.`);
        await this.router.navigate(['/products', d.product.id], { replaceUrl: true });
      } else {
        const d = await this.api.catalog.updateProduct({ id: this.detail()!.product.id, product });
        this.detail.set(d);
        this.p = this.toForm(d);
        this.skuState.set('idle');
        this.refreshHistory();
        this.toast.success('Product saved.');
      }
    } catch (err) {
      this.handleSaveError(err);
    } finally {
      this.busy.set(false);
    }
  }

  private handleSaveError(err: unknown): void {
    if (err instanceof ApiError && err.code === 'DUPLICATE' && err.field === 'sku' && /product/i.test(err.message)) this.skuState.set('taken');
    this.formError.set(messageOf(err));
  }

  private buildProductInput() {
    const p = this.p;
    return {
      sku: p.sku.trim(), name: p.name.trim(), categoryId: p.categoryId, brand: p.brand.trim(), description: p.description.trim(),
      defaultCostMinor: p.defaultCostMinor ?? 0, defaultPriceMinor: p.defaultPriceMinor ?? 0,
    };
  }

  private toVariantInput(r: VariantRow, withOpening: boolean): VariantInput {
    const v: VariantInput = {
      sku: r.sku, barcode: r.barcode || null, size: r.size, colour: r.colour, costMinor: r.costMinor, priceMinor: r.priceMinor,
      reorderThreshold: r.reorderThreshold,
    };
    if (withOpening) v.openingStock = r.openingStock;
    return v;
  }

  protected async toggleProductArchive(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    const archive = d.product.isActive;
    if (archive) {
      const ok = await this.confirm.ask({
        title: 'Archive this product?',
        message: `"${d.product.name}" will be hidden from the till and product pickers. Stock history is kept and you can restore it any time.`,
        confirmLabel: 'Archive product', danger: true,
      });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      this.detail.set(await this.api.catalog.setProductArchived({ id: d.product.id, archived: archive }));
      this.refreshHistory();
      this.toast.success(archive ? 'Product archived.' : 'Product restored.');
    } catch (e) { this.toast.error(messageOf(e)); }
    finally { this.busy.set(false); }
  }

  // ───────────── image ─────────────
  protected async pickImage(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    this.busy.set(true);
    try {
      const res = await this.api.catalog.pickProductImage(d.product.id);
      if (res) { this.detail.set(res); this.refreshHistory(); this.toast.success('Image updated.'); }
    } catch (e) { this.toast.error(messageOf(e)); }
    finally { this.busy.set(false); }
  }

  protected async removeImage(): Promise<void> {
    const d = this.detail();
    if (!d) return;
    const ok = await this.confirm.ask({ title: 'Remove image?', message: 'The product will go back to showing a placeholder.', confirmLabel: 'Remove image', danger: true });
    if (!ok) return;
    this.busy.set(true);
    try { this.detail.set(await this.api.catalog.removeProductImage(d.product.id)); this.refreshHistory(); }
    catch (e) { this.toast.error(messageOf(e)); }
    finally { this.busy.set(false); }
  }

  // ───────────── variants ─────────────
  private blankVariantForm(): VariantForm {
    return { sku: '', barcode: '', sizeChoice: '', customSize: '', colour: '', costMinor: 0, priceMinor: null, reorderThreshold: 5, openingStock: 0 };
  }

  protected openVariant(row: VariantRow | null): void {
    this.variantError.set('');
    this.variantSubmitted.set(false);
    this.editingRow.set(row);
    if (row) {
      const known = this.sizeOptions().includes(row.size) || row.size === '';
      this.vf = {
        sku: row.sku, barcode: row.barcode, sizeChoice: known ? row.size : CUSTOM, customSize: known ? '' : row.size, colour: row.colour,
        costMinor: row.costMinor, priceMinor: row.priceMinor, reorderThreshold: row.reorderThreshold, openingStock: row.openingStock,
      };
    } else {
      this.vf = { ...this.blankVariantForm(), costMinor: this.p.defaultCostMinor ?? 0, priceMinor: this.p.defaultPriceMinor, reorderThreshold: this.settings.settings().lowStockDefault };
    }
    this.variantOpen.set(true);
  }

  protected suggestSku(): void {
    const taken = new Set(this.rows().filter((r) => r.key !== this.editingRow()?.key).map((r) => r.sku.toLowerCase()));
    this.vf.sku = this.makeSku(this.resolvedSize(), this.vf.colour.trim(), taken);
  }

  private makeSku(size: string, colour: string, taken: Set<string>): string {
    const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const productSku = this.p.sku.trim().replace(/[^A-Za-z0-9._\-/]/g, '');
    const base = [productSku, clean(size), clean(colour).slice(0, 3)].filter(Boolean).join('-').slice(0, 44) || 'SKU';
    let sku = base;
    for (let n = 2; taken.has(sku.toLowerCase()); n++) sku = `${base}-${n}`;
    return sku;
  }

  protected async saveVariant(): Promise<void> {
    this.variantSubmitted.set(true);
    this.variantError.set('');
    if (Object.keys(this.variantErrors()).length) return;
    const f = this.vf;
    const self = this.editingRow();
    const row: VariantRow = {
      key: self?.key ?? ++this.draftSeq, id: self?.id ?? null, sku: f.sku.trim(), barcode: f.barcode.trim(), size: this.resolvedSize(), colour: f.colour.trim(),
      costMinor: f.costMinor ?? 0, priceMinor: f.priceMinor ?? 0, reorderThreshold: f.reorderThreshold ?? 0, openingStock: f.openingStock ?? 0,
      stockQty: self?.stockQty ?? 0, isActive: self?.isActive ?? true,
    };
    if (this.isNew()) {
      this.drafts.update((l) => (self ? l.map((r) => (r.key === self.key ? row : r)) : [...l, row]));
      this.variantOpen.set(false);
      return;
    }
    this.busy.set(true);
    try {
      const productId = this.detail()!.product.id;
      const d = self
        ? await this.api.catalog.updateVariant({ id: self.id!, variant: this.toVariantInput(row, false) })
        : await this.api.catalog.createVariant({ productId, variant: this.toVariantInput(row, true) });
      this.detail.set(d);
      this.refreshHistory();
      this.variantOpen.set(false);
      this.toast.success(self ? 'Variant saved.' : 'Variant added.');
    } catch (e) {
      this.variantError.set(messageOf(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected removeDraft(r: VariantRow): void { this.drafts.update((l) => l.filter((x) => x.key !== r.key)); }

  protected async toggleVariantArchive(r: VariantRow): Promise<void> {
    if (r.id === null) return;
    const archive = r.isActive;
    if (archive) {
      const label = [r.size, r.colour].filter(Boolean).join(' / ') || r.sku;
      const ok = await this.confirm.ask({
        title: 'Archive this variant?',
        message: `${label} will no longer be sold. Its stock history is kept and you can restore it later.`,
        confirmLabel: 'Archive variant', danger: true,
      });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      this.detail.set(await this.api.catalog.setVariantArchived({ id: r.id, archived: archive }));
      this.refreshHistory();
      this.toast.success(archive ? 'Variant archived.' : 'Variant restored.');
    } catch (e) { this.toast.error(messageOf(e)); }
    finally { this.busy.set(false); }
  }

  // ───────────── quick add ─────────────
  protected toggleQuick(): void { this.quickOpen.update((v) => !v); }
  protected toggleQuickSize(s: string): void {
    this.quickSizes.update((l) => (l.includes(s) ? l.filter((x) => x !== s) : this.sizeOptions().filter((o) => o === s || l.includes(o))));
  }

  protected async runQuickAdd(): Promise<void> {
    this.formError.set('');
    if (!this.p.sku.trim() || !SKU_RE.test(this.p.sku.trim())) { this.formError.set('Enter a valid product SKU first: variant SKUs are generated from it.'); return; }
    const colour = this.quickColour.trim();
    if (colour.length > 30) { this.formError.set('Colour must be at most 30 characters.'); return; }
    const taken = new Set(this.rows().map((r) => r.sku.toLowerCase()));
    const existing = new Set(this.rows().map((r) => `${r.size.toLowerCase()}|${r.colour.toLowerCase()}`));
    const fresh: VariantRow[] = [];
    const skipped: string[] = [];
    for (const size of this.quickSizes()) {
      if (existing.has(`${size.toLowerCase()}|${colour.toLowerCase()}`)) { skipped.push(size); continue; }
      const sku = this.makeSku(size, colour, taken);
      taken.add(sku.toLowerCase());
      fresh.push({
        key: ++this.draftSeq, id: null, sku, barcode: '', size, colour, costMinor: this.p.defaultCostMinor ?? 0, priceMinor: this.p.defaultPriceMinor ?? 0,
        reorderThreshold: this.settings.settings().lowStockDefault, openingStock: 0, stockQty: 0, isActive: true,
      });
    }
    if (this.isNew()) {
      this.drafts.update((l) => [...l, ...fresh]);
    } else if (fresh.length) {
      this.busy.set(true);
      let added = 0;
      try {
        for (const r of fresh) {
          this.detail.set(await this.api.catalog.createVariant({ productId: this.detail()!.product.id, variant: this.toVariantInput(r, true) }));
          added++;
        }
      } catch (e) {
        this.formError.set(`Added ${added} of ${fresh.length} variants. ${messageOf(e)}`);
      } finally {
        this.busy.set(false);
        this.refreshHistory();
      }
      if (added === fresh.length) this.toast.success(`${added} variant${added === 1 ? '' : 's'} added.`);
    }
    if (skipped.length) this.toast.info(`Skipped sizes that already exist: ${skipped.join(', ')}.`);
    if (fresh.length && !this.formError()) { this.quickSizes.set([]); }
  }
}
