/**
 * Pure helpers for the trainee experience audit.
 *
 * Each lens takes already-fetched rows (assignments, theatre sessions,
 * specialty/target maps) and returns derived metrics. Kept pure so the
 * same code runs in both the trainee list and the per-trainee detail view.
 *
 * Inputs are kept loose (string | null) so callers can pass rows straight
 * from Supabase without extra mapping.
 */

export type RoleOnList =
  | "solo"
  | "supervised"
  | "supervising"
  | "observer"
  | string;

export interface AuditAssignment {
  id?: string;
  staff_id?: string;
  session_date: string;
  session: string;
  role_on_list: RoleOnList;
  theatre_session_id: string | null;
  supervisor_id: string | null;
  duty_type?: string | null;
  locally_modified?: boolean | null;
}
export interface AuditTheatreSession {
  id: string;
  specialty_id: string | null;
}

export interface AuditTarget {
  specialty_id: string;
  training_level: string;
  required_solo: number;
  required_supervised: number;
  required_sessions: number;
}

/* ---------- Lens 1: specialty breadth vs target ---------- */

export interface BreadthRow {
  specialty_id: string;
  specialty_name: string;
  done: number;          // total clinical sessions in this specialty
  target: number;        // required_sessions for trainee's level
  percent: number;       // 0-100, capped at 200 (over-exposure is still relevant)
  status: "deficit" | "ontrack" | "over";
}

export function computeBreadth(args: {
  trainingLevel: string | null;
  assignments: AuditAssignment[];
  tsById: Map<string, AuditTheatreSession>;
  specNames: Map<string, string>;
  targets: AuditTarget[];
}): BreadthRow[] {
  const { trainingLevel, assignments, tsById, specNames, targets } = args;
  const targetsForLevel = trainingLevel
    ? targets.filter((t) => t.training_level === trainingLevel)
    : [];
  if (!targetsForLevel.length) return [];

  const doneBySpec = new Map<string, number>();
  for (const a of assignments) {
    if (!["solo", "supervised"].includes(a.role_on_list)) continue;
    const ts = a.theatre_session_id ? tsById.get(a.theatre_session_id) : null;
    const specId = ts?.specialty_id ?? null;
    if (!specId) continue;
    doneBySpec.set(specId, (doneBySpec.get(specId) ?? 0) + 1);
  }

  return targetsForLevel
    .map((t) => {
      const done = doneBySpec.get(t.specialty_id) ?? 0;
      const target = t.required_sessions || (t.required_solo + t.required_supervised) || 0;
      const percent = target > 0 ? Math.min(200, Math.round((done / target) * 100)) : 0;
      const status: BreadthRow["status"] =
        percent < 75 ? "deficit" : percent <= 125 ? "ontrack" : "over";
      return {
        specialty_id: t.specialty_id,
        specialty_name: specNames.get(t.specialty_id) ?? "Unknown",
        done,
        target,
        percent,
        status,
      };
    })
    .sort((a, b) => a.percent - b.percent);
}

/* ---------- Lens 2: solo vs supervised mix ---------- */

export interface SoloMixRow {
  solo: number;
  supervised: number;
  totalClinical: number;
  soloRatio: number;       // 0..1
  targetSoloRatio: number; // derived from sum of targets at level
  gap: number;             // soloRatio - targetSoloRatio (negative = under-soloing)
}

export function computeSoloMix(args: {
  trainingLevel: string | null;
  assignments: AuditAssignment[];
  targets: AuditTarget[];
}): SoloMixRow {
  const { trainingLevel, assignments, targets } = args;
  let solo = 0;
  let supervised = 0;
  for (const a of assignments) {
    if (a.role_on_list === "solo") solo++;
    else if (a.role_on_list === "supervised") supervised++;
  }
  const totalClinical = solo + supervised;
  const soloRatio = totalClinical > 0 ? solo / totalClinical : 0;

  const targetsForLevel = trainingLevel
    ? targets.filter((t) => t.training_level === trainingLevel)
    : [];
  const reqSolo = targetsForLevel.reduce((s, t) => s + (t.required_solo || 0), 0);
  const reqSup = targetsForLevel.reduce((s, t) => s + (t.required_supervised || 0), 0);
  const totReq = reqSolo + reqSup;
  const targetSoloRatio = totReq > 0 ? reqSolo / totReq : 0;

  return {
    solo,
    supervised,
    totalClinical,
    soloRatio,
    targetSoloRatio,
    gap: soloRatio - targetSoloRatio,
  };
}

/* ---------- Lens 3: named supervisor exposure ---------- */

export interface SupervisorExposureRow {
  supervisor_id: string;
  supervisor_name: string;
  sessions: number;
}

export interface SupervisorExposure {
  distinctSupervisors: number;
  totalSupervisedSessions: number;
  diversityIndex: number;
  narrowExposure: boolean;
  rows: SupervisorExposureRow[];
}

export function computeSupervisorExposure(args: {
  assignments: AuditAssignment[];
  supNames: Map<string, string | null>;
  narrowThreshold?: number;
}): SupervisorExposure {
  const { assignments, supNames, narrowThreshold = 3 } = args;
  const counts = new Map<string, number>();
  let totalSup = 0;
  for (const a of assignments) {
    if (a.role_on_list !== "supervised") continue;
    if (!a.supervisor_id) continue;
    counts.set(a.supervisor_id, (counts.get(a.supervisor_id) ?? 0) + 1);
    totalSup++;
  }
  const rows: SupervisorExposureRow[] = Array.from(counts.entries())
    .map(([id, n]) => ({
      supervisor_id: id,
      supervisor_name: supNames.get(id) ?? "Unknown",
      sessions: n,
    }))
    .sort((a, b) => b.sessions - a.sessions);
  const distinct = rows.length;
  const diversityIndex = totalSup > 0 ? distinct / totalSup : 0;
  const narrowExposure = totalSup >= 6 && distinct < narrowThreshold;
  return {
    distinctSupervisors: distinct,
    totalSupervisedSessions: totalSup,
    diversityIndex,
    narrowExposure,
    rows,
  };
}

/* ---------- Lens 4: time-on-list / displacement ---------- */

/**
 * Estimate displacement: clinical assignments where the trainee was moved
 * off a "supervised" training list to "solo" duty after a manual edit.
 *
 * Detection strategy (with the data we have today):
 * - Count solo assignments where `locally_modified` is true. These represent
 *   manual coordinator interventions reassigning the trainee.
 * - Each session is treated as ~4 hours of training time lost when the
 *   original role would have been supervised on a training-flagged list.
 *
 * This is intentionally conservative — it will under-count rather than over-
 * count. A later iteration can use `rota_change_log` to detect role flips
 * directly.
 */
export interface DisplacementSummary {
  displacedSessions: number;
  approxHoursLost: number;
  recentDisplacements: Array<{
    id?: string;
    session_date: string;
    session: string;
  }>;
}

export function computeDisplacement(args: {
  assignments: AuditAssignment[];
}): DisplacementSummary {
  const { assignments } = args;
  const displaced = assignments.filter(
    (a) => a.role_on_list === "solo" && a.locally_modified === true,
  );
  return {
    displacedSessions: displaced.length,
    approxHoursLost: displaced.length * 4,
    recentDisplacements: displaced
      .sort((a, b) => (a.session_date < b.session_date ? 1 : -1))
      .slice(0, 5)
      .map((a) => ({ id: a.id, session_date: a.session_date, session: a.session })),
  };
}

/* ---------- Convenience: bundle all four lenses ---------- */

export interface FullAudit {
  breadth: BreadthRow[];
  soloMix: SoloMixRow;
  supervisorExposure: SupervisorExposure;
  displacement: DisplacementSummary;
}

export function computeFullAudit(args: {
  trainingLevel: string | null;
  assignments: AuditAssignment[];
  tsById: Map<string, AuditTheatreSession>;
  specNames: Map<string, string>;
  supNames: Map<string, string | null>;
  targets: AuditTarget[];
}): FullAudit {
  return {
    breadth: computeBreadth(args),
    soloMix: computeSoloMix(args),
    supervisorExposure: computeSupervisorExposure(args),
    displacement: computeDisplacement(args),
  };
}

/* ---------- ICU-block-only detection ----------
 *
 * A trainee is considered to be on an "ICU block only" when every remaining
 * clinical day in their rotation window is an ICU shift (no theatre lists,
 * obstetrics, on-calls etc.). Non-patient-facing days (SPA, teaching, admin,
 * non-clinical) are treated as neutral — they neither qualify nor disqualify.
 */
export const ICU_DUTY_TYPES = new Set(["icu_trainee", "icu_ct2_plus"]);
const NEUTRAL_DUTY_TYPES = new Set(["spa", "admin", "teaching", "non_clinical"]);

export function isIcuBlockOnly(
  assignments: Array<{ duty_type: string | null; session_date: string }>,
  fromDateIso: string,
  rotationEndDateIso: string | null,
): boolean {
  const window = assignments.filter((a) => {
    if (!a.session_date || a.session_date < fromDateIso) return false;
    if (rotationEndDateIso && a.session_date > rotationEndDateIso) return false;
    return true;
  });
  if (window.length === 0) return false;
  let hasIcu = false;
  for (const a of window) {
    const dt = a.duty_type ?? "";
    if (NEUTRAL_DUTY_TYPES.has(dt)) continue;
    if (ICU_DUTY_TYPES.has(dt)) {
      hasIcu = true;
      continue;
    }
    // Any other clinical duty type (theatre, obstetrics, on-call, …) disqualifies.
    return false;
  }
  return hasIcu;
}
