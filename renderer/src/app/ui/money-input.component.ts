import { Component, forwardRef, inject, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { SettingsStore } from '../core/settings.store';

/**
 * Currency input bound to integer minor units (number | null).
 * Works with ngModel and reactive forms. Invalid text yields `null` plus a visible error state.
 */
@Component({
  selector: 'app-money-input',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MoneyInputComponent), multi: true }],
  template: `
    <div class="wrap" [class.bad]="invalid()">
      @if (showSymbol()) { <span class="sym">{{ store.settings().currencySymbol }}</span> }
      <input class="in" type="text" inputmode="decimal" autocomplete="off" [attr.id]="inputId() || null"
        [placeholder]="placeholder()" [disabled]="disabled()" [value]="text()"
        [attr.aria-invalid]="invalid()" (input)="onInput($any($event.target).value)" (blur)="onBlur()" />
    </div>
  `,
  styles: `
    .wrap { display: flex; align-items: center; height: 36px; border: 1px solid var(--beige-2); border-radius: var(--radius-sm); background: var(--white); padding: 0 11px; gap: 8px; }
    .wrap:focus-within { border-color: var(--accent); box-shadow: var(--focus); }
    .wrap.bad { border-color: var(--danger); }
    .sym { color: var(--ink-3); font-size: 13px; }
    .in { border: 0; outline: none; background: transparent; flex: 1; min-width: 0; font: inherit; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); }
  `,
})
export class MoneyInputComponent implements ControlValueAccessor {
  protected readonly store = inject(SettingsStore);
  readonly placeholder = input('0.00');
  readonly showSymbol = input(true);
  readonly inputId = input('');
  protected readonly text = signal('');
  protected readonly invalid = signal(false);
  protected readonly disabled = signal(false);
  private onChange: (v: number | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  writeValue(v: number | null): void { this.text.set(v === null || v === undefined ? '' : this.store.toInput(v)); this.invalid.set(false); }
  registerOnChange(fn: (v: number | null) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(d: boolean): void { this.disabled.set(d); }

  protected onInput(raw: string): void {
    this.text.set(raw);
    if (raw.trim() === '') { this.invalid.set(false); this.onChange(null); return; }
    const minor = this.store.parse(raw);
    this.invalid.set(minor === null);
    this.onChange(minor);
  }
  protected onBlur(): void {
    const minor = this.store.parse(this.text());
    if (minor !== null) this.text.set(this.store.toInput(minor));
    this.onTouched();
  }
}
