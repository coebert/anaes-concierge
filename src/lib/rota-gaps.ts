/**
 * Rota gap detection.
 *
 * A "gap" is a working day (Mon–Fri by default, minus the trainee's LTFT
 * non-working days) inside the trainee's rotation window that has zero
 * `rota_assignments` rows. Adjacent gap days — including across weekends or
 * LTFT off days — are grouped into a single date range so synchronisation
 * problems show up as contiguous spans instead of scattered single days.
 */
import { parseDateLocal } from "./utils";

const MS_DAY = 86_400_000;

export interface GapRange {
  startISO: string;
  endISO: string;
  /** Number of expected working weekdays missing in this span. */
  missingDays: number;
  /** Total calendar length of the span (inclusive). */
  spanDays: number;
}

export interface GapReport {
  ranges: GapRange[];
  totalMissingDays: number;
  totalExpectedDays: number;
  windowStartISO: string;
  windowEndISO: string;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the gap report.
 *
 * @param assignmentDates  Set of `YYYY-MM-DD` strings the trainee has any
 *                          rota assignment on.
 * @param windowStartISO   Inclusive start of the audit window.
 * @param windowEndISO     Inclusive end of the audit window.
 * @param ltftDaysOff      Day-of-week numbers (0 = Sun … 6 = Sat) the trainee
 *                          is contracted not to work. Weekends are always
 *                          treated as non-working unless explicitly absent.
 */
export function computeRotaGaps(
  assignmentDates: Set<string>,
  windowStartISO: string,
  windowEndISO: string,
  ltftDaysOff: number[] = [],
): GapReport {
  const start = parseDateLocal(windowStartISO);
  const end = parseDateLocal(windowEndISO);
  if (!start || !end || start.getTime() > end.getTime()) {
    return {
      ranges: [],
      totalMissingDays: 0,
      totalExpectedDays: 0,
      windowStartISO,
      windowEndISO,
    };
  }

  const offSet = new Set<number>([0, 6, ...ltftDaysOff]); // weekends + LTFT
  const ranges: GapRange[] = [];
  let curStart: Date | null = null;
  let curEnd: Date | null = null;
  let curMissing = 0;
  let totalMissing = 0;
  let totalExpected = 0;

  const flush = () => {
    if (curStart && curEnd && curMissing > 0) {
      ranges.push({
        startISO: toISO(curStart),
        endISO: toISO(curEnd),
        missingDays: curMissing,
        spanDays:
          Math.round((curEnd.getTime() - curStart.getTime()) / MS_DAY) + 1,
      });
    }
    curStart = null;
    curEnd = null;
    curMissing = 0;
  };

  for (let t = start.getTime(); t <= end.getTime(); t += MS_DAY) {
    const d = new Date(t);
    const iso = toISO(d);
    const isOff = offSet.has(d.getDay());
    const hasShift = assignmentDates.has(iso);

    if (isOff) {
      // Off day: doesn't count, but also doesn't break a contiguous gap.
      if (curStart) curEnd = d;
      continue;
    }
    totalExpected += 1;

    if (hasShift) {
      flush();
    } else {
      totalMissing += 1;
      curMissing += 1;
      if (!curStart) curStart = d;
      curEnd = d;
    }
  }
  flush();

  return {
    ranges,
    totalMissingDays: totalMissing,
    totalExpectedDays: totalExpected,
    windowStartISO,
    windowEndISO,
  };
}
