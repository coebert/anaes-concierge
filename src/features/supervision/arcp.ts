// Pure helpers for the educational-supervision / ARCP register.
//
// The evaluator combines a trainee's ARCP requirements (per training level)
// with their recorded progress and produces a readiness snapshot:
//   * overall % complete
//   * per-requirement status (complete / on_track / at_risk / behind)
//   * items that need attention before their ARCP date
//
// Status is derived from two signals:
//   1. actual/target ratio
//   2. months remaining until arcp_date
//
// A requirement is "on_track" when its projected completion (linear from now
// to arcp_date) meets the target. "at_risk" when it will fall short unless
// the pace increases. "behind" when it is materially off-target and the
// window is short. "complete" when actual ≥ target.

export type ReadinessStatus =
  | "complete"
  | "on_track"
  | "at_risk"
  | "behind"
  | "unknown";

export interface ArcpRequirement {
  id: string;
  training_level: string;
  code: string;
  label: string;
  category: string;
  target_value: number;
  unit: string;
  sort_order: number;
  active: boolean;
}

export interface ArcpProgress {
  id: string;
  trainee_id: string;
  requirement_id: string;
  current_value: number;
  arcp_date: string | null;
  notes: string | null;
}

export interface RequirementReadiness {
  requirement: ArcpRequirement;
  progress: ArcpProgress | null;
  current: number;
  target: number;
  ratio: number;
  monthsToArcp: number | null;
  status: ReadinessStatus;
  shortfall: number;
}

/** Months between two YYYY-MM-DD strings (b - a). Fractional. */
export function monthsBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const days = (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000;
  return days / 30.4375;
}

/** Classify one requirement's readiness. */
export function classifyRequirement(args: {
  requirement: ArcpRequirement;
  progress: ArcpProgress | null;
  today: string; // YYYY-MM-DD
  /** Optional trainee-level fallback ARCP date. */
  fallbackArcpDate?: string | null;
  /** Assume the trainee has been on this level this many months (for pacing). */
  monthsInLevel?: number;
}): RequirementReadiness {
  const target = args.requirement.target_value;
  const current = args.progress?.current_value ?? 0;
  const ratio = target > 0 ? current / target : 1;
  const arcpDate = args.progress?.arcp_date ?? args.fallbackArcpDate ?? null;
  const monthsToArcp = arcpDate ? monthsBetween(args.today, arcpDate) : null;
  const shortfall = Math.max(0, target - current);

  let status: ReadinessStatus;
  if (target === 0) {
    status = "unknown";
  } else if (current >= target) {
    status = "complete";
  } else if (monthsToArcp == null) {
    // No ARCP date — flag by ratio alone.
    status = ratio >= 0.75 ? "on_track" : ratio >= 0.5 ? "at_risk" : "behind";
  } else if (monthsToArcp <= 0) {
    // ARCP has passed but not complete → behind.
    status = "behind";
  } else {
    // Pace check: how much of the 12-month training year is left?
    // Assume a nominal 12-month cycle; scale expected progress accordingly.
    const yearElapsedFrac = Math.min(1, Math.max(0, 1 - monthsToArcp / 12));
    const expectedRatio = yearElapsedFrac;
    const paceRatio = ratio / Math.max(0.05, expectedRatio);
    if (monthsToArcp <= 2 && ratio < 0.9) {
      status = ratio < 0.6 ? "behind" : "at_risk";
    } else if (paceRatio >= 0.9) {
      status = "on_track";
    } else if (paceRatio >= 0.6) {
      status = "at_risk";
    } else {
      status = "behind";
    }
  }
  void args.monthsInLevel; // reserved for future weighting

  return {
    requirement: args.requirement,
    progress: args.progress,
    current,
    target,
    ratio,
    monthsToArcp,
    status,
    shortfall,
  };
}

export interface TraineeReadiness {
  traineeId: string;
  trainingLevel: string | null;
  items: RequirementReadiness[];
  percentComplete: number;
  worstStatus: ReadinessStatus;
  behindCount: number;
  atRiskCount: number;
  nextArcpDate: string | null;
}

const STATUS_RANK: Record<ReadinessStatus, number> = {
  behind: 0, at_risk: 1, on_track: 2, unknown: 3, complete: 4,
};

/** Combine per-requirement readiness into a trainee summary. */
export function summariseTraineeReadiness(args: {
  traineeId: string;
  trainingLevel: string | null;
  requirements: ArcpRequirement[];
  progress: ArcpProgress[];
  today: string;
  fallbackArcpDate?: string | null;
}): TraineeReadiness {
  const applicable = args.requirements.filter(
    (r) => r.active && r.training_level === args.trainingLevel,
  );
  const progById = new Map(args.progress.map((p) => [p.requirement_id, p]));
  const items = applicable.map((r) =>
    classifyRequirement({
      requirement: r,
      progress: progById.get(r.id) ?? null,
      today: args.today,
      fallbackArcpDate: args.fallbackArcpDate,
    }),
  );
  const totalTarget = items.reduce((s, i) => s + i.target, 0);
  const totalCurrent = items.reduce(
    (s, i) => s + Math.min(i.current, i.target),
    0,
  );
  const percentComplete = totalTarget > 0
    ? Math.round((totalCurrent / totalTarget) * 100)
    : 0;
  const worstStatus = items.length
    ? items.reduce<ReadinessStatus>(
        (worst, i) => (STATUS_RANK[i.status] < STATUS_RANK[worst] ? i.status : worst),
        "complete",
      )
    : "unknown";
  const behindCount = items.filter((i) => i.status === "behind").length;
  const atRiskCount = items.filter((i) => i.status === "at_risk").length;
  const dates = items
    .map((i) => i.progress?.arcp_date)
    .filter((d): d is string => !!d)
    .sort();
  return {
    traineeId: args.traineeId,
    trainingLevel: args.trainingLevel,
    items,
    percentComplete,
    worstStatus,
    behindCount,
    atRiskCount,
    nextArcpDate: dates[0] ?? args.fallbackArcpDate ?? null,
  };
}

export function readinessStatusLabel(s: ReadinessStatus): string {
  switch (s) {
    case "complete": return "Complete";
    case "on_track": return "On track";
    case "at_risk": return "At risk";
    case "behind": return "Behind";
    case "unknown": return "—";
  }
}

export function readinessStatusTone(s: ReadinessStatus):
  "success" | "warning" | "danger" | "muted" {
  switch (s) {
    case "complete":
    case "on_track":
      return "success";
    case "at_risk":
      return "warning";
    case "behind":
      return "danger";
    case "unknown":
      return "muted";
  }
}
