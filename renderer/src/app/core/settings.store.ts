import { Injectable, computed, inject, signal } from '@angular/core';
import type { DisplaySettings } from '@shared/api';
import { ApiService } from './api.service';
import { formatMinor, parseMinor, minorToInput, type MoneyFormat } from './money';

const FALLBACK: DisplaySettings = {
  shopName: 'Vetora POS', shopAddress: '', shopPhone: '', shopEmail: '', receiptFooter: '', receiptPaperWidthMm: 80,
  taxEnabled: false, taxLabel: 'Tax', taxRateBps: 0, currencyCode: 'LKR', currencySymbol: 'Rs', currencyDecimals: 2,
  locale: 'en-LK', sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], lowStockDefault: 5, allowNegativeStock: false,
};

/** Display settings (currency, sizes, shop details) shared by every screen. */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly api = inject(ApiService).api;
  private readonly state = signal<DisplaySettings>(FALLBACK);
  readonly settings = this.state.asReadonly();
  readonly format = computed<MoneyFormat>(() => ({
    decimals: this.state().currencyDecimals,
    symbol: this.state().currencySymbol,
    locale: this.state().locale,
  }));

  async refresh(): Promise<void> {
    this.state.set(await this.api.settings.getDisplay());
  }
  /** "Rs 1,250.00" */
  money(minor: number | null | undefined): string { return formatMinor(minor, this.format()); }
  /** "1,250.00" */
  amount(minor: number | null | undefined): string { return formatMinor(minor, this.format(), false); }
  parse(text: string | null | undefined): number | null { return parseMinor(text, this.state().currencyDecimals); }
  toInput(minor: number | null | undefined): string { return minorToInput(minor, this.state().currencyDecimals); }
}
