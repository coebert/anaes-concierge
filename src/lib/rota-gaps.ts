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

// ---------------------------------------------------------------------------
// Classified gap report
// ---------------------------------------------------------------------------

/**
 * Why a particular day in the audit window has no rota assignment.
 *
 * - `pre_rotation`     – before the trainee's recorded `start_date`
 * - `rotation_ended`   – after the trainee's `rotation_end_date`
 * - `ltft_off`         – a weekend or contracted LTFT non-working day inside
 *                        the rotation window (expected to be empty)
 * - `sync_missing`     – a weekday inside the rotation window that the
 *                        trainee should be working: a real CLWRota sync gap
 */
export type GapKind =
  | "pre_rotation"
  | "rotation_ended"
  | "ltft_off"
  | "sync_missing";

export interface ClassifiedGapRange {
  kind: GapKind;
  startISO: string;
  endISO: string;
  /** Inclusive number of calendar days in the range. */
  days: number;
}

export interface ClassifiedGapReport {
  ranges: ClassifiedGapRange[];
  counts: Record<GapKind, number>;
  windowStartISO: string;
  windowEndISO: string;
}

/**
 * Walk every day in the audit window and bucket missing-assignment days into
 * one of four reasons. Days that have at least one shift break a run.
 * Contiguous days of the SAME kind are grouped into one range.
 */
export function classifyRotaGaps(
  assignmentDates: Set<string>,
  auditStartISO: string,
  auditEndISO: string,
  rotationStartISO: string | null,
  rotationEndISO: string | null,
  ltftDaysOff: number[] = [],
): ClassifiedGapReport {
  const start = parseDateLocal(auditStartISO);
  const end = parseDateLocal(auditEndISO);
  const empty: ClassifiedGapReport = {
    ranges: [],
    counts: { pre_rotation: 0, rotation_ended: 0, ltft_off: 0, sync_missing: 0 },
    windowStartISO: auditStartISO,
    windowEndISO: auditEndISO,
  };
  if (!start || !end || start.getTime() > end.getTime()) return empty;

  const rotStart = rotationStartISO ? parseDateLocal(rotationStartISO) : null;
  const rotEnd = rotationEndISO ? parseDateLocal(rotationEndISO) : null;
  const offSet = new Set<number>([0, 6, ...ltftDaysOff]);

  const counts: Record<GapKind, number> = {
    pre_rotation: 0, rotation_ended: 0, ltft_off: 0, sync_missing: 0,
  };
  const ranges: ClassifiedGapRange[] = [];
  let curKind: GapKind | null = null;
  let curStart: Date | null = null;
  let curEnd: Date | null = null;

  const flush = () => {
    if (curKind && curStart && curEnd) {
      ranges.push({
        kind: curKind,
        startISO: toISO(curStart),
        endISO: toISO(curEnd),
        days: Math.round((curEnd.getTime() - curStart.getTime()) / MS_DAY) + 1,
      });
    }
    curKind = null;
    curStart = null;
    curEnd = null;
  };

  for (let t = start.getTime(); t <= end.getTime(); t += MS_DAY) {
    const d = new Date(t);
    const iso = toISO(d);

    if (assignmentDates.has(iso)) {
      flush();
      continue;
    }

    let kind: GapKind;
    if (rotStart && d.getTime() < rotStart.getTime()) {
      kind = "pre_rotation";
    } else if (rotEnd && d.getTime() > rotEnd.getTime()) {
      kind = "rotation_ended";
    } else if (offSet.has(d.getDay())) {
      kind = "ltft_off";
    } else {
      kind = "sync_missing";
    }

    counts[kind] += 1;
    if (curKind === kind) {
      curEnd = d;
    } else {
      flush();
      curKind = kind;
      curStart = d;
      curEnd = d;
    }
  }
  flush();

  return { ranges, counts, windowStartISO: auditStartISO, windowEndISO: auditEndISO };
}

export const GAP_KIND_LABEL: Record<GapKind, string> = {
  pre_rotation: "Pre-rotation",
  rotation_ended: "Rotation ended",
  ltft_off: "LTFT / weekend off",
  sync_missing: "Sync missing",
};
