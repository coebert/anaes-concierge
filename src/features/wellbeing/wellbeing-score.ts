// Pure-TS wellbeing score engine.
// Composite per-staff score over a rolling 90-day window derived only from
// data the app already collects. Higher score = better wellbeing.

const DAY_MS = 86_400_000;

export type WellbeingBand = "thriving" | "steady" | "strained" | "at_risk";

export interface WellbeingDriver {
  key: string;
  label: string;
  value: number;
  normalised: number; // 0..1, higher = worse (harm-shaped)
  weight: number;
}

export interface WellbeingResult {
  score: number; // 0..100, higher = better
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
const parseDay = (iso: string) => new Date(iso + "T00:00:00Z").getTime();

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
  const windowStartMs = now.getTime() - windowDays * DAY_MS;
  const windowStart = isoDay(new Date(windowStartMs));
  const windowEnd = isoDay(now);

  const inWin = (iso: string) => parseDay(iso) >= windowStartMs && parseDay(iso) <= now.getTime();

  const myAssignments = input.assignments.filter(
    (a) => a.staff_id === input.staffId && inWin(a.session_date),
  );
  const totalSessions = myAssignments.length;
  const nights = myAssignments.filter((a) => a.session === "night").length;
  const evenings = myAssignments.filter((a) => a.session === "eve").length;
  const weekends = myAssignments.filter((a) => isWeekend(a.session_date)).length;
  const unsocialShare =
    totalSessions > 0 ? (nights + evenings + weekends) / totalSessions : 0;

  // Short-notice changes received (own session moved with <= 48h notice)
  const shortNoticeChanges = input.changes.filter(
    (c) =>
      c.staff_id === input.staffId &&
      inWin(c.session_date) &&
      c.hours_before_session !== null &&
      c.hours_before_session <= 48 &&
      c.hours_before_session >= -48,
  ).length;

  // Cancelled/denied leave in window
  const badLeave = input.leave.filter(
    (l) =>
      l.staff_id === input.staffId &&
      (l.status === "denied" || l.status === "cancelled") &&
      inWin(l.start_date),
  ).length;

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
      label: `${badLeave} denied/cancelled leave`,
      value: badLeave,
      normalised: harmNorm(badLeave, 3),
      weight: 0.10,
    },
    {
      key: "exceptions",
      label: `${exceptionsInWin} exception reports`,
      value: exceptionsInWin,
      normalised: harmNorm(exceptionsInWin, 4),
      weight: 0.10,
    },
    {
      key: "bradford",
      label:
        input.bradfordScore == null
          ? "Bradford —"
          : `Bradford ${input.bradfordScore}`,
      value: input.bradfordScore ?? 0,
      normalised: harmNorm(input.bradfordScore ?? 0, 300),
      weight: 0.10,
    },
  ];

  const harm = drivers.reduce((s, d) => s + d.normalised * d.weight, 0);
  const score = Math.round(Math.max(0, Math.min(100, (1 - harm) * 100)));

  const band: WellbeingBand =
    score >= 80 ? "thriving" : score >= 65 ? "steady" : score >= 45 ? "strained" : "at_risk";

  return { score, band, windowStart, windowEnd, drivers };
}

export const WELLBEING_BAND_LABEL: Record<WellbeingBand, string> = {
  thriving: "Thriving",
  steady: "Steady",
  strained: "Strained",
  at_risk: "At risk",
};

export const WELLBEING_BAND_TONE: Record<WellbeingBand, string> = {
  thriving: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  steady: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  strained: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  at_risk: "bg-destructive/15 text-destructive",
};
