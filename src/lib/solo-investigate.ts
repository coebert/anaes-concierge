/**
 * Pure helpers for the "suspicious trainee solo list" investigation.
 *
 * Three categories of inaccuracy are detected:
 *
 *   1. consultant_or_sas_on_session — a trainee is marked `solo` on a
 *      theatre_session where a consultant OR SAS doctor is also assigned.
 *      The trainee is almost certainly being supervised; we auto-correct
 *      role_on_list to `supervised` (and, if exactly one supervisor-capable
 *      doctor is on the session, set supervisor_id to them).
 *
 *   2. unmatched_theatre_solo — a `solo` theatre row with no
 *      theatre_session_id. CLWRota defaults role_on_list to `solo` on
 *      import when the label can't be parsed, so these are unreliable.
 *      Reported only — not auto-written, because metrics already exclude
 *      rows without a theatre_session_id from solo% calculations.
 *
 *   3. non_training_label — a `solo` theatre row whose theatre_session
 *      label (specialty / surgical_consultant / notes) looks like a
 *      non-working / off-list placeholder (e.g. "Available", "Off Day").
 *      Reported only — these should be cleaned up by the sync's
 *      non-working cleanup, but we surface any survivors here.
 *
 * All inputs are plain rows (string|null), so this module can be called
 * from both the sync handler and the on-demand investigate endpoint
 * without coupling to Supabase.
 */

import { isNonWorkingRotaLabel } from "./clwrota-labels";

export type InvestigateAssignment = {
  id: string;
  staff_id: string;
  role_on_list: string;
  theatre_session_id: string | null;
  session_date: string | null;
  duty_type?: string | null;
  session?: string | null;
  locally_modified?: boolean | null;
};

export type InvestigateProfile = {
  id: string;
  grade: "consultant" | "sas" | "trainee" | string | null;
  full_name?: string | null;
};

export type InvestigateTheatreSession = {
  id: string;
  specialty_name?: string | null;
  surgical_consultant?: string | null;
  notes?: string | null;
};

export type SoloCorrection = {
  assignment_id: string;
  staff_id: string;
  staff_name: string;
  session_date: string | null;
  category:
    | "consultant_or_sas_on_session"
    | "unmatched_theatre_solo"
    | "non_training_label";
  /** Proposed supervisor when category=consultant_or_sas_on_session and one is unambiguous. */
  proposed_supervisor_id?: string | null;
  /** Only true for category 1 — the other two are surfaced as review items. */
  auto_applicable: boolean;
  /** May be used as a reason in rota_reclassification_log. */
  reason: string;
};

export function isSupervisorCapableGrade(g: string | null | undefined): boolean {
  return g === "consultant" || g === "sas";
}

export function computeSoloCorrections(args: {
  assignments: InvestigateAssignment[];
  profilesById: Map<string, InvestigateProfile>;
  theatreSessionsById: Map<string, InvestigateTheatreSession>;
  extraNonWorkingTokens?: string[];
}): SoloCorrection[] {
  const { assignments, profilesById, theatreSessionsById, extraNonWorkingTokens = [] } = args;
  const out: SoloCorrection[] = [];

  // Bucket assignments by theatre_session for category 1.
  const bySession = new Map<string, InvestigateAssignment[]>();
  for (const a of assignments) {
    if (!a.theatre_session_id) continue;
    const list = bySession.get(a.theatre_session_id);
    if (list) list.push(a);
    else bySession.set(a.theatre_session_id, [a]);
  }

  for (const a of assignments) {
    const profile = profilesById.get(a.staff_id);
    if (profile?.grade !== "trainee") continue;
    if (a.role_on_list !== "solo") continue;
    if (a.locally_modified) continue;

    const name = profile.full_name || a.staff_id;

    // Category 2: unmatched theatre solo (no theatre_session_id).
    if (a.duty_type === "theatre" && !a.theatre_session_id) {
      out.push({
        assignment_id: a.id,
        staff_id: a.staff_id,
        staff_name: name,
        session_date: a.session_date,
        category: "unmatched_theatre_solo",
        auto_applicable: false,
        reason: "theatre row has no matched theatre_session_id",
      });
      continue;
    }

    if (!a.theatre_session_id) continue;

    // Category 3: solo on a session whose label looks non-working.
    const ts = theatreSessionsById.get(a.theatre_session_id);
    if (ts) {
      const labels = [ts.specialty_name, ts.surgical_consultant, ts.notes];
      if (isNonWorkingRotaLabel(labels, extraNonWorkingTokens)) {
        out.push({
          assignment_id: a.id,
          staff_id: a.staff_id,
          staff_name: name,
          session_date: a.session_date,
          category: "non_training_label",
          auto_applicable: false,
          reason: "theatre session label matches a non-working placeholder",
        });
        continue;
      }
    }

    // Category 1: consultant/SAS on the same session.
    const peers = bySession.get(a.theatre_session_id) ?? [];
    const supervisors = peers
      .map((p) => profilesById.get(p.staff_id))
      .filter((p): p is InvestigateProfile => !!p && isSupervisorCapableGrade(p.grade));
    if (supervisors.length === 0) continue;

    const proposedSupervisorId = supervisors.length === 1 ? supervisors[0].id : null;
    out.push({
      assignment_id: a.id,
      staff_id: a.staff_id,
      staff_name: name,
      session_date: a.session_date,
      category: "consultant_or_sas_on_session",
      proposed_supervisor_id: proposedSupervisorId,
      auto_applicable: true,
      reason: supervisors.length === 1
        ? `${supervisors[0].grade} on same theatre_session_id`
        : "consultant/SAS on same theatre_session_id",
    });
  }

  return out;
}
