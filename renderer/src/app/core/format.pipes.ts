import { Pipe, PipeTransform, inject } from '@angular/core';
import { SettingsStore } from './settings.store';
import { formatDate, formatDateTime } from './dates';

/** `{{ minor | money }}` → "Rs 1,250.00". `| money:false` omits the symbol. */
@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  private readonly s = inject(SettingsStore);
  transform(minor: number | null | undefined, symbol = true): string {
    return symbol ? this.s.money(minor) : this.s.amount(minor);
  }
}

/** UTC ISO timestamp → local date and time. */
@Pipe({ name: 'dateTime' })
export class DateTimePipe implements PipeTransform {
  private readonly s = inject(SettingsStore);
  transform(iso: string | null | undefined): string { return formatDateTime(iso, this.s.settings().locale); }
}

/** Business date (YYYY-MM-DD) → "12 Oct 2026". */
@Pipe({ name: 'bizDate' })
export class BizDatePipe implements PipeTransform {
  private readonly s = inject(SettingsStore);
  transform(date: string | null | undefined): string { return formatDate(date, this.s.settings().locale); }
}
