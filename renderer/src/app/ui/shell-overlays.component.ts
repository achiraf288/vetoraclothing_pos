import { Component, inject } from '@angular/core';
import { ConfirmService } from '../core/confirm.service';
import { ToastService } from '../core/toast.service';
import { ModalComponent } from './modal.component';

/** Renders the global confirmation dialog and toast stack. Mounted once in the app root. */
@Component({
  selector: 'app-shell-overlays',
  imports: [ModalComponent],
  template: `
    @if (confirm.current(); as c) {
      <app-modal [title]="c.title" [width]="460" (closed)="c.resolve(false)">
        <p class="msg">{{ c.message }}</p>
        <div footer>
          <button class="btn" type="button" (click)="c.resolve(false)">{{ c.cancelLabel ?? 'Cancel' }}</button>
          <button class="btn" [class.btn-danger]="c.danger" [class.btn-primary]="!c.danger" type="button" (click)="c.resolve(true)">{{ c.confirmLabel ?? 'Confirm' }}</button>
        </div>
      </app-modal>
    }
    <div class="toasts no-print" aria-live="polite">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [class.ok]="t.kind === 'ok'" [class.bad]="t.kind === 'bad'" role="status">
          <span>{{ t.text }}</span>
          <button type="button" aria-label="Dismiss" (click)="toast.dismiss(t.id)">✕</button>
        </div>
      }
    </div>
  `,
  styles: `
    .msg { line-height: 1.55; color: var(--ink-2); white-space: pre-line; }
    .toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 200; max-width: 420px; }
    .toast { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; padding: 11px 14px; border-radius: 9px; background: var(--charcoal); color: #f6f1e6; box-shadow: var(--shadow-lg); }
    .toast.ok { background: #2f5a41; }
    .toast.bad { background: #8b2f27; }
    button { background: none; border: 0; color: inherit; opacity: 0.7; cursor: pointer; font-size: 12px; }
    button:hover { opacity: 1; }
  `,
})
export class ShellOverlaysComponent {
  protected readonly confirm = inject(ConfirmService);
  protected readonly toast = inject(ToastService);
}
