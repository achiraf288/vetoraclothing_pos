import { Component, input } from '@angular/core';

/** Serif page heading with optional subtitle and an actions slot: `<div actions>…</div>`. */
@Component({
  selector: 'app-page-header',
  template: `
    <header class="ph">
      <div>
        <h1>{{ title() }}</h1>
        @if (subtitle()) { <p class="sub">{{ subtitle() }}</p> }
      </div>
      <div class="actions no-print"><ng-content select="[actions]" /></div>
    </header>
  `,
  styles: `
    .ph { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
    h1 { font-size: 28px; line-height: 1.15; }
    .sub { color: var(--ink-3); margin-top: 4px; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  `,
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
}
