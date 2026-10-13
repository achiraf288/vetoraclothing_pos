import { AppError } from '../main/errors';

/** Small, strict input validators shared by the services (the IPC layer also runs zod). */

export function text(value: unknown, label: string, max: number, required = false): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && v.length === 0) throw new AppError('VALIDATION', `${label} is required.`, label.toLowerCase());
  if (v.length > max) throw new AppError('VALIDATION', `${label} must be at most ${max} characters.`, label.toLowerCase());
  return v;
}

export function positiveInt(value: unknown, label: string, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError('VALIDATION', `${label} must be a whole number greater than zero.`, label.toLowerCase());
  }
  if (value > max) throw new AppError('VALIDATION', `${label} is too large.`, label.toLowerCase());
  return value;
}

export function nonNegativeMinor(value: unknown, label: string, max = 100_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AppError('VALIDATION', `${label} must be a valid amount.`, label.toLowerCase());
  }
  if (value < 0) throw new AppError('VALIDATION', `${label} cannot be negative.`, label.toLowerCase());
  if (value > max) throw new AppError('VALIDATION', `${label} is too large.`, label.toLowerCase());
  return value;
}

export function positiveMinor(value: unknown, label: string): number {
  const v = nonNegativeMinor(value, label);
  if (v === 0) throw new AppError('VALIDATION', `${label} must be greater than zero.`, label.toLowerCase());
  return v;
}

export function isoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError('VALIDATION', `${label} must be a date (YYYY-MM-DD).`, label.toLowerCase());
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new AppError('VALIDATION', `${label} is not a real date.`, label.toLowerCase());
  }
  return value;
}

export function dateRange(from: unknown, to: unknown): { from: string; to: string } {
  const f = isoDate(from, 'From');
  const t = isoDate(to, 'To');
  if (f > t) throw new AppError('VALIDATION', 'The start date must not be after the end date.', 'from');
  return { from: f, to: t };
}

export function pageParams(page?: number, pageSize?: number, maxSize = 100): { page: number; pageSize: number; offset: number } {
  const p = Number.isInteger(page) && (page as number) > 0 ? (page as number) : 1;
  const s = Number.isInteger(pageSize) && (pageSize as number) > 0 ? Math.min(pageSize as number, maxSize) : 25;
  return { page: p, pageSize: s, offset: (p - 1) * s };
}

export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const variantLabel = (v: { size: string; colour: string }): string =>
  [v.size, v.colour].filter(Boolean).join(' / ') || 'Default';
