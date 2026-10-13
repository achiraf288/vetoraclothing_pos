import { Component, ElementRef, HostListener, afterNextRender, inject, input, output } from '@angular/core';

/**
 * Accessible modal dialog. Usage:
 *   <app-modal title="Edit supplier" (closed)="open.set(false)"> … <div footer>…</div> </app-modal>
 * Esc and backdrop click emit `closed`. Focus moves into the dialog and Tab is kept inside it.
 */
@Component({
  selector: 'app-modal',
  template: `
    <div class="backdrop" (mousedown)="onBackdrop($event)">
      <div class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="title()" [style.max-width.px]="width()" tabindex="-1">
        <div class="head">
          <h2>{{ title() }}</h2>
          <button class="btn btn-ghost btn-icon" type="button" aria-label="Close" (click)="closed.emit()">✕</button>
        </div>
        <div class="body"><ng-content /></div>
        <div class="foot"><ng-content select="[footer]" /></div>
      </div>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; background: rgba(38, 37, 31, 0.45); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 100; }
    .dialog { background: var(--warm-white); border-radius: 14px; box-shadow: var(--shadow-lg); width: 100%; max-height: calc(100vh - 48px); display: flex; flex-direction: column; border: 1px solid var(--beige); }
    .head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--beige); }
    h2 { font-family: var(--font-serif); font-size: 19px; }
    .body { padding: 20px; overflow: auto; }
    .foot { padding: 0 20px 18px; display: flex; justify-content: flex-end; gap: 10px; }
    .foot:empty { display: none; }
  `,
})
export class ModalComponent {
  readonly title = input.required<string>();
  readonly width = input(560);
  readonly closed = output<void>();
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly opener = document.activeElement as HTMLElement | null;

  constructor() {
    afterNextRender(() => {
      const host = this.el.nativeElement as HTMLElement;
      const target = host.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? host.querySelector<HTMLElement>('.dialog');
      target?.focus();
    });
  }

  ngOnDestroy(): void { this.opener?.focus?.(); }

  protected onBackdrop(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('backdrop')) this.closed.emit();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); this.closed.emit(); return; }
    if (e.key !== 'Tab') return;
    const dialog = (this.el.nativeElement as HTMLElement).querySelector('.dialog');
    if (!dialog) return;
    const f = Array.from(dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
