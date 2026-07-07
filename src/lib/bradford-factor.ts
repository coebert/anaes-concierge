// Bradford Factor: standard NHS attendance-management score.
//
//   B = S² × D
//
// where over a rolling 12-month window:
//   S = number of distinct absence spells (each contiguous sickness = 1 spell)
//   D = total days lost
//
// Higher B => same total days spread across many short spells (which is what
// this score is designed to surface). Bands below are widely used across
// NHS Trusts; individual trusts calibrate them, so they're exported and
// re-usable rather than hard-coded elsewhere.

export type BradfordSpell = {
  /** ISO YYYY-MM-DD, inclusive. */
  start_date: string;
  /** ISO YYYY-MM-DD, inclusive. */
  end_date: string;
  /** If the spell starts and/or ends on a half-day, count as 0.5 rather than 1. */
  half_day_start?: boolean;
  half_day_end?: boolean;
};

export type BradfordBand = "green" | "amber" | "red" | "critical";

export type BradfordResult = {
  score: number;
  spellCount: number;
  totalDays: number;
  band: BradfordBand;
  /** The spells (or portions of them) that fell inside the window. */
  windowedSpells: BradfordSpell[];
  windowStart: string;
  windowEnd: string;
};

export const BAND_THRESHOLDS: Record<BradfordBand, { min: number; label: string; action: string }> = {
  green:    { min: 0,   label: "Green",    action: "No action required" },
  amber:    { min: 51,  label: "Amber",    action: "Informal review with line manager" },
  red:      { min: 201, label: "Red",      action: "Formal attendance review" },
  critical: { min: 451, label: "Critical", action: "Final review / capability" },
};

export function bandFor(score: number): BradfordBand {
  if (score >= BAND_THRESHOLDS.critical.min) return "critical";
  if (score >= BAND_THRESHOLDS.red.min) return "red";
  if (score >= BAND_THRESHOLDS.amber.min) return "amber";
  return "green";
}

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Overlap between spell and window, in whole days (inclusive of both ends). */
function overlapDays(spell: BradfordSpell, windowStart: Date, windowEnd: Date): number {
  const s = parseDate(spell.start_date);
  const e = parseDate(spell.end_date);
  const lo = s < windowStart ? windowStart : s;
  const hi = e > windowEnd ? windowEnd : e;
  if (hi < lo) return 0;
  let days = dayDiff(lo, hi) + 1;
  // Apply half-day flags only if the actual boundary date lies inside the window.
  if (spell.half_day_start && s >= windowStart && s <= windowEnd) days -= 0.5;
  if (spell.half_day_end && e >= windowStart && e <= windowEnd && s.getTime() !== e.getTime()) days -= 0.5;
  // A single-day spell can be marked half-day-start OR half-day-end (0.5 total),
  // not both — clamp.
  return Math.max(0, days);
}

export function computeBradfordFactor(
  spells: BradfordSpell[],
  referenceDate: Date = new Date(),
): BradfordResult {
  const windowEnd = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  ));
  const windowStart = new Date(windowEnd);
  windowStart.setUTCFullYear(windowStart.getUTCFullYear() - 1);
  windowStart.setUTCDate(windowStart.getUTCDate() + 1); // 12 months rolling, inclusive

  const inWindow = spells.filter(
    (sp) => overlapDays(sp, windowStart, windowEnd) > 0,
  );
  const totalDays = inWindow.reduce(
    (sum, sp) => sum + overlapDays(sp, windowStart, windowEnd),
    0,
  );
  const spellCount = inWindow.length;
  const score = spellCount * spellCount * totalDays;

  return {
    score,
    spellCount,
    totalDays,
    band: bandFor(score),
    windowedSpells: inWindow,
    windowStart: toISO(windowStart),
    windowEnd: toISO(windowEnd),
  };
}
