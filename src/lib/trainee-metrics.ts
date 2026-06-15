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
    | "no_theatre_session_rows"
    | "no_theatre_rows_non_theatre_block";
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
  icuLists: number;
  obstetricsLists: number;
  totalAssignments: number;
  /** Theatre-duty rows with no matched theatre_session_id (unmatched CLWRota labels). */
  unmatchedTheatreRows: number;
  /** Sanity-check warnings to surface alongside the card. */
  warnings: TraineeMetricsWarning[];
  specialtyBreakdown: Array<{ name: string; count: number; percent: number }>;
};

/**
 * Training levels at which a trainee is too junior to ever run a theatre list
 * solo. Any imported `role_on_list='solo'` row for a doctor at one of these
 * levels is treated as `supervised` for metric purposes — the clwrota import
 * defaults to "solo" when it can't determine a supervisor, and a missing
 * consultant row on a junior trainee's list is a data-quality artefact, not
 * a clinical reality.
 */
export const JUNIOR_TRAINEE_LEVELS: ReadonlySet<string> = new Set([
  "FY2",
  "ACCS",
  "CT1",
  "CT2",
  "ST1",
  "ST2",
]);

export function isJuniorTraineeLevel(level: string | null | undefined): boolean {
  if (!level) return false;
  const norm = level.trim().toUpperCase().replace(/\s+/g, "");
  return JUNIOR_TRAINEE_LEVELS.has(norm);
}

export function computeTraineeMetrics(
  assignments: MetricAssignment[],
  startDate: string | null | undefined,
  specialtyIdBySession: Map<string, string | null | undefined>,
  specialtyNameById: Map<string, string>,
  now: number = Date.now(),
  rotationEndDate: string | null | undefined = null,
  suppressTheatreWarnings: boolean = false,
  juniorTrainee: boolean = false,
  supervisorSessionIds: ReadonlySet<string> | null = null,
): TraineeMetrics {
  const start = startDate ? new Date(startDate) : null;
  const weeksAtSalisbury = start
    ? Math.max(0, Math.floor((now - start.getTime()) / (1000 * 60 * 60 * 24 * 7)))
    : null;
  const end = rotationEndDate ? new Date(rotationEndDate) : null;
  const weeksRemaining = end
    ? Math.max(0, Math.ceil((end.getTime() - now) / (1000 * 60 * 60 * 24 * 7)))
    : null;

  // Treat a row's effective role as 'supervised' when:
  //   - the trainee is too junior to ever run a list solo, OR
  //   - the same theatre session has a consultant/SAS doctor rostered
  //     (the trainee is marked "solo" only because the clwrota import
  //     defaults role_on_list to "solo" when it can't pin a supervisor on
  //     the row). Without this, the overview's solo counts disagree with
  //     the per-trainee detail page, which already applies the same rule.
  const effectiveRole = (a: MetricAssignment): string => {
    if (
      a.role_on_list !== "solo" ||
      a.duty_type !== "theatre" ||
      a.theatre_session_id == null
    ) {
      return a.role_on_list;
    }
    if (juniorTrainee) return "supervised";
    if (supervisorSessionIds && supervisorSessionIds.has(a.theatre_session_id)) {
      return "supervised";
    }
    return a.role_on_list;
  };

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
      effectiveRole(a) === "solo" &&
      a.duty_type === "theatre" &&
      a.theatre_session_id != null,
  ).length;
  const soloDaytimeLists = daytimeAssignments.filter((a) => effectiveRole(a) === "solo").length;
  const soloDaytimePct = daytimeLists > 0
    ? Math.round((soloDaytimeLists / daytimeLists) * 1000) / 10
    : null;
  const supervisedLists = assignments.filter((a) => effectiveRole(a) === "supervised").length;
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
  const ICU_DUTY_TYPES = new Set(["icu_trainee", "icu_ct2_plus"]);
  const OBSTETRICS_DUTY_TYPES = new Set(["obstetrics", "obstetrics_2nd"]);
  const icuLists = assignments.filter(
    (a) => a.duty_type != null && ICU_DUTY_TYPES.has(a.duty_type),
  ).length;
  const obstetricsLists = assignments.filter(
    (a) => a.duty_type != null && OBSTETRICS_DUTY_TYPES.has(a.duty_type),
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

  // Sanity-check validation: a solo% built on only a handful of real lists is
  // statistically unreliable, and a trainee with no matched theatre_session_id
  // rows usually points to a CLWRota import-quality problem rather than a true
  // 0% / 100%. Surface these so reviewers don't read noise as a signal.
  const unmatchedTheatreRows = assignments.filter(
    (a) =>
      a.duty_type === "theatre" &&
      (a.session === "am" || a.session === "pm") &&
      a.theatre_session_id == null,
  ).length;
  const totalTheatreRows = daytimeLists + unmatchedTheatreRows;
  const warnings: TraineeMetricsWarning[] = [];
  if (suppressTheatreWarnings) {
    // ICU-block trainees can legitimately have no matched theatre lists, so
    // keep the metrics visible but suppress theatre-list data-quality warnings.
  } else if (daytimeLists === 0 && totalTheatreRows > 0) {
    warnings.push({
      level: "warn",
      code: "no_real_lists",
      message:
        "No matched theatre lists — solo / supervised percentages cannot be calculated reliably.",
    });
  } else if (daytimeLists < LOW_REAL_LIST_THRESHOLD) {
    warnings.push({
      level: "warn",
      code: "low_real_list_count",
      message: `Only ${daytimeLists} matched daytime list${daytimeLists === 1 ? "" : "s"} — solo% is based on a very small sample.`,
    });
  }
  if (suppressTheatreWarnings) {
    // See above — no theatre-list warning expected for ICU blocks.
  } else if (totalTheatreRows === 0) {
    // Distinguish two very different situations that both end up with zero
    // imported theatre rows:
    //   1. A genuine data-quality problem (no clinical activity recorded at
    //      all, or the CLWRota feed isn't producing usable rows for this
    //      trainee). This is the original "no theatre rows imported" case.
    //   2. The trainee has been clinically active in the window but doing
    //      ICU, on-calls, or obstetrics — so they correctly have no theatre
    //      rows. `isIcuBlockOnly` (which gates `suppressTheatreWarnings`)
    //      only checks the *future* window, so a trainee whose remaining
    //      rotation includes theatre work but whose recent past is all
    //      ICU/on-call would otherwise still trip the import-quality alarm.
    const NON_THEATRE_CLINICAL = new Set([
      "icu_trainee",
      "icu_ct2_plus",
      "icu_consultant_oncall",
      "general_consultant_oncall",
      "registrar_oncall",
      "sho_oncall",
      "consultant_in_charge",
      "obstetrics",
      "obstetrics_2nd",
    ]);
    const hasNonTheatreClinical = assignments.some(
      (a) => a.duty_type != null && NON_THEATRE_CLINICAL.has(a.duty_type),
    );
    if (hasNonTheatreClinical) {
      warnings.push({
        level: "info",
        code: "no_theatre_rows_non_theatre_block",
        message:
          "No daytime theatre lists in this window — trainee has been on ICU / on-call / obstetrics duties.",
      });
    } else {
      warnings.push({
        level: "info",
        code: "no_theatre_session_rows",
        message: "No theatre rows imported for this trainee.",
      });
    }
  } else if (unmatchedTheatreRows / totalTheatreRows >= HIGH_UNMATCHED_RATIO) {
    const pct = Math.round((unmatchedTheatreRows / totalTheatreRows) * 100);
    warnings.push({
      level: "warn",
      code: "high_unmatched_ratio",
      message: `${pct}% of theatre rows (${unmatchedTheatreRows}/${totalTheatreRows}) could not be matched to a theatre booking — CLWRota labels may need review.`,
    });
  }

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
    icuLists,
    obstetricsLists,
    totalAssignments,
    unmatchedTheatreRows,
    warnings,
    specialtyBreakdown,
  };
}

