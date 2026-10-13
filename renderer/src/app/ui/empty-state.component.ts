import { Component, input } from '@angular/core';

/** Friendly empty state. Put an optional call to action in the content. */
@Component({
  selector: 'app-empty-state',
  template: `
    <div class="empty">
      <div class="mark" aria-hidden="true">◌</div>
      <h3>{{ title() }}</h3>
      @if (message()) { <p>{{ message() }}</p> }
      <div class="cta"><ng-content /></div>
    </div>
  `,
  styles: `
    .empty { text-align: center; padding: 44px 20px; color: var(--ink-3); }
    .mark { font-size: 30px; color: var(--beige-2); line-height: 1; }
    h3 { font-family: var(--font-serif); color: var(--ink-2); font-size: 17px; margin-top: 8px; }
    p { margin-top: 4px; max-width: 420px; margin-inline: auto; }
    .cta { margin-top: 14px; }
  `,
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly message = input<string>('');
}
