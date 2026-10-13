import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { CategoryDto, ProductListItem, ProductSort } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { SettingsStore } from '../../core/settings.store';
import { debounce } from '../../core/util';
import { EmptyStateComponent, LoadingComponent, PageHeaderComponent, PaginationComponent } from '../../ui';

type StatusFilter = 'active' | 'archived' | 'all';

@Component({
  selector: 'app-product-list-page',
  imports: [FormsModule, RouterLink, EmptyStateComponent, LoadingComponent, PageHeaderComponent, PaginationComponent],
  template: `
    <app-page-header title="Products" subtitle="Your catalogue, with stock and pricing at a glance.">
      <div actions>
        @if (canWrite) {
          <a class="btn btn-primary" routerLink="/products/new">New product</a>
        }
      </div>
    </app-page-header>

    <div class="card">
      <div class="toolbar">
        <input class="input search" type="search" placeholder="Search name, SKU or brand…" aria-label="Search products"
          [ngModel]="search()" (ngModelChange)="onSearch($event)" />
        <select class="select" style="width: 190px" aria-label="Category" [ngModel]="categoryId()" (ngModelChange)="onCategory($event)">
          <option [ngValue]="null">All categories</option>
          @for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
        </select>
        <select class="select" style="width: 140px" aria-label="Status" [ngModel]="status()" (ngModelChange)="onStatus($event)">
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </select>
        <label class="check"><input type="checkbox" [ngModel]="lowOnly()" (ngModelChange)="onLowOnly($event)" /> Low stock only</label>
      </div>

      @if (error()) {
        <div class="card-body">
          <div class="notice notice-bad" role="alert">{{ error() }} <button class="btn btn-sm" type="button" (click)="load()">Retry</button></div>
        </div>
      }

      @if (loading() && !items().length) {
        <app-loading [count]="7" />
      } @else if (!items().length && !error()) {
        <app-empty-state title="No products found"
          [message]="filtersActive() ? 'Try adjusting the search or filters.' : 'Add your first product to start building the catalogue.'">
          @if (canWrite && !filtersActive()) { <a class="btn btn-primary" routerLink="/products/new">New product</a> }
        </app-empty-state>
      } @else if (items().length) {
        <div class="table-wrap" [style.opacity]="loading() ? 0.55 : 1">
          <table class="table">
            <thead>
              <tr>
                <th style="width: 56px"><span class="sr-only">Image</span></th>
                @for (c of columns; track c.key) {
                  <th class="sortable" [class.num]="c.num" [attr.aria-sort]="ariaSort(c.key)" tabindex="0"
                    (click)="setSort(c.key)" (keydown.enter)="setSort(c.key)">{{ c.label }}{{ arrow(c.key) }}</th>
                }
                <th>Variants</th>
              </tr>
            </thead>
            <tbody>
              @for (p of items(); track p.id) {
                <tr class="clickable" (click)="open(p)">
                  <td>
                    @if (p.imageUrl) {
                      <img class="thumb" [src]="p.imageUrl" [alt]="p.name" />
                    } @else {
                      <div class="thumb ph" aria-hidden="true">{{ initial(p.name) }}</div>
                    }
                  </td>
                  <td>
                    <a class="strong name" [routerLink]="['/products', p.id]" (click)="$event.stopPropagation()">{{ p.name }}</a>
                    @if (p.brand) { <div class="muted small">{{ p.brand }}</div> }
                    @if (!p.isActive) { <span class="badge">Archived</span> }
                  </td>
                  <td class="mono">{{ p.sku }}</td>
                  <td>{{ p.categoryName || '—' }}</td>
                  <td class="num">
                    {{ p.totalStock }}
                    @if (p.lowStockVariants > 0) {
                      <span class="badge badge-warn" [title]="p.lowStockVariants + ' variant(s) at or below reorder level'">Low · {{ p.lowStockVariants }}</span>
                    }
                  </td>
                  <td class="num">{{ priceRange(p) }}</td>
                  <td class="muted">{{ p.variantCount }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <app-pagination [page]="page()" [pageSize]="pageSize" [total]="total()" (pageChange)="goPage($event)" />
      }
    </div>
  `,
  styles: `
    .thumb { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; display: block; border: 1px solid var(--beige); background: var(--cream); }
    .thumb.ph { display: flex; align-items: center; justify-content: center; font-family: var(--font-serif); color: var(--ink-3); font-size: 17px; }
    .name { color: var(--ink); text-decoration: none; }
    .name:hover { color: var(--accent-strong); }
  `,
})
export class ProductListPage implements OnInit {
  private readonly api = inject(ApiService).api;
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  protected readonly canWrite = inject(SessionService).can('catalog.write');

  protected readonly pageSize = 25;
  protected readonly columns: Array<{ key: ProductSort; label: string; num?: boolean }> = [
    { key: 'name', label: 'Product' },
    { key: 'sku', label: 'SKU' },
    { key: 'category', label: 'Category' },
    { key: 'stock', label: 'Stock', num: true },
    { key: 'price', label: 'Price', num: true },
  ];

  protected readonly categories = signal<CategoryDto[]>([]);
  protected readonly items = signal<ProductListItem[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly search = signal('');
  protected readonly categoryId = signal<number | null>(null);
  protected readonly status = signal<StatusFilter>('active');
  protected readonly lowOnly = signal(false);
  protected readonly sort = signal<ProductSort>('name');
  protected readonly dir = signal<'asc' | 'desc'>('asc');
  protected readonly page = signal(1);
  protected readonly filtersActive = computed(() => !!this.search().trim() || this.categoryId() !== null || this.status() !== 'active' || this.lowOnly());

  private seq = 0;
  private readonly reload = debounce(() => { this.page.set(1); void this.load(); }, 250);

  async ngOnInit(): Promise<void> {
    void this.load();
    try { this.categories.set(await this.api.catalog.listCategories()); } catch { /* filter simply stays empty */ }
  }

  protected onSearch(v: string): void { this.search.set(v ?? ''); this.reload(); }
  protected onCategory(v: number | null): void { this.categoryId.set(v); this.page.set(1); void this.load(); }
  protected onStatus(v: StatusFilter): void { this.status.set(v); this.page.set(1); void this.load(); }
  protected onLowOnly(v: boolean): void { this.lowOnly.set(!!v); this.page.set(1); void this.load(); }
  protected goPage(p: number): void { this.page.set(p); void this.load(); }

  protected setSort(key: ProductSort): void {
    if (this.sort() === key) this.dir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { this.sort.set(key); this.dir.set('asc'); }
    this.page.set(1);
    void this.load();
  }
  protected arrow(key: ProductSort): string { return this.sort() === key ? (this.dir() === 'asc' ? ' ↑' : ' ↓') : ''; }
  protected ariaSort(key: ProductSort): string | null { return this.sort() === key ? (this.dir() === 'asc' ? 'ascending' : 'descending') : null; }

  protected open(p: ProductListItem): void { void this.router.navigate(['/products', p.id]); }
  protected initial(name: string): string { return (name.trim()[0] ?? '?').toUpperCase(); }
  protected priceRange(p: ProductListItem): string {
    if (p.minPriceMinor === null || p.maxPriceMinor === null) return '—';
    return p.minPriceMinor === p.maxPriceMinor ? this.settings.money(p.minPriceMinor) : `${this.settings.money(p.minPriceMinor)} – ${this.settings.amount(p.maxPriceMinor)}`;
  }

  protected async load(): Promise<void> {
    const my = ++this.seq;
    this.loading.set(true);
    this.error.set('');
    try {
      const res = await this.api.catalog.listProducts({
        search: this.search().trim() || undefined,
        categoryId: this.categoryId(),
        status: this.status(),
        lowStockOnly: this.lowOnly() || undefined,
        sort: this.sort(),
        dir: this.dir(),
        page: this.page(),
        pageSize: this.pageSize,
      });
      if (my !== this.seq) return;
      this.items.set(res.items);
      this.total.set(res.total);
    } catch (e) {
      if (my !== this.seq) return;
      this.error.set(messageOf(e));
      this.items.set([]);
      this.total.set(0);
    } finally {
      if (my === this.seq) this.loading.set(false);
    }
  }
}
