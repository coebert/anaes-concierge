// Pure-TS wellbeing score engine.
// Composite per-staff score over a rolling 90-day window derived only from
// data the app already collects. Higher score = better wellbeing.

const DAY_MS = 86_400_000;

export type WellbeingBand = "thriving" | "steady" | "strained" | "at_risk" | "unknown";

/**
 * Minimum number of the person's own rota rows inside the window before a
 * score is asserted. Below this the result is `coverage: "insufficient"` and
 * `band: "unknown"` — absent data must never read as "Thriving 100".
 * This is a coverage gate only; it does not alter weights, caps or bands.
 * 10 rows ≈ fewer than one session a week across 90 days.
 */
export const MIN_ASSESSABLE_SESSIONS = 10;

export type WellbeingCoverage = "insufficient" | "assessed";

export interface WellbeingDriver {
  key: string;
  label: string;
  value: number;
  normalised: number; // 0..1, higher = worse (harm-shaped)
  weight: number;
}

export interface WellbeingResult {
  /** 0..100, higher = better. Arithmetic is always computed, but when
   * `scoreKnown` is false it must not be displayed as a wellbeing level. */
  score: number;
  scoreKnown: boolean;
  coverage: WellbeingCoverage;
  /** Own rota rows found in the window (coverage basis). */
  sessionsInWindow: number;
  band: WellbeingBand;
  windowStart: string;
  windowEnd: string;
  drivers: WellbeingDriver[];
}

export interface RotaAssignmentLite {
  staff_id: string;
  session_date: string; // ISO
  session: "am" | "pm" | "eve" | "night" | string;
}

export interface RotaChangeLite {
  staff_id: string | null;
  session_date: string;
  hours_before_session: number | null;
}

export interface LeaveLite {
  staff_id: string;
  status: string;
  type: string;
  start_date: string;
  end_date: string;
  decided_at?: string | null;
}

export interface ExceptionReportLite {
  staff_id: string;
  event_date: string;
}

export interface WellbeingInput {
  staffId: string;
  now?: Date;
  windowDays?: number; // default 90
  assignments: RotaAssignmentLite[];
  changes: RotaChangeLite[];
  leave: LeaveLite[];
  exceptions: ExceptionReportLite[];
  bradfordScore?: number; // optional import
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Calendar-day key for a date/timestamp string (first 10 chars). */
const dayKey = (iso: string) => iso.slice(0, 10);

/**
 * Inclusive calendar-day window ending on the as-of day (UTC date of `now`).
 * windowDays=90 ⇒ 90 calendar days: [asOf − 89, asOf]. Comparison is by
 * day key only, so the time-of-day of `now` (midnight vs noon) never changes
 * which dates are in or out.
 */
export function wellbeingWindow(now: Date, windowDays = 90): { start: string; end: string } {
  const end = isoDay(now);
  const endMs = Date.parse(end + "T00:00:00Z");
  const start = isoDay(new Date(endMs - (windowDays - 1) * DAY_MS));
  return { start, end };
}

// Normalise a harm signal so that value=capAt (or worse) → 1, 0 → 0.
function harmNorm(value: number, capAt: number): number {
  if (capAt <= 0) return 0;
  return Math.max(0, Math.min(1, value / capAt));
}

function isWeekend(iso: string): boolean {
  const d = new Date(iso + "T00:00:00Z").getUTCDay();
  return d === 0 || d === 6;
}

export function computeWellbeing(input: WellbeingInput): WellbeingResult {
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? 90;
  const { start: windowStart, end: windowEnd } = wellbeingWindow(now, windowDays);

  const inWin = (iso: string) => {
    const k = dayKey(iso);
    return k >= windowStart && k <= windowEnd;
  };

  const myAssignments = input.assignments.filter(
    (a) => a.staff_id === input.staffId && inWin(a.session_date),
  );
  const totalSessions = myAssignments.length;
  const nights = myAssignments.filter((a) => a.session === "night").length;
  const evenings = myAssignments.filter((a) => a.session === "eve").length;
  const weekends = myAssignments.filter((a) => isWeekend(a.session_date)).length;
  void evenings;
  // UNION of qualifying rows: a weekend night counts once, not twice.
  const unsocialRows = myAssignments.filter(
    (a) => a.session === "night" || a.session === "eve" || isWeekend(a.session_date),
  ).length;
  const unsocialShare = totalSessions > 0 ? unsocialRows / totalSessions : 0;

  // Short-notice changes received (own session moved with <= 48h notice)
  const shortNoticeChanges = input.changes.filter(
    (c) =>
      c.staff_id === input.staffId &&
      inWin(c.session_date) &&
      c.hours_before_session !== null &&
      c.hours_before_session <= 48 &&
      c.hours_before_session >= -48,
  ).length;

  // Cancelled/rejected leave in window. Anchor the "when" on decided_at when
  // present (the rejection/cancellation event date is what actually affects
  // wellbeing), and fall back to start_date when the row lacks a decision
  // timestamp (older data, cancellations that predate decided_at).
  const badLeave = input.leave.filter((l) => {
    if (l.staff_id !== input.staffId) return false;
    if (l.status !== "rejected" && l.status !== "cancelled") return false;
    const anchor = l.decided_at ? l.decided_at.slice(0, 10) : l.start_date;
    return inWin(anchor);
  }).length;

  const exceptionsInWin = input.exceptions.filter(
    (e) => e.staff_id === input.staffId && inWin(e.event_date),
  ).length;

  const monthsInWindow = windowDays / 30;
  const nightsPerMonth = nights / monthsInWindow;
  const weekendsPerMonth = weekends / monthsInWindow;

  // Normalise (caps chosen against a 90-day window)
  const drivers: WellbeingDriver[] = [
    {
      key: "nights",
      label: `${nights} nights (${nightsPerMonth.toFixed(1)}/mo)`,
      value: nights,
      normalised: harmNorm(nightsPerMonth, 4), // 4 nights/mo = fully weighted
      weight: 0.22,
    },
    {
      key: "weekends",
      label: `${weekends} weekend sessions (${weekendsPerMonth.toFixed(1)}/mo)`,
      value: weekends,
      normalised: harmNorm(weekendsPerMonth, 3),
      weight: 0.18,
    },
    {
      key: "unsocial",
      label: `${Math.round(unsocialShare * 100)}% unsocial share`,
      value: unsocialShare,
      normalised: harmNorm(unsocialShare, 0.5),
      weight: 0.12,
    },
    {
      key: "shortnotice",
      label: `${shortNoticeChanges} short-notice changes`,
      value: shortNoticeChanges,
      normalised: harmNorm(shortNoticeChanges, 6),
      weight: 0.18,
    },
    {
      key: "leave",
      label: `${badLeave} rejected/cancelled leave`,
      value: badLeave,
      normalised: harmNorm(badLeave, 3),
      weight: 0.1,
    },
    {
      key: "exceptions",
      label: `${exceptionsInWin} trainee exception reports`,
      value: exceptionsInWin,
      normalised: harmNorm(exceptionsInWin, 4),
      weight: 0.1,
    },
    {
      key: "bradford",
      label: input.bradfordScore == null ? "Bradford —" : `Bradford ${input.bradfordScore}`,
      value: input.bradfordScore ?? 0,
      normalised: harmNorm(input.bradfordScore ?? 0, 300),
      weight: 0.1,
    },
  ];

  const harm = drivers.reduce((s, d) => s + d.normalised * d.weight, 0);
  const score = Math.round(Math.max(0, Math.min(100, (1 - harm) * 100)));

  const scoreKnown = totalSessions >= MIN_ASSESSABLE_SESSIONS;
  const band: WellbeingBand = !scoreKnown ? "unknown" : wellbeingBandFor(score);

  return {
    score,
    scoreKnown,
    coverage: scoreKnown ? "assessed" : "insufficient",
    sessionsInWindow: totalSessions,
    band,
    windowStart,
    windowEnd,
    drivers,
  };
}

/** Band thresholds (unchanged): 80 / 65 / 45 on the rounded score. */
export function wellbeingBandFor(score: number): Exclude<WellbeingBand, "unknown"> {
  return score >= 80 ? "thriving" : score >= 65 ? "steady" : score >= 45 ? "strained" : "at_risk";
}

export const WELLBEING_BAND_LABEL: Record<WellbeingBand, string> = {
  thriving: "Thriving",
  steady: "Steady",
  strained: "Strained",
  at_risk: "At risk",
  unknown: "Not enough data",
};

export const WELLBEING_BAND_TONE: Record<WellbeingBand, string> = {
  thriving: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  steady: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  strained: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  at_risk: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};
