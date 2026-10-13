import { Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'app-pagination',
  template: `
    @if (total() > 0) {
      <div class="pg no-print">
        <span class="muted small">{{ from() }}–{{ to() }} of {{ total() }}</span>
        <div class="row-nowrap">
          <button class="btn btn-sm" type="button" [disabled]="page() <= 1" (click)="pageChange.emit(page() - 1)">Previous</button>
          <span class="small">Page {{ page() }} of {{ pages() }}</span>
          <button class="btn btn-sm" type="button" [disabled]="page() >= pages()" (click)="pageChange.emit(page() + 1)">Next</button>
        </div>
      </div>
    }
  `,
  styles: `.pg { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid var(--beige); }`,
})
export class PaginationComponent {
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  readonly pageChange = output<number>();
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  protected readonly from = computed(() => (this.page() - 1) * this.pageSize() + 1);
  protected readonly to = computed(() => Math.min(this.total(), this.page() * this.pageSize()));
}
