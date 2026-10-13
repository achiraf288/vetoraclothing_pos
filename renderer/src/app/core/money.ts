/** Integer minor-unit money helpers for the renderer (no floating-point arithmetic on totals). */

export interface MoneyFormat {
  decimals: number;
  symbol: string;
  locale: string;
}

export function formatMinor(minor: number | null | undefined, f: MoneyFormat, withSymbol = true): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '';
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const factor = 10 ** f.decimals;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(f.decimals, '0');
  const wholeText = new Intl.NumberFormat(f.locale || 'en-US', { useGrouping: true }).format(whole);
  const body = f.decimals > 0 ? `${wholeText}.${frac}` : wholeText;
  return `${negative ? '-' : ''}${withSymbol && f.symbol ? f.symbol + ' ' : ''}${body}`;
}

/** Parse user text ("1,250.50") into minor units. Returns null when invalid or too precise. */
export function parseMinor(text: string | null | undefined, decimals: number): number | null {
  if (text === null || text === undefined) return null;
  const t = String(text).trim().replace(/,/g, '').replace(/\s+/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const minor = Number(m[1]) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Editable text for a minor amount: "1250.50" (no grouping, no symbol). */
export function minorToInput(minor: number | null | undefined, decimals: number): string {
  if (minor === null || minor === undefined) return '';
  const factor = 10 ** decimals;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(decimals, '0');
  return `${minor < 0 ? '-' : ''}${decimals > 0 ? `${whole}.${frac}` : whole}`;
}

/** Basis points → "12.5%". */
export function formatBps(bps: number): string {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '')}%`;
}
