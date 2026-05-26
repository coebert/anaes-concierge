// Pure helpers for solo-trainee detection. Extracted so the dashboard logic
// can be unit-tested independently of React / Supabase.

export type SoloAssignment = {
  staff_id: string;
  session_date: string; // YYYY-MM-DD
  session: "am" | "pm" | string;
  role_on_list: string;
  duty_type?: string;
  supervisor_id: string | null;
  theatre_session_id: string | null;
};

export type SoloProfile = {
  id: string;
  grade: "consultant" | "sas" | "trainee" | string | null;
};

/**
 * Build the set of theatre_session_ids that have at least one consultant
 * assigned. Used to decide whether a trainee on the same session is "solo".
 */
export function buildConsultantSessionSet(
  assignments: SoloAssignment[],
  profilesById: Map<string, SoloProfile>,
): Set<string> {
  const set = new Set<string>();
  for (const a of assignments) {
    if (!a.theatre_session_id) continue;
    if (profilesById.get(a.staff_id)?.grade === "consultant") {
      set.add(a.theatre_session_id);
    }
  }
  return set;
}

/**
 * True iff this assignment counts as a trainee solo list:
 *  - role_on_list === 'solo'
 *  - no supervisor_id, and any supervisor that is set is not a consultant
 *  - theatre_session_id is known and no consultant shares it
 */
export function isSoloTraineeAssignment(
  a: SoloAssignment,
  consultantSessionIds: Set<string>,
  profilesById: Map<string, SoloProfile>,
): boolean {
  if (a.role_on_list !== "solo") return false;
  if (a.supervisor_id) {
    // any supervisor at all disqualifies it; if it's a consultant explicitly,
    // that's the strongest signal it isn't solo
    return false;
  }
  if (!a.theatre_session_id) return false;
  if (consultantSessionIds.has(a.theatre_session_id)) return false;
  const supervisorIsConsultant = a.supervisor_id
    ? profilesById.get(a.supervisor_id)?.grade === "consultant"
    : false;
  if (supervisorIsConsultant) return false;
  return true;
}
