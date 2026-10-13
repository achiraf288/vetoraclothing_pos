import { Component, input } from '@angular/core';

/** Skeleton placeholder rows for loading states. */
@Component({
  selector: 'app-loading',
  template: `
    <div class="wrap" role="status" aria-live="polite">
      <span class="sr-only">Loading…</span>
      @for (r of rows(); track r) { <div class="skeleton" [style.width.%]="r % 3 === 0 ? 60 : 100"></div> }
    </div>
  `,
  styles: `.wrap { display: flex; flex-direction: column; gap: 12px; padding: 20px; } .skeleton { height: 16px; }`,
})
export class LoadingComponent {
  readonly count = input(5);
  protected rows = () => Array.from({ length: this.count() }, (_, i) => i + 1);
}
