/**
 * Canonical leave counting and leave-year arithmetic.
 *
 * Conventions (shared by the request dialog, allowances, entitlement ledger,
 * study-leave budget and coordinator views):
 *   - Dates are calendar dates (YYYY-MM-DD) with no time zone; all maths is
 *     done on UTC midnights so DST never shifts a day.
 *   - Only Mon–Fri count as working days.
 *   - A half-day marker on the request's FIRST day (`half_day_start`) or LAST
 *     day (`half_day_end`) removes 0.5 from that day — but only when that
 *     boundary day is itself a counted working day inside the window being
 *     measured. A marker on a weekend boundary, or on a boundary that was
 *     clipped away by the leave-year window, has no effect.
 *   - A leave year runs from its start date (inclusive) to the same month/day
 *     one year later (exclusive) — anniversary arithmetic, not 365 days.
 */

export interface LeaveRange {
  start_date: string;
  end_date: string;
  half_day_start?: string | null;
  half_day_end?: string | null;
}

export interface DateWindow {
  /** inclusive */
  start: string;
  /** exclusive */
  endExclusive: string;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Strict calendar-date check: rejects 2026-02-30, 2026-13-01, etc. */
export function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toUtc(iso: string): number {
  if (!isValidIsoDate(iso)) throw new RangeError(`Invalid date: ${iso}`);
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * DAY_MS);
}

/** Same month/day `years` later; 29 Feb maps to 28 Feb in non-leap years. */
export function addYearsIso(iso: string, years: number): string {
  const y = Number(iso.slice(0, 4)) + years;
  const m = Number(iso.slice(5, 7));
  const d = Math.min(Number(iso.slice(8, 10)), daysInMonth(y, m));
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Leave year [start, next anniversary). */
export function leaveYearWindow(yearStartISO: string): DateWindow {
  toUtc(yearStartISO);
  return { start: yearStartISO, endExclusive: addYearsIso(yearStartISO, 1) };
}

/** Number of calendar days in the leave year (365 or 366). */
export function leaveYearLength(yearStartISO: string): number {
  const w = leaveYearWindow(yearStartISO);
  return Math.round((toUtc(w.endExclusive) - toUtc(w.start)) / DAY_MS);
}

/**
 * Leave-year start containing `dateISO`, for a year anchored on the
 * month/day of `anchorISO` (e.g. "2026-04-01" → 1 April years).
 */
export function leaveYearStartFor(dateISO: string, anchorISO: string): string {
  toUtc(dateISO);
  const y = Number(dateISO.slice(0, 4));
  const anchorMD = anchorISO.slice(5);
  let candidate = addYearsIso(`${y}-${anchorMD}`, 0);
  if (dateISO < candidate) candidate = addYearsIso(`${y - 1}-${anchorMD}`, 0);
  return candidate;
}

export function rangeOverlapsWindow(
  r: Pick<LeaveRange, "start_date" | "end_date">,
  w: DateWindow,
): boolean {
  return r.start_date < w.endExclusive && r.end_date >= w.start;
}

function isWeekday(ms: number): boolean {
  const dow = new Date(ms).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * Working days (Mon–Fri) covered by a leave request, optionally clipped to a
 * window BEFORE counting. Half-day markers only apply at retained, working
 * boundary days.
 */
export function countLeaveWorkingDays(r: LeaveRange, clip?: DateWindow): number {
  const s0 = toUtc(r.start_date);
  const e0 = toUtc(r.end_date);
  if (e0 < s0) return 0;
  let s = s0;
  let eIncl = e0;
  if (clip) {
    s = Math.max(s, toUtc(clip.start));
    eIncl = Math.min(eIncl, toUtc(clip.endExclusive) - DAY_MS);
  }
  let days = 0;
  for (let t = s; t <= eIncl; t += DAY_MS) {
    if (!isWeekday(t)) continue;
    let inc = 1;
    if (t === s0 && r.half_day_start) inc -= 0.5;
    if (t === e0 && r.half_day_end) inc -= 0.5;
    days += Math.max(0, inc);
  }
  return days;
}

/**
 * Fraction of a full leave year an employee is in post, × LTFT fraction,
 * rounded to 3 dp. Employment dates are inclusive calendar dates; the year
 * length is the real anniversary length (365/366).
 */
export function prorationFraction(
  yearStartISO: string,
  opts: { employmentStart?: string | null; leftAt?: string | null; ltft?: number | null } = {},
): number {
  const w = leaveYearWindow(yearStartISO);
  const yearStart = toUtc(w.start);
  const yearEndExcl = toUtc(w.endExclusive);
  const start =
    opts.employmentStart && isValidIsoDate(opts.employmentStart)
      ? Math.max(yearStart, toUtc(opts.employmentStart))
      : yearStart;
  const endExcl =
    opts.leftAt && isValidIsoDate(opts.leftAt)
      ? Math.min(yearEndExcl, toUtc(opts.leftAt) + DAY_MS)
      : yearEndExcl;
  const inPost = Math.max(0, Math.round((endExcl - start) / DAY_MS));
  const yearLen = Math.round((yearEndExcl - yearStart) / DAY_MS);
  const ltft =
    opts.ltft == null || !Number.isFinite(opts.ltft) ? 1 : Math.min(1, Math.max(0, opts.ltft));
  return Math.round((inPost / yearLen) * ltft * 1000) / 1000;
}
