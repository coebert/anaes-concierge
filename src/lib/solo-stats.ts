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
  training_level?: string | null;
};

/** A grade is "supervisor-capable" if its presence on a theatre list means a
 * trainee on that same list is not truly solo. Consultants and SAS doctors
 * both count: SAS are senior career-grade doctors expected to lead a list and
 * supervise a trainee working on it. */
function isSupervisorCapableGrade(grade: SoloProfile["grade"] | undefined): boolean {
  return grade === "consultant" || grade === "sas";
}

/**
 * Build the set of theatre_session_ids that have at least one supervisor-capable
 * doctor (consultant or SAS) assigned. Used to decide whether a trainee on the
 * same session is "solo".
 *
 * The name is kept for backwards compatibility but the set now includes SAS-led
 * lists too.
 */
export function buildConsultantSessionSet(
  assignments: SoloAssignment[],
  profilesById: Map<string, SoloProfile>,
): Set<string> {
  const set = new Set<string>();
  for (const a of assignments) {
    if (!a.theatre_session_id) continue;
    if (isSupervisorCapableGrade(profilesById.get(a.staff_id)?.grade)) {
      set.add(a.theatre_session_id);
    }
  }
  return set;
}

/**
 * True iff this assignment counts as a trainee solo list:
 *  - role_on_list === 'solo'
 *  - no supervisor_id, and any supervisor that is set is not supervisor-capable
 *  - theatre_session_id is known and no consultant or SAS shares it
 *  - the trainee is NOT a junior (FY2/ACCS/CT1/CT2/ST1/ST2) — those grades
 *    are too junior to ever genuinely run a list solo, so we treat any
 *    "solo" import as a data-quality artefact rather than a real solo list.
 */
const JUNIOR_LEVELS = new Set(["FY2", "ACCS", "CT1", "CT2", "ST1", "ST2"]);

export function isSoloTraineeAssignment(
  a: SoloAssignment,
  supervisorCapableSessionIds: Set<string>,
  profilesById: Map<string, SoloProfile>,
): boolean {
  if (a.role_on_list !== "solo") return false;
  if (a.supervisor_id) {
    // any supervisor at all disqualifies it
    return false;
  }
  if (!a.theatre_session_id) return false;
  if (supervisorCapableSessionIds.has(a.theatre_session_id)) return false;
  const level = profilesById.get(a.staff_id)?.training_level;
  if (level) {
    const norm = level.trim().toUpperCase().replace(/\s+/g, "");
    if (JUNIOR_LEVELS.has(norm)) return false;
  }
  return true;
}
