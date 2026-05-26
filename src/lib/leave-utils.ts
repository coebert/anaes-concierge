import { supabase } from "@/integrations/supabase/client";

export type SessionPart = "am" | "pm";

export interface LeaveConflict {
  date: string;
  session: SessionPart | "all_day";
  theatre?: string;
  role?: string;
  type: "rota_assignment" | "fixed_session" | "other_leave";
  staffName?: string;
}

function* eachDate(start: string, end: string): Generator<string> {
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

/**
 * Compute conflicts for a leave request: own rota assignments in range and
 * other people on approved leave overlapping the same days.
 */
export async function computeLeaveConflicts(
  staffId: string,
  startDate: string,
  endDate: string,
  halfDayStart?: SessionPart | null,
  halfDayEnd?: SessionPart | null,
  excludeLeaveId?: string,
): Promise<LeaveConflict[]> {
  const conflicts: LeaveConflict[] = [];

  // 1. Own rota assignments in range
  const { data: assignments } = await supabase
    .from("rota_assignments")
    .select("session_date, session, role_on_list, theatre_session_id")
    .eq("staff_id", staffId)
    .gte("session_date", startDate)
    .lte("session_date", endDate);

  // pull theatre names
  const theatreSessionIds = (assignments ?? [])
    .map((a) => a.theatre_session_id)
    .filter((x): x is string => !!x);
  const theatreMap = new Map<string, string>();
  if (theatreSessionIds.length) {
    const { data: ts } = await supabase
      .from("theatre_sessions")
      .select("id, theatre_id")
      .in("id", theatreSessionIds);
    const theatreIds = (ts ?? []).map((t) => t.theatre_id);
    const { data: theatres } = await supabase
      .from("theatres")
      .select("id, name")
      .in("id", theatreIds);
    const nameById = new Map((theatres ?? []).map((t) => [t.id, t.name]));
    (ts ?? []).forEach((t) => {
      theatreMap.set(t.id, nameById.get(t.theatre_id) ?? "");
    });
  }

  for (const a of assignments ?? []) {
    // apply half-day filter
    if (a.session_date === startDate && halfDayStart && a.session !== halfDayStart) continue;
    if (a.session_date === endDate && halfDayEnd && a.session !== halfDayEnd) continue;
    conflicts.push({
      date: a.session_date,
      session: a.session as SessionPart,
      theatre: a.theatre_session_id ? theatreMap.get(a.theatre_session_id) : undefined,
      role: a.role_on_list,
      type: "rota_assignment",
    });
  }

  // 2. Other people already on approved leave overlapping these dates
  const { data: otherLeave } = await supabase
    .from("leave_requests")
    .select("id, staff_id, start_date, end_date, type")
    .eq("status", "approved")
    .neq("staff_id", staffId)
    .lte("start_date", endDate)
    .gte("end_date", startDate);

  const filteredOther = (otherLeave ?? []).filter((l) => l.id !== excludeLeaveId);
  if (filteredOther.length) {
    const staffIds = [...new Set(filteredOther.map((l) => l.staff_id))];
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", staffIds);
    const nameById = new Map((profs ?? []).map((p) => [p.id, p.full_name]));
    for (const l of filteredOther) {
      // overlap on each day in our range
      for (const d of eachDate(
        l.start_date > startDate ? l.start_date : startDate,
        l.end_date < endDate ? l.end_date : endDate,
      )) {
        conflicts.push({
          date: d,
          session: "all_day",
          type: "other_leave",
          staffName: nameById.get(l.staff_id) ?? "Unknown",
        });
      }
    }
  }

  conflicts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return conflicts;
}

export function countWorkingDays(
  startDate: string,
  endDate: string,
  halfDayStart?: SessionPart | null,
  halfDayEnd?: SessionPart | null,
): number {
  let days = 0;
  for (const d of eachDate(startDate, endDate)) {
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    if (dow === 0 || dow === 6) continue;
    let inc = 1;
    if (d === startDate && halfDayStart) inc -= 0.5;
    if (d === endDate && halfDayEnd) inc -= 0.5;
    days += inc;
  }
  return Math.max(0, days);
}
