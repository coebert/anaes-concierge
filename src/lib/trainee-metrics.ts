// Pure helpers for per-trainee individual metrics (extracted so dashboard
// and trainee detail page share the same logic).

export type MetricAssignment = {
  role_on_list: string;
  session: string;
  duty_type?: string | null;
  theatre_session_id: string | null;
  session_date?: string | null;
};

export type TraineeMetricsWarning = {
  level: "info" | "warn";
  code:
    | "low_real_list_count"
    | "no_real_lists"
    | "high_unmatched_ratio"
    | "no_theatre_session_rows";
  message: string;
};

/** Minimum matched daytime lists below which a solo% is statistically unreliable. */
export const LOW_REAL_LIST_THRESHOLD = 5;
/** Unmatched theatre rows / total theatre rows above which import quality is poor. */
export const HIGH_UNMATCHED_RATIO = 0.5;

export type TraineeMetrics = {
  weeksAtSalisbury: number | null;
  weeksRemaining: number | null;
  daytimeLists: number;
  soloLists: number;
  soloDaytimeLists: number;
  soloDaytimePct: number | null;
  supervisedLists: number;
  totalClinical: number;
  onCallLists: number;
  onCallPct: number | null;
  totalAssignments: number;
  /** Theatre-duty rows with no matched theatre_session_id (unmatched CLWRota labels). */
  unmatchedTheatreRows: number;
  /** Sanity-check warnings to surface alongside the card. */
  warnings: TraineeMetricsWarning[];
  specialtyBreakdown: Array<{ name: string; count: number; percent: number }>;
};

export function computeTraineeMetrics(
  assignments: MetricAssignment[],
  startDate: string | null | undefined,
  specialtyIdBySession: Map<string, string | null | undefined>,
  specialtyNameById: Map<string, string>,
  now: number = Date.now(),
  rotationEndDate: string | null | undefined = null,
): TraineeMetrics {
  const start = startDate ? new Date(startDate) : null;
  const weeksAtSalisbury = start
    ? Math.max(0, Math.floor((now - start.getTime()) / (1000 * 60 * 60 * 24 * 7)))
    : null;
  const end = rotationEndDate ? new Date(rotationEndDate) : null;
  const weeksRemaining = end
    ? Math.max(0, Math.ceil((end.getTime() - now) / (1000 * 60 * 60 * 24 * 7)))
    : null;

  // A real anaesthetic list requires a theatre_session_id (i.e. it was matched
  // to a known theatre booking on import). Rows with duty_type='theatre' but
  // no theatre_session_id are unmatched CLWRota labels like "Off Day",
  // "Available", "Emergency Theatre", surgeon-name shorthand, etc. They
  // default to role_on_list='solo' on import, which previously inflated the
  // solo-daytime percentage to near 100% — particularly for junior trainees
  // whose CLWRota entries often lack a parsable theatre name.
  const daytimeAssignments = assignments.filter(
    (a) =>
      a.duty_type === "theatre" &&
      (a.session === "am" || a.session === "pm") &&
      a.theatre_session_id != null,
  );
  const daytimeLists = daytimeAssignments.length;
  const soloLists = assignments.filter(
    (a) =>
      a.role_on_list === "solo" &&
      a.duty_type === "theatre" &&
      a.theatre_session_id != null,
  ).length;
  const soloDaytimeLists = daytimeAssignments.filter((a) => a.role_on_list === "solo").length;
  const soloDaytimePct = daytimeLists > 0
    ? Math.round((soloDaytimeLists / daytimeLists) * 1000) / 10
    : null;
  const supervisedLists = assignments.filter((a) => a.role_on_list === "supervised").length;
  // On-call = any duty type that represents an on-call/resident-on-call
  // commitment. The previous "anything that isn't theatre" rule wrongly
  // counted SPA, admin, teaching and non-clinical sessions as on-call,
  // inflating the on-call share for trainees with a lot of non-clinical time.
  const ONCALL_DUTY_TYPES = new Set([
    "icu_consultant_oncall",
    "general_consultant_oncall",
    "registrar_oncall",
    "sho_oncall",
    "icu_trainee",
    "icu_ct2_plus",
    "obstetrics",
    "obstetrics_2nd",
    "consultant_in_charge",
  ]);
  const onCallLists = assignments.filter(
    (a) => a.duty_type != null && ONCALL_DUTY_TYPES.has(a.duty_type),
  ).length;
  const totalAssignments = assignments.length;
  const onCallPct = totalAssignments > 0
    ? Math.round((onCallLists / totalAssignments) * 1000) / 10
    : null;

  // Only real lists (matched to a theatre_session) count toward the clinical
  // specialty breakdown — otherwise unmatched "solo" default rows pollute it
  // as "Unknown".
  const clinical = assignments.filter(
    (a) =>
      ["solo", "supervised", "supervising"].includes(a.role_on_list) &&
      a.theatre_session_id != null,
  );
  const counts = new Map<string, number>();
  for (const a of clinical) {
    const specId = a.theatre_session_id
      ? specialtyIdBySession.get(a.theatre_session_id) ?? null
      : null;
    const name = specId ? specialtyNameById.get(specId) ?? "Unknown" : "Unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const totalClinical = clinical.length;
  const specialtyBreakdown = Array.from(counts.entries())
    .map(([name, count]) => ({
      name,
      count,
      percent: totalClinical ? Math.round((count / totalClinical) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    weeksAtSalisbury,
    weeksRemaining,
    daytimeLists,
    soloLists,
    soloDaytimeLists,
    soloDaytimePct,
    supervisedLists,
    totalClinical,
    onCallLists,
    onCallPct,
    totalAssignments,
    specialtyBreakdown,
  };
}
