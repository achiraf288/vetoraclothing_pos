import { Component, OnInit, inject, input, output, signal, viewChild } from '@angular/core';
import type { ReceiptDto } from '@shared/api';
import { ApiService } from '../../core/api.service';
import { messageOf } from '../../core/api.service';
import { LoadingComponent } from '../../ui/loading.component';
import { ModalComponent } from '../../ui/modal.component';
import { ReceiptComponent } from './receipt.component';

/** Modal that loads a sale's receipt, previews it and prints it. */
@Component({
  selector: 'app-receipt-dialog',
  imports: [ModalComponent, LoadingComponent, ReceiptComponent],
  template: `
    <app-modal title="Receipt" [width]="440" (closed)="closed.emit()">
      @if (error()) { <div class="notice notice-bad">{{ error() }}</div> }
      @else if (receipt(); as r) {
        <div class="sheet"><app-receipt [data]="r" /></div>
      } @else { <app-loading [count]="6" /> }
      <div footer>
        <button class="btn" type="button" (click)="closed.emit()">Close</button>
        <button class="btn btn-primary" type="button" [disabled]="!receipt()" (click)="print()">Print receipt</button>
      </div>
    </app-modal>
  `,
  styles: `.sheet { background: var(--cream-deep); border-radius: 8px; padding: 18px 8px; display: flex; justify-content: center; overflow: auto; max-height: 62vh; }`,
})
export class ReceiptDialogComponent implements OnInit {
  readonly saleId = input.required<number>();
  readonly closed = output<void>();
  private readonly api = inject(ApiService).api;
  protected readonly receipt = signal<ReceiptDto | null>(null);
  protected readonly error = signal('');
  private readonly view = viewChild(ReceiptComponent);

  async ngOnInit(): Promise<void> {
    try { this.receipt.set(await this.api.sales.receipt(this.saleId())); }
    catch (e) { this.error.set(messageOf(e)); }
  }
  protected print(): void { this.view()?.print(); }
}
