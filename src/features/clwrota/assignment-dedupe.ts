export type SyncAssignmentForDedupe = {
  staff_id: string;
  session_date: string;
  session: string;
  duty_type: string;
  clwrota_external_id: string;
  notes?: string | null;
  theatre_session_key?: string | null;
  extra_type?: string | null;
  is_non_sag?: boolean;
  role_on_list?: string | null;
  /**
   * True when the key is the feed's person|date|session fallback rather
   * than a source row id. Rows sharing a fallback key are different feed
   * rows for the same half (e.g. an on-call plus a theatre list), not
   * re-sends of one row.
   */
  external_id_is_fallback?: boolean;
};

export type DroppedSyncAssignment<T extends SyncAssignmentForDedupe> = {
  dropped: T;
  kept: T;
  reason: "duplicate_external_id" | "duplicate_staff_session";
  /** identical duty repeated, or a different duty in the same half. */
  kind: "identical_duty" | "separate_duty";
};

function dutyKind<T extends SyncAssignmentForDedupe>(a: T, b: T): DroppedSyncAssignment<T>["kind"] {
  return a.duty_type === b.duty_type &&
    (a.theatre_session_key ?? null) === (b.theatre_session_key ?? null) &&
    (a.role_on_list ?? null) === (b.role_on_list ?? null)
    ? "identical_duty"
    : "separate_duty";
}

export function assignmentNaturalKey(
  assignment: Pick<SyncAssignmentForDedupe, "staff_id" | "session_date" | "session">,
): string {
  return `${assignment.staff_id}|${assignment.session_date}|${assignment.session}`;
}

function assignmentPriority(assignment: SyncAssignmentForDedupe): number {
  const dutyPriority: Record<string, number> = {
    teaching: 100,
    medical_examiner: 95,
    theatre: 80,
    obstetrics: 75,
    obstetrics_2nd: 75,
    icu_trainee: 75,
    icu_ct2_plus: 75,
    icu_consultant_oncall: 75,
    general_consultant_oncall: 75,
    registrar_oncall: 75,
    sho_oncall: 75,
    nhh_oncall: 75,
    spa: 65,
    admin: 65,
    teaching_session: 65,
    non_clinical: 60,
    admin_session: 60,
  };
  let score = dutyPriority[assignment.duty_type] ?? 50;
  if (assignment.notes?.trim()) score += 2;
  if (assignment.theatre_session_key) score += 1;
  if (assignment.extra_type?.trim()) score += 1;
  if (assignment.is_non_sag) score += 1;
  return score;
}

function shouldReplaceAssignment<T extends SyncAssignmentForDedupe>(
  current: T,
  candidate: T,
): boolean {
  const currentPriority = assignmentPriority(current);
  const candidatePriority = assignmentPriority(candidate);
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;
  return true;
}

export function dedupeAssignmentsBySyncKeys<T extends SyncAssignmentForDedupe>(
  assignments: readonly T[],
): { assignments: T[]; dropped: Array<DroppedSyncAssignment<T>> } {
  const dropped: Array<DroppedSyncAssignment<T>> = [];
  const byExternalId = new Map<string, T>();
  for (const assignment of assignments) {
    const prior = byExternalId.get(assignment.clwrota_external_id);
    if (!prior) {
      byExternalId.set(assignment.clwrota_external_id, assignment);
      continue;
    }
    // A repeated source row id is a re-send: the latest copy wins. A shared
    // fallback key is two different rows for one half: resolve by the same
    // duty priority as the staff/session collapse below, so the stored duty
    // does not depend on feed order (ties keep the later row, as before).
    const bothFallback = prior.external_id_is_fallback && assignment.external_id_is_fallback;
    const replace = bothFallback ? shouldReplaceAssignment(prior, assignment) : true;
    const kept = replace ? assignment : prior;
    const lost = replace ? prior : assignment;
    dropped.push({
      dropped: lost,
      kept,
      reason: "duplicate_external_id",
      kind: dutyKind(lost, kept),
    });
    byExternalId.set(assignment.clwrota_external_id, kept);
  }

  const byNaturalKey = new Map<string, T>();
  for (const assignment of byExternalId.values()) {
    const key = assignmentNaturalKey(assignment);
    const prior = byNaturalKey.get(key);
    if (!prior) {
      byNaturalKey.set(key, assignment);
      continue;
    }
    if (shouldReplaceAssignment(prior, assignment)) {
      byNaturalKey.set(key, assignment);
      dropped.push({
        dropped: prior,
        kept: assignment,
        reason: "duplicate_staff_session",
        kind: dutyKind(prior, assignment),
      });
    } else {
      dropped.push({
        dropped: assignment,
        kept: prior,
        reason: "duplicate_staff_session",
        kind: dutyKind(assignment, prior),
      });
    }
  }

  return { assignments: Array.from(byNaturalKey.values()), dropped };
}
