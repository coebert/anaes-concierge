import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ----------------------------------------------------------------------------
 * Date normalisation
 *
 * The app stores rota / leave / job-plan dates as plain `YYYY-MM-DD` strings.
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, which shifts the displayed
 * day in any non-UTC timezone. Likewise, `new Date().toISOString().slice(0,10)`
 * returns the UTC date, not the user's local date.
 *
 * Always use the helpers below for parsing, comparing, and formatting these
 * plain date values so they render consistently regardless of timezone.
 * -------------------------------------------------------------------------- */

const PLAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a plain `YYYY-MM-DD` string (or full ISO timestamp, or Date) into a
 * `Date` anchored at LOCAL midnight. Returns `null` for invalid/empty input.
 *
 * Use this whenever you need a `Date` object from a database date column.
 */
export function parseDateLocal(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (PLAIN_DATE_RE.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  // Full ISO timestamp (with time/zone) — let the runtime parse it.
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a `Date` to a `YYYY-MM-DD` string using LOCAL calendar fields.
 * Use this instead of `date.toISOString().slice(0, 10)` for plain dates.
 */
export function toISODateLocal(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Today as a local `YYYY-MM-DD` string. */
export function todayISO(): string {
  return toISODateLocal(new Date());
}

/** Today + `days` as a local `YYYY-MM-DD` string. */
export function addDaysISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toISODateLocal(d);
}

/**
 * Format a date (Date or `YYYY-MM-DD` / ISO string) as `DD/MM/YYYY` (British).
 * Returns `"—"` for null/undefined/invalid input. Timezone-safe.
 */
export function formatDateGB(value: Date | string | null | undefined): string {
  const d = parseDateLocal(value);
  if (!d) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Format a date as a long British label, e.g. "Monday, 26 May".
 * Returns `"—"` for invalid input. Timezone-safe.
 */
export function formatDateLongGB(value: Date | string | null | undefined): string {
  const d = parseDateLocal(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });
}

/**
 * Format a date as a short weekday + DD/MM/YYYY, e.g. "Mon 26/05/2026".
 */
export function formatDateWithWeekdayGB(value: Date | string | null | undefined): string {
  const d = parseDateLocal(value);
  if (!d) return "—";
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" });
  return `${wd} ${formatDateGB(d)}`;
}
