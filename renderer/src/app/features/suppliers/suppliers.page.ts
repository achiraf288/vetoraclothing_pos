import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SupplierDto } from '@shared/api';
import { ApiError, ApiService, messageOf } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { ToastService } from '../../core/toast.service';
import { EmptyStateComponent } from '../../ui/empty-state.component';
import { LoadingComponent } from '../../ui/loading.component';
import { ModalComponent } from '../../ui/modal.component';
import { PageHeaderComponent } from '../../ui/page-header.component';

interface SupplierForm {
  id?: number;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
}

const blank = (): SupplierForm => ({ name: '', contactName: '', phone: '', email: '', address: '', notes: '', isActive: true });

@Component({
  selector: 'app-suppliers-page',
  imports: [FormsModule, PageHeaderComponent, EmptyStateComponent, LoadingComponent, ModalComponent],
  template: `
    <app-page-header title="Suppliers" subtitle="The vendors you buy stock from.">
      <div actions><button class="btn btn-primary" type="button" (click)="openNew()">New supplier</button></div>
    </app-page-header>

    <div class="card">
      <div class="toolbar">
        <input class="input search" type="search" placeholder="Search suppliers" aria-label="Search suppliers"
          [ngModel]="search()" (ngModelChange)="search.set($event)" />
        <label class="check"><input type="checkbox" [ngModel]="includeInactive()" (ngModelChange)="toggleInactive($event)" /> Show inactive</label>
        <span class="muted small grow right">{{ filtered().length }} supplier{{ filtered().length === 1 ? '' : 's' }}</span>
      </div>

      @if (loading()) {
        <app-loading [count]="6" />
      } @else if (error()) {
        <div class="notice notice-bad" role="alert">{{ error() }} <button class="btn btn-sm" type="button" (click)="load()">Retry</button></div>
      } @else if (filtered().length === 0) {
        <app-empty-state [title]="rows().length ? 'No suppliers match your search' : 'No suppliers yet'"
          [message]="rows().length ? 'Try a different search term.' : 'Add your first supplier to start recording purchases.'">
          @if (!rows().length) { <button class="btn btn-primary" type="button" (click)="openNew()">New supplier</button> }
        </app-empty-state>
      } @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (s of filtered(); track s.id) {
                <tr [class.muted]="!s.isActive">
                  <td><span class="strong">{{ s.name }}</span>@if (s.address) { <div class="muted small">{{ s.address }}</div> }</td>
                  <td>{{ s.contactName }}</td>
                  <td>{{ s.phone }}</td>
                  <td>{{ s.email }}</td>
                  <td>@if (s.isActive) { <span class="badge badge-ok">Active</span> } @else { <span class="badge">Inactive</span> }</td>
                  <td class="right nowrap">
                    <button class="btn btn-sm" type="button" (click)="openEdit(s)">Edit</button>
                    <button class="btn btn-sm btn-ghost" type="button" [disabled]="busyId() === s.id" (click)="toggleActive(s)">
                      {{ s.isActive ? 'Deactivate' : 'Activate' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    @if (form(); as f) {
      <app-modal [title]="f.id ? 'Edit supplier' : 'New supplier'" (closed)="closeForm()">
        <form id="supplier-form" class="form-grid" (ngSubmit)="save()" autocomplete="off">
          <div class="field span-all">
            <label for="s-name">Name <span class="req">*</span></label>
            <input id="s-name" class="input" name="name" [(ngModel)]="f.name" maxlength="100" required />
            @if (fieldErrors()['name']) { <span class="error">{{ fieldErrors()['name'] }}</span> }
          </div>
          <div class="field"><label for="s-contact">Contact name</label><input id="s-contact" class="input" name="contact" [(ngModel)]="f.contactName" maxlength="100" /></div>
          <div class="field"><label for="s-phone">Phone</label><input id="s-phone" class="input" name="phone" [(ngModel)]="f.phone" maxlength="40" /></div>
          <div class="field span-all"><label for="s-email">Email</label><input id="s-email" class="input" type="email" name="email" [(ngModel)]="f.email" maxlength="120" /></div>
          <div class="field span-all"><label for="s-addr">Address</label><input id="s-addr" class="input" name="address" [(ngModel)]="f.address" maxlength="200" /></div>
          <div class="field span-all"><label for="s-notes">Notes</label><textarea id="s-notes" class="textarea" rows="3" name="notes" [(ngModel)]="f.notes" maxlength="500"></textarea></div>
          @if (formError()) { <div class="notice notice-bad span-all" role="alert">{{ formError() }}</div> }
        </form>
        <ng-container footer>
          <button class="btn" type="button" (click)="closeForm()">Cancel</button>
          <button class="btn btn-primary" type="submit" form="supplier-form" [disabled]="saving() || !f.name.trim()">{{ saving() ? 'Saving…' : 'Save supplier' }}</button>
        </ng-container>
      </app-modal>
    }
  `,
})
export class SuppliersPage {
  private readonly api = inject(ApiService).api;
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);

  readonly rows = signal<SupplierDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly search = signal('');
  readonly includeInactive = signal(false);
  readonly busyId = signal<number | null>(null);

  readonly form = signal<SupplierForm | null>(null);
  readonly saving = signal(false);
  readonly formError = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.rows();
    return this.rows().filter((s) => [s.name, s.contactName, s.phone, s.email, s.address].some((x) => x.toLowerCase().includes(q)));
  });

  constructor() { void this.load(); }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.rows.set(await this.api.suppliers.list(this.includeInactive()));
    } catch (e) {
      this.error.set(messageOf(e));
    } finally {
      this.loading.set(false);
    }
  }

  toggleInactive(v: boolean): void { this.includeInactive.set(v); void this.load(); }

  openNew(): void { this.resetErrors(); this.form.set(blank()); }
  openEdit(s: SupplierDto): void { this.resetErrors(); this.form.set({ ...s }); }
  closeForm(): void { this.form.set(null); }
  private resetErrors(): void { this.formError.set(''); this.fieldErrors.set({}); }

  async save(): Promise<void> {
    const f = this.form();
    if (!f || this.saving() || !f.name.trim()) return;
    this.saving.set(true);
    this.resetErrors();
    try {
      await this.api.suppliers.save({
        ...(f.id !== undefined ? { id: f.id, isActive: f.isActive } : {}),
        name: f.name.trim(), contactName: f.contactName.trim(), phone: f.phone.trim(),
        email: f.email.trim(), address: f.address.trim(), notes: f.notes.trim(),
      });
      this.toast.success(f.id ? 'Supplier updated.' : 'Supplier added.');
      this.form.set(null);
      await this.load();
    } catch (e) {
      if (e instanceof ApiError && e.field) this.fieldErrors.set({ [e.field]: e.message });
      else this.formError.set(messageOf(e));
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(s: SupplierDto): Promise<void> {
    const next = !s.isActive;
    const ok = await this.confirm.ask({
      title: next ? 'Activate supplier?' : 'Deactivate supplier?',
      message: next
        ? `${s.name} will be available again when creating purchases.`
        : `${s.name} will no longer be selectable for new purchases. Existing records are kept.`,
      confirmLabel: next ? 'Activate' : 'Deactivate',
      danger: !next,
    });
    if (!ok) return;
    this.busyId.set(s.id);
    try {
      await this.api.suppliers.save({
        id: s.id, name: s.name, contactName: s.contactName, phone: s.phone, email: s.email,
        address: s.address, notes: s.notes, isActive: next,
      });
      this.toast.success(next ? 'Supplier activated.' : 'Supplier deactivated.');
      await this.load();
    } catch (e) {
      this.toast.error(messageOf(e));
    } finally {
      this.busyId.set(null);
    }
  }
}
