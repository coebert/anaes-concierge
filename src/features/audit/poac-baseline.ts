/**
 * POAU/POAC weekly baseline rule.
 *
 * Baseline = 1 if the week contains a POAU session on Wednesday (AM or PM),
 * otherwise 0. It is capped at 1 even if BOTH Wed AM and Wed PM are covered.
 * Additional = max(0, total assignments in the week - baseline).
 */
export type PoacAssignmentInput = {
  /** ISO date "YYYY-MM-DD" (local). */
  date: string;
  /** "am" | "pm" | other (e.g. on-call) — only "am"/"pm" can contribute to baseline. */
  session: string;
  /** Optional staff id; not required by the baseline rule. */
  staffId?: string | null;
};

export type PoacWeekStats = {
  weekStart: string; // ISO Monday of that week
  total: number;
  wedAm: number;
  wedPm: number;
  baseline: 0 | 1;
  additional: number;
};

function parseLocal(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function weekStartIso(d: Date): string {
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  const m = new Date(d);
  m.setDate(m.getDate() - diff);
  m.setHours(0, 0, 0, 0);
  const y = m.getFullYear();
  const mo = String(m.getMonth() + 1).padStart(2, "0");
  const da = String(m.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * Aggregate POAU assignments into per-week stats applying the baseline rule
 * (1 Wed session per week — AM or PM, never both).
 */
export function computePoacWeeklyStats(
  assignments: ReadonlyArray<PoacAssignmentInput>,
): PoacWeekStats[] {
  const buckets = new Map<
    string,
    { total: number; wedAm: number; wedPm: number }
  >();

  for (const a of assignments) {
    const d = parseLocal(a.date);
    if (!d) continue;
    const wk = weekStartIso(d);
    const b = buckets.get(wk) ?? { total: 0, wedAm: 0, wedPm: 0 };
    b.total += 1;
    if (d.getDay() === 3) {
      if (a.session === "am") b.wedAm += 1;
      else if (a.session === "pm") b.wedPm += 1;
    }
    buckets.set(wk, b);
  }

  return Array.from(buckets.entries())
    .map(([weekStart, b]) => {
      const baseline: 0 | 1 = b.wedAm > 0 || b.wedPm > 0 ? 1 : 0;
      const additional = Math.max(0, b.total - baseline);
      return {
        weekStart,
        total: b.total,
        wedAm: b.wedAm,
        wedPm: b.wedPm,
        baseline,
        additional,
      };
    })
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

/**
 * Whole-range validation that the baseline rule is satisfied for every week.
 * Returns a list of violations; empty array means the data passes validation.
 */
export type PoacBaselineViolation = {
  weekStart: string;
  reason: string;
  stats: PoacWeekStats;
};

export function validatePoacBaseline(
  weeks: ReadonlyArray<PoacWeekStats>,
): PoacBaselineViolation[] {
  const violations: PoacBaselineViolation[] = [];
  for (const w of weeks) {
    if (w.baseline !== 0 && w.baseline !== 1) {
      violations.push({
        weekStart: w.weekStart,
        reason: `baseline must be 0 or 1, got ${w.baseline}`,
        stats: w,
      });
      continue;
    }
    const hasWed = w.wedAm > 0 || w.wedPm > 0;
    if (hasWed && w.baseline !== 1) {
      violations.push({
        weekStart: w.weekStart,
        reason: "Wednesday AM or PM session present but baseline is not 1",
        stats: w,
      });
    }
    if (!hasWed && w.baseline !== 0) {
      violations.push({
        weekStart: w.weekStart,
        reason: "No Wednesday AM/PM session but baseline is not 0",
        stats: w,
      });
    }
    if (w.additional !== Math.max(0, w.total - w.baseline)) {
      violations.push({
        weekStart: w.weekStart,
        reason: `additional (${w.additional}) != max(0, total - baseline) = ${Math.max(0, w.total - w.baseline)}`,
        stats: w,
      });
    }
  }
  return violations;
}
