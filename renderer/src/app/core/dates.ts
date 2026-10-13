/** Local-calendar helpers. Business dates are local `YYYY-MM-DD`; timestamps are UTC ISO strings. */
const pad = (n: number) => String(n).padStart(2, '0');

export function toLocalDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const today = (): string => toLocalDate();

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return toLocalDate(new Date(y, m - 1, d + days));
}
export function startOfMonth(date: string = today()): string {
  return `${date.slice(0, 7)}-01`;
}
export function endOfMonth(date: string = today()): string {
  const [y, m] = date.split('-').map(Number);
  return toLocalDate(new Date(y, m, 0));
}
export function startOfWeek(date: string = today()): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const diff = (dt.getDay() + 6) % 7; // Monday first
  return toLocalDate(new Date(y, m - 1, d - diff));
}

/** "12 Oct 2026, 14:05" in the machine's local timezone. */
export function formatDateTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}
/** "12 Oct 2026" for a local `YYYY-MM-DD` business date (no timezone shift). */
export function formatDate(date: string | null | undefined, locale?: string): string {
  if (!date) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return formatDateTime(date, locale);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}
export function formatTime(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
}
/** Local calendar date (YYYY-MM-DD) of a UTC timestamp. */
export function localDateOf(iso: string): string {
  return toLocalDate(new Date(iso));
}
