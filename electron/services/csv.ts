/**
 * CSV helpers. Output is UTF-8 with a BOM so Excel opens non-ASCII text
 * correctly. Cells that a spreadsheet could interpret as a formula
 * (=, +, -, @, tab, CR) are prefixed with an apostrophe to prevent CSV injection.
 */

export function plainMoney(minor: number, decimals: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (decimals === 0) return `${sign}${abs}`;
  const factor = 10 ** decimals;
  return `${sign}${Math.floor(abs / factor)}.${String(abs % factor).padStart(decimals, '0')}`;
}

export type CsvCell = string | number | null | undefined;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Plain negative numbers are fine; only text that starts like a formula is neutralised.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
