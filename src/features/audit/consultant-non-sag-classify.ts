/**
 * Pure classifier for the consultant-audits SAG / non-SAG counters.
 *
 * Extracted from src/routes/_authenticated/robustness.consultant-audits.tsx
 * so the behaviour can be locked in with unit tests independently of the
 * Supabase query plumbing. The route file imports this helper — any change
 * to the rules must update both this function and its tests together.
 *
 * Inputs mirror the shape of a single row returned by
 *   .from("rota_assignments")
 *     .select("staff_id,duty_type,theatre_session_id,session_date,session,is_non_sag")
 * combined with the pre-built `sagBySession` map keyed by theatre_session_id.
 *
 * The function returns which counter (if any) should be incremented for
 * this assignment, plus whether the session was flagged as admin-reviewed.
 *
 * The three sources of "non-SAG" status are, in order:
 *   1) the assignment row itself is flagged is_non_sag = true by the
 *      CLWRota sync — this is the ONLY way theatre-less NHH lists and
 *      non-SAG on-call rows are surfaced, because they have no linked
 *      theatre_session_id to inspect;
 *   2) the linked theatre_session at an NHH (private) theatre is marked
 *      non-SAG via the admin theatre-grid checkbox or CLWRota propagation;
 *   3) otherwise, a theatre row at an NHH theatre counts as a SAG list.
 *
 * Non-theatre rows with no assignment-level flag are ignored.
 */
export type SagClass = "sag" | "non_sag";
export type SagMark = { kind: SagClass; reviewed: boolean };

export type AssignmentForClassify = {
  duty_type: string | null;
  theatre_session_id: string | null;
  is_non_sag: boolean | null;
};

export type ClassifyResult =
  | { bucket: "sag"; reviewed: false }
  | { bucket: "non_sag"; reviewed: boolean }
  | { bucket: "spa"; reviewed: false }
  | { bucket: "none"; reviewed: false };

export function classifyConsultantAssignment(
  a: AssignmentForClassify,
  sagBySession: Map<string, SagMark>,
): ClassifyResult {
  if (a.duty_type === "spa") return { bucket: "spa", reviewed: false };

  const assignmentNonSag = a.is_non_sag === true;
  const sessionMark = a.theatre_session_id
    ? sagBySession.get(a.theatre_session_id)
    : undefined;

  if (assignmentNonSag) {
    return { bucket: "non_sag", reviewed: sessionMark?.reviewed === true };
  }
  if (a.duty_type !== "theatre") return { bucket: "none", reviewed: false };
  if (!a.theatre_session_id) return { bucket: "none", reviewed: false };
  if (!sessionMark) return { bucket: "none", reviewed: false };
  if (sessionMark.kind === "non_sag") {
    return { bucket: "non_sag", reviewed: sessionMark.reviewed };
  }
  return { bucket: "sag", reviewed: false };
}
