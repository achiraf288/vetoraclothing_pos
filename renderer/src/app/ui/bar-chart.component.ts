import { Component, computed, input } from '@angular/core';

export interface BarDatum { label: string; value: number; tooltip?: string; }

/** Dependency-free accessible SVG column chart (used for the dashboard sales trend). */
@Component({
  selector: 'app-bar-chart',
  template: `
    @if (bars().length) {
      <svg class="chart" [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="ariaLabel()" preserveAspectRatio="none">
        @for (g of grid(); track g.y) {
          <line [attr.x1]="padL" [attr.x2]="W" [attr.y1]="g.y" [attr.y2]="g.y" class="grid" />
          <text [attr.x]="padL - 6" [attr.y]="g.y + 4" class="axis" text-anchor="end">{{ g.label }}</text>
        }
        @for (b of bars(); track b.i) {
          <g>
            <title>{{ b.tooltip }}</title>
            <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" rx="3" class="bar" />
            @if (b.showLabel) { <text [attr.x]="b.x + b.w / 2" [attr.y]="H - 8" class="axis" text-anchor="middle">{{ b.label }}</text> }
          </g>
        }
      </svg>
    } @else {
      <div class="none muted">No data for this period.</div>
    }
  `,
  styles: `
    .chart { width: 100%; height: 220px; display: block; }
    .grid { stroke: var(--beige); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .axis { fill: var(--ink-3); font-size: 10px; font-family: var(--font-sans); }
    .bar { fill: var(--accent); }
    .bar:hover { fill: var(--accent-strong); }
    .none { padding: 40px; text-align: center; }
  `,
})
export class BarChartComponent {
  readonly data = input.required<BarDatum[]>();
  readonly ariaLabel = input('Bar chart');
  /** Formats the y-axis ticks. */
  readonly format = input<(v: number) => string>((v) => String(v));

  protected readonly W = 720;
  protected readonly H = 220;
  protected readonly padL = 54;
  private readonly padB = 24;

  private readonly max = computed(() => {
    const m = Math.max(0, ...this.data().map((d) => d.value));
    if (m === 0) return 1;
    const pow = 10 ** Math.floor(Math.log10(m));
    return Math.ceil(m / pow) * pow;
  });

  protected readonly grid = computed(() => {
    const plotH = this.H - this.padB - 8;
    return [0, 0.5, 1].map((f) => ({ y: 8 + plotH - plotH * f, label: this.format()(Math.round(this.max() * f)) }));
  });

  protected readonly bars = computed(() => {
    const d = this.data();
    const plotH = this.H - this.padB - 8;
    const slot = (this.W - this.padL) / Math.max(d.length, 1);
    const w = Math.min(34, slot * 0.64);
    const every = Math.ceil(d.length / 12);
    return d.map((x, i) => {
      const h = (x.value / this.max()) * plotH;
      return { i, label: x.label, tooltip: x.tooltip ?? `${x.label}: ${x.value}`, x: this.padL + slot * i + (slot - w) / 2, w, h: Math.max(h, x.value > 0 ? 2 : 0), y: 8 + plotH - h, showLabel: i % every === 0 };
    });
  });
}
