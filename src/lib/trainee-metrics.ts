// Pure helpers for per-trainee individual metrics (extracted so dashboard
// and trainee detail page share the same logic).

export type MetricAssignment = {
  role_on_list: string;
  session: string;
  duty_type?: string | null;
  theatre_session_id: string | null;
};

export type TraineeMetrics = {
  weeksAtSalisbury: number | null;
  daytimeLists: number;
  soloLists: number;
  supervisedLists: number;
  totalClinical: number;
  onCallLists: number;
  totalAssignments: number;
  specialtyBreakdown: Array<{ name: string; count: number; percent: number }>;
};

export function computeTraineeMetrics(
  assignments: MetricAssignment[],
  startDate: string | null | undefined,
  specialtyIdBySession: Map<string, string | null | undefined>,
  specialtyNameById: Map<string, string>,
  now: number = Date.now(),
): TraineeMetrics {
  const start = startDate ? new Date(startDate) : null;
  const weeksAtSalisbury = start
    ? Math.max(0, Math.floor((now - start.getTime()) / (1000 * 60 * 60 * 24 * 7)))
    : null;

  const daytimeLists = assignments.filter(
    (a) => a.duty_type === "theatre" && (a.session === "am" || a.session === "pm"),
  ).length;
  const soloLists = assignments.filter((a) => a.role_on_list === "solo").length;
  const supervisedLists = assignments.filter((a) => a.role_on_list === "supervised").length;
  const onCallLists = assignments.filter((a) => a.duty_type === "on-call").length;
  const totalAssignments = assignments.length;

  const clinical = assignments.filter((a) =>
    ["solo", "supervised", "supervising"].includes(a.role_on_list),
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
    daytimeLists,
    soloLists,
    supervisedLists,
    totalClinical,
    onCallLists,
    totalAssignments,
    specialtyBreakdown,
  };
}
