import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { RouterLink } from '@angular/router';
import type { Page, PurchaseListItem, SupplierDto } from '@shared/api';
import { ApiService, messageOf } from '../../core/api.service';
import { BizDatePipe, MoneyPipe } from '../../core/format.pipes';
import { titleCase } from '../../core/util';
import { EmptyStateComponent } from '../../ui/empty-state.component';
import { LoadingComponent } from '../../ui/loading.component';
import { PageHeaderComponent } from '../../ui/page-header.component';
import { PaginationComponent } from '../../ui/pagination.component';

type Status = '' | 'draft' | 'received' | 'cancelled';

@Component({
  selector: 'app-purchase-list-page',
  imports: [FormsModule, RouterLink, PageHeaderComponent, EmptyStateComponent, LoadingComponent, PaginationComponent, MoneyPipe, BizDatePipe],
  template: `
    <app-page-header title="Purchases" subtitle="Stock orders from suppliers. Stock increases only when a purchase is received.">
      <div actions>
        <a class="btn" routerLink="/purchases/returns">Supplier returns</a>
        <a class="btn btn-primary" routerLink="/purchases/new">New purchase</a>
      </div>
    </app-page-header>

    <div class="card">
      <div class="toolbar">
        <select class="select" aria-label="Filter by status" [ngModel]="status()" (ngModelChange)="setStatus($event)">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select class="select" aria-label="Filter by supplier" [ngModel]="supplierId()" (ngModelChange)="setSupplier($event)">
          <option [ngValue]="null">All suppliers</option>
          @for (s of suppliers(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
        </select>
        <label class="row-nowrap small muted">From <input class="input input-sm" type="date" [ngModel]="from()" (ngModelChange)="setFrom($event)" aria-label="From date" /></label>
        <label class="row-nowrap small muted">To <input class="input input-sm" type="date" [ngModel]="to()" (ngModelChange)="setTo($event)" aria-label="To date" /></label>
        @if (hasFilters()) { <button class="btn btn-sm btn-ghost" type="button" (click)="clear()">Clear filters</button> }
      </div>

      @if (loading()) {
        <app-loading [count]="6" />
      } @else if (error()) {
        <div class="notice notice-bad" role="alert">{{ error() }} <button class="btn btn-sm" type="button" (click)="load()">Retry</button></div>
      } @else if (data(); as d) {
        @if (d.items.length === 0) {
          <app-empty-state [title]="hasFilters() ? 'No purchases match these filters' : 'No purchases yet'"
            [message]="hasFilters() ? 'Adjust or clear the filters.' : 'Create a purchase to record stock you are ordering or have received.'">
            @if (!hasFilters()) { <a class="btn btn-primary" routerLink="/purchases/new">New purchase</a> }
          </app-empty-state>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Purchase</th><th>Date</th><th>Supplier</th><th>Status</th><th class="num">Items</th><th class="num">Total</th></tr></thead>
              <tbody>
                @for (p of d.items; track p.id) {
                  <tr class="clickable" (click)="open(p)">
                    <td><a class="strong" [routerLink]="['/purchases', p.id]" (click)="$event.stopPropagation()">{{ p.purchaseNo }}</a></td>
                    <td>{{ p.purchaseDate | bizDate }}</td>
                    <td>{{ p.supplierName }}</td>
                    <td><span class="badge" [class]="badge(p.status)">{{ label(p.status) }}</span></td>
                    <td class="num">{{ p.itemCount }}</td>
                    <td class="num">{{ p.totalCostMinor | money }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <app-pagination [page]="d.page" [pageSize]="d.pageSize" [total]="d.total" (pageChange)="goPage($event)" />
        }
      }
    </div>
  `,
})
export class PurchaseListPage {
  private readonly api = inject(ApiService).api;
  private readonly router = inject(Router);

  readonly data = signal<Page<PurchaseListItem> | null>(null);
  readonly suppliers = signal<SupplierDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly status = signal<Status>('');
  readonly supplierId = signal<number | null>(null);
  readonly from = signal('');
  readonly to = signal('');
  private page = 1;
  private seq = 0;

  constructor() {
    void this.loadSuppliers();
    void this.load();
  }

  hasFilters(): boolean { return !!(this.status() || this.supplierId() || this.from() || this.to()); }
  label(s: string): string { return titleCase(s); }
  badge(s: PurchaseListItem['status']): string { return s === 'received' ? 'badge-ok' : s === 'draft' ? 'badge-warn' : 'badge-bad'; }
  open(p: PurchaseListItem): void { void this.router.navigate(['/purchases', p.id]); }

  private async loadSuppliers(): Promise<void> {
    try { this.suppliers.set(await this.api.suppliers.list(true)); } catch { /* filter simply stays empty */ }
  }

  setStatus(v: Status): void { this.status.set(v); this.reset(); }
  setSupplier(v: number | null): void { this.supplierId.set(v); this.reset(); }
  setFrom(v: string): void { this.from.set(v); this.reset(); }
  setTo(v: string): void { this.to.set(v); this.reset(); }
  clear(): void { this.status.set(''); this.supplierId.set(null); this.from.set(''); this.to.set(''); this.reset(); }
  goPage(p: number): void { this.page = p; void this.load(); }
  private reset(): void { this.page = 1; void this.load(); }

  async load(): Promise<void> {
    const my = ++this.seq;
    this.loading.set(true);
    this.error.set('');
    // The API applies the date range only when both ends are given.
    const range = this.from() && this.to() ? { from: this.from(), to: this.to() } : {};
    try {
      const res = await this.api.purchases.list({
        ...(this.status() ? { status: this.status() as 'draft' | 'received' | 'cancelled' } : {}),
        ...(this.supplierId() ? { supplierId: this.supplierId() as number } : {}),
        ...range, page: this.page, pageSize: 25,
      });
      if (my === this.seq) this.data.set(res);
    } catch (e) {
      if (my === this.seq) this.error.set(messageOf(e));
    } finally {
      if (my === this.seq) this.loading.set(false);
    }
  }
}
