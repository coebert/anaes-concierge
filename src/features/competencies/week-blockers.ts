// Week-level scan of blocking competency issues across all assignments in
// the rota editor. Reuses evaluateCompetency (blockMissingRequired=true) so
// the summary matches exactly what the CellDialog blocks.

import {
  evaluateCompetency,
  type Competency,
  type CompetencyRequirement,
  type StaffCompetency,
} from "./competencies";

export type SessionHalf = "am" | "pm" | "eve" | "night";

export interface WeekAssignmentLike {
  id: string;
  staff_id: string;
  session_date: string;
  session: SessionHalf;
  role_on_list: string;
  theatre_session_id: string | null;
}

export interface TheatreSessionLike {
  id: string;
  theatre_id: string;
  session: SessionHalf;
  session_date: string;
  specialty_id: string | null;
}

export interface StaffLike {
  id: string;
  full_name: string;
}

export interface TheatreLike {
  id: string;
  name: string;
}

export interface BlockingIssue {
  assignmentId: string;
  date: string;
  session: SessionHalf;
  theatreId: string | null;
  theatreName: string;
  role: string;
  messages: string[];
}

export interface StaffBlockerGroup {
  staffId: string;
  staffName: string;
  issues: BlockingIssue[];
}

export interface ComputeBlockingIssuesArgs {
  assignments: WeekAssignmentLike[];
  theatreSessions: TheatreSessionLike[];
  theatres: TheatreLike[];
  staff: StaffLike[];
  competencies: Competency[];
  requirements: CompetencyRequirement[];
  staffCompetencies: StaffCompetency[];
}

/**
 * Return per-staff groups of blocking competency issues for the week.
 * Only errors (would-be-blocked by the rota editor) are included.
 * Groups are sorted alphabetically, issues within a group by date+session.
 */
export function computeWeekBlockingCompetencyIssues(
  args: ComputeBlockingIssuesArgs,
): StaffBlockerGroup[] {
  const sessionById = new Map(args.theatreSessions.map((s) => [s.id, s]));
  const theatreById = new Map(args.theatres.map((t) => [t.id, t]));
  const staffById = new Map(args.staff.map((s) => [s.id, s]));

  const byStaff = new Map<string, BlockingIssue[]>();

  for (const a of args.assignments) {
    if (a.session !== "am" && a.session !== "pm") continue;
    if (!a.theatre_session_id) continue;
    const ts = sessionById.get(a.theatre_session_id);
    if (!ts || !ts.specialty_id) continue;

    const issues = evaluateCompetency({
      staffId: a.staff_id,
      specialtyId: ts.specialty_id,
      role: a.role_on_list,
      onDate: a.session_date,
      requirements: args.requirements,
      staffCompetencies: args.staffCompetencies,
      competencies: args.competencies,
      blockMissingRequired: true,
    });
    const errorMsgs = issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message);
    if (errorMsgs.length === 0) continue;

    const theatre = theatreById.get(ts.theatre_id);
    const entry: BlockingIssue = {
      assignmentId: a.id,
      date: a.session_date,
      session: a.session,
      theatreId: ts.theatre_id,
      theatreName: theatre?.name ?? "Theatre",
      role: a.role_on_list,
      messages: errorMsgs,
    };
    const arr = byStaff.get(a.staff_id) ?? [];
    arr.push(entry);
    byStaff.set(a.staff_id, arr);
  }

  const out: StaffBlockerGroup[] = [];
  for (const [staffId, issues] of byStaff.entries()) {
    issues.sort((a, b) =>
      a.date === b.date
        ? a.session.localeCompare(b.session)
        : a.date.localeCompare(b.date),
    );
    out.push({
      staffId,
      staffName: staffById.get(staffId)?.full_name ?? "Unknown",
      issues,
    });
  }
  out.sort((a, b) => a.staffName.localeCompare(b.staffName));
  return out;
}
