/**
 * Money is stored and calculated as integer minor units (e.g. cents).
 * No floating point is used for any financial total. Decimal text is parsed
 * and formatted with string/BigInt-free integer arithmetic.
 */

export class MoneyError extends Error {}

export function assertMinor(value: unknown, label = 'amount'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units`);
  }
}

/** Parse "1250", "1250.5" or "1,250.50" into minor units. Rejects excess precision. */
export function parseMoney(input: string, decimals = 2): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    throw new MoneyError('decimals must be an integer between 0 and 4');
  }
  const text = input.trim().replace(/,/g, '');
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError(`"${input}" is not a valid amount`);
  const [, sign, whole, frac = ''] = match;
  if (frac.length > decimals) {
    throw new MoneyError(`"${input}" has more than ${decimals} decimal place(s)`);
  }
  const minor = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || '0');
  if (!Number.isSafeInteger(minor)) throw new MoneyError('amount is too large');
  return sign ? -minor : minor;
}

export interface FormatOptions {
  decimals?: number;
  symbol?: string;
  locale?: string;
}

export function formatMoney(minor: number, options: FormatOptions = {}): string {
  assertMinor(minor);
  const { decimals = 2, symbol = '', locale = 'en-US' } = options;
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const factor = 10 ** decimals;
  const whole = Math.floor(abs / factor);
  const frac = String(abs % factor).padStart(decimals, '0');
  const wholeText = new Intl.NumberFormat(locale, { useGrouping: true }).format(whole);
  const body = decimals > 0 ? `${wholeText}.${frac}` : wholeText;
  return `${negative ? '-' : ''}${symbol ? symbol + ' ' : ''}${body}`;
}

/** amount × basisPoints / 10000, rounded half away from zero, integers only. */
export function percentOfMinor(amount: number, basisPoints: number): number {
  assertMinor(amount);
  assertMinor(basisPoints, 'basis points');
  const product = amount * basisPoints;
  if (!Number.isSafeInteger(product)) throw new MoneyError('amount is too large');
  const sign = product < 0 ? -1 : 1;
  const shifted = Math.abs(product) + 5000;
  // Exact integer division: no floating-point rounding involved.
  return sign * ((shifted - (shifted % 10000)) / 10000);
}

/**
 * Splits `total` across `weights` proportionally using the largest-remainder
 * method, so the parts always sum to exactly `total`.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  assertMinor(total, 'total');
  if (total < 0) throw new MoneyError('total must not be negative');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    if (total === 0) return weights.map(() => 0);
    throw new MoneyError('cannot allocate a non-zero total across zero weight');
  }
  const parts = weights.map((w, index) => {
    if (!Number.isSafeInteger(w) || w < 0) throw new MoneyError('weights must be non-negative integers');
    const product = total * w;
    if (!Number.isSafeInteger(product)) throw new MoneyError('amount is too large');
    const remainder = product % sum;
    return { index, base: (product - remainder) / sum, remainder };
  });
  let leftover = total - parts.reduce((a, p) => a + p.base, 0);
  const order = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const p of order) {
    if (leftover <= 0) break;
    p.base += 1;
    leftover -= 1;
  }
  return parts.sort((a, b) => a.index - b.index).map((p) => p.base);
}
