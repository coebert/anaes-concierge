import { supabase } from "@/integrations/supabase/client";
import { countLeaveWorkingDays, isValidIsoDate } from "./leave-count";

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
/**
 * Which halves of `date` a leave row covers. `half_day_start="pm"` means
 * the leave begins in the afternoon of its start date; `half_day_end="am"`
 * means it ends after the morning of its end date (UI convention).
 */
export function leaveHalvesOn(
  l: {
    start_date: string;
    end_date: string;
    half_day_start?: string | null;
    half_day_end?: string | null;
  },
  date: string,
): Set<"am" | "pm"> {
  if (date < l.start_date || date > l.end_date) return new Set();
  const h = new Set<"am" | "pm">(["am", "pm"]);
  if (date === l.start_date && l.half_day_start === "pm") h.delete("am");
  if (date === l.start_date && l.half_day_start === "am") h.delete("pm");
  if (date === l.end_date && l.half_day_end === "am") h.delete("pm");
  if (date === l.end_date && l.half_day_end === "pm") h.delete("am");
  return h;
}

export async function computeLeaveConflicts(
  staffId: string,
  startDate: string,
  endDate: string,
  halfDayStart?: SessionPart | null,
  halfDayEnd?: SessionPart | null,
  excludeLeaveId?: string,
): Promise<LeaveConflict[]> {
  const conflicts: LeaveConflict[] = [];
  // Every query is checked: a failed lookup must never read as "no conflicts".
  const must = <T>(
    label: string,
    res: { data: T | null; error: { message: string } | null },
  ): T => {
    if (res.error) throw new Error(`Could not check ${label}: ${res.error.message}`);
    return (res.data ?? []) as T;
  };

  // 1. Own rota assignments in range
  const assignments = must(
    "rota assignments",
    await supabase
      .from("rota_assignments")
      .select("session_date, session, role_on_list, theatre_session_id")
      .eq("staff_id", staffId)
      .gte("session_date", startDate)
      .lte("session_date", endDate)
      .order("session_date")
      .range(0, 999),
  ) as Array<{
    session_date: string;
    session: string;
    role_on_list: string;
    theatre_session_id: string | null;
  }>;
  if (assignments.length >= 1000)
    throw new Error("Could not check rota assignments: too many rows for this range.");

  const theatreSessionIds = [
    ...new Set(assignments.map((a) => a.theatre_session_id).filter((x): x is string => !!x)),
  ];
  const theatreMap = new Map<string, string>();
  if (theatreSessionIds.length) {
    const ts = must(
      "theatre sessions",
      await supabase.from("theatre_sessions").select("id, theatre_id").in("id", theatreSessionIds),
    ) as Array<{ id: string; theatre_id: string }>;
    const theatreIds = [...new Set(ts.map((t) => t.theatre_id))];
    const theatres = theatreIds.length
      ? (must(
          "theatres",
          await supabase.from("theatres").select("id, name").in("id", theatreIds),
        ) as Array<{ id: string; name: string }>)
      : [];
    const nameById = new Map(theatres.map((t) => [t.id, t.name]));
    ts.forEach((t) => theatreMap.set(t.id, nameById.get(t.theatre_id) ?? ""));
  }

  const ours = {
    start_date: startDate,
    end_date: endDate,
    half_day_start: halfDayStart ?? null,
    half_day_end: halfDayEnd ?? null,
  };
  for (const a of assignments) {
    if (a.session === "am" || a.session === "pm") {
      if (!leaveHalvesOn(ours, a.session_date).has(a.session)) continue;
    } else {
      // Evening/night sessions: on a PM-start day the doctor is still off
      // that evening; on an AM-end day they are back by the evening.
      if (a.session_date === endDate && halfDayEnd === "am") continue;
    }
    conflicts.push({
      date: a.session_date,
      session: a.session as SessionPart,
      theatre: a.theatre_session_id ? theatreMap.get(a.theatre_session_id) : undefined,
      role: a.role_on_list,
      type: "rota_assignment",
    });
  }

  // 2. Other people already on approved leave — compared half-by-half.
  const otherLeave = must(
    "colleagues' leave",
    await supabase
      .from("leave_requests")
      .select("id, staff_id, start_date, end_date, type, half_day_start, half_day_end")
      .eq("status", "approved")
      .neq("staff_id", staffId)
      .lte("start_date", endDate)
      .gte("end_date", startDate)
      .range(0, 999),
  ) as Array<{
    id: string;
    staff_id: string;
    start_date: string;
    end_date: string;
    half_day_start: string | null;
    half_day_end: string | null;
  }>;
  if (otherLeave.length >= 1000)
    throw new Error("Could not check colleagues' leave: too many rows for this range.");

  const filteredOther = otherLeave.filter((l) => l.id !== excludeLeaveId);
  if (filteredOther.length) {
    const staffIds = [...new Set(filteredOther.map((l) => l.staff_id))];
    const profs = must(
      "staff names",
      await supabase.from("profiles").select("id, full_name").in("id", staffIds),
    ) as Array<{ id: string; full_name: string }>;
    const nameById = new Map(profs.map((p) => [p.id, p.full_name]));
    for (const l of filteredOther) {
      for (const d of eachDate(
        l.start_date > startDate ? l.start_date : startDate,
        l.end_date < endDate ? l.end_date : endDate,
      )) {
        const mine = leaveHalvesOn(ours, d);
        const theirs = leaveHalvesOn(l, d);
        const both = (["am", "pm"] as const).filter((h) => mine.has(h) && theirs.has(h));
        if (both.length === 0) continue; // e.g. my PM-only start vs their AM-only end
        conflicts.push({
          date: d,
          session: both.length === 2 ? "all_day" : both[0],
          type: "other_leave",
          staffName: nameById.get(l.staff_id) ?? "Unknown",
        });
      }
    }
  }

  conflicts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return conflicts;
}

/** Working days for the request dialog — same convention as allowances. */
export function countWorkingDays(
  startDate: string,
  endDate: string,
  halfDayStart?: SessionPart | null,
  halfDayEnd?: SessionPart | null,
): number {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) return 0;
  return countLeaveWorkingDays({
    start_date: startDate,
    end_date: endDate,
    half_day_start: halfDayStart ?? null,
    half_day_end: halfDayEnd ?? null,
  });
}
