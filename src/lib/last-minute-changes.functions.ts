import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Last minute changes audit.
 *
 * A "last minute change" is any insert, update or delete to a rota
 * assignment that lands within 48 hours of the scheduled start of the
 * clinical activity it relates to. The DB trigger `log_late_rota_change`
 * writes one row to `rota_change_log` per such change (across all duty
 * types — theatre, on-call, ICU, obstetrics, etc.).
 */

export type StaffingGroup =
  | "consultant"
  | "trainee"
  | "sas"
  | "anp"
  | "other"
  | "unknown";

export type ListRef = {
  id: string;
  theatre: string;
  specialty: string | null;
  label: string;
};

export type LastMinuteChangeRow = {
  id: string;
  changedAt: string;
  sessionDate: string;
  sessionStartTs: string;
  session: string;
  action: "insert" | "update" | "delete" | string;
  hoursBeforeSession: number;
  staffId: string | null;
  staffName: string;
  prevStaffName: string | null;
  group: StaffingGroup;
  changedByName: string | null;
  fromList: ListRef | null;
  toList: ListRef | null;
};

export type WindowTotals = {
  all: number;
  inserts: number;
  updates: number;
  deletes: number;
  traineeListMoves: number;
};

export type WindowByGroup = Record<StaffingGroup, {
  total: number;
  inserts: number;
  updates: number;
  deletes: number;
}>;

export type LastMinuteChangesAudit = {
  rangeStart: string;
  rangeEnd: string;
  /** Windows captured by the audit, in hours (e.g. [24, 48]). */
  windowsHours: number[];
  /** 48h-window totals (kept for back-compat — same as totalsByWindow["48"]). */
  totals: WindowTotals;
  byGroup: WindowByGroup;
  totalsByWindow: Record<string, WindowTotals>;
  byGroupByWindow: Record<string, WindowByGroup>;
  /** All rows within the widest window (48h). Each row carries its hoursBeforeSession. */
  rows: LastMinuteChangeRow[];
};

function gradeToGroup(grade: string | null | undefined): StaffingGroup {
  switch ((grade ?? "").toLowerCase()) {
    case "consultant": return "consultant";
    case "trainee":    return "trainee";
    case "sas":        return "sas";
    case "anp":        return "anp";
    case "":           return "unknown";
    default:           return "other";
  }
}

function emptyByGroup(): LastMinuteChangesAudit["byGroup"] {
  const groups: StaffingGroup[] = ["consultant", "trainee", "sas", "anp", "other", "unknown"];
  const out = {} as LastMinuteChangesAudit["byGroup"];
  for (const g of groups) out[g] = { total: 0, inserts: 0, updates: 0, deletes: 0 };
  return out;
}

export const getLastMinuteChangesAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { rangeStart: string; rangeEnd: string }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.rangeStart)) throw new Error("rangeStart must be YYYY-MM-DD");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.rangeEnd))   throw new Error("rangeEnd must be YYYY-MM-DD");
    return input;
  })
  .handler(async ({ data, context }): Promise<LastMinuteChangesAudit> => {
    const { supabase } = context;

    const { data: logs, error } = await supabase
      .from("rota_change_log")
      .select("id, action, session_date, session, staff_id, session_start_ts, changed_at, hours_before_session, changed_by, prev_theatre_session_id, new_theatre_session_id, prev_staff_id")
      .gte("session_date", data.rangeStart)
      .lte("session_date", data.rangeEnd)
      .lte("hours_before_session", 48)
      .gte("hours_before_session", -48)
      .order("changed_at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);

    const staffIds = Array.from(new Set(
      (logs ?? []).flatMap((r) => [r.staff_id, r.changed_by, r.prev_staff_id]).filter((x): x is string => !!x),
    ));
    const sessionIds = Array.from(new Set(
      (logs ?? []).flatMap((r) => [r.prev_theatre_session_id, r.new_theatre_session_id]).filter((x): x is string => !!x),
    ));

    const profileMap = new Map<string, { full_name: string | null; grade: string | null }>();
    if (staffIds.length > 0) {
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name, grade")
        .in("id", staffIds);
      if (pErr) throw new Error(pErr.message);
      for (const p of profs ?? []) profileMap.set(p.id, { full_name: p.full_name, grade: p.grade });
    }

    const listMap = new Map<string, ListRef>();
    if (sessionIds.length > 0) {
      const { data: sess, error: sErr } = await supabase
        .from("theatre_sessions")
        .select("id, theatre_id, specialty_id, theatres(name), specialties(name)")
        .in("id", sessionIds);
      if (sErr) throw new Error(sErr.message);
      for (const s of sess ?? []) {
        const theatre = (s.theatres as { name: string } | null)?.name ?? "Unknown theatre";
        const specialty = (s.specialties as { name: string } | null)?.name ?? null;
        listMap.set(s.id, {
          id: s.id,
          theatre,
          specialty,
          label: specialty ? `${theatre} · ${specialty}` : theatre,
        });
      }
    }

    const rows: LastMinuteChangeRow[] = (logs ?? []).map((r) => {
      const prof = r.staff_id ? profileMap.get(r.staff_id) : null;
      const prevProf = r.prev_staff_id ? profileMap.get(r.prev_staff_id) : null;
      const changer = r.changed_by ? profileMap.get(r.changed_by) : null;
      return {
        id: r.id,
        changedAt: r.changed_at,
        sessionDate: r.session_date,
        sessionStartTs: r.session_start_ts,
        session: r.session ?? "",
        action: (r.action ?? "update") as LastMinuteChangeRow["action"],
        hoursBeforeSession: Number(r.hours_before_session ?? 0),
        staffId: r.staff_id,
        staffName: prof?.full_name ?? (r.staff_id ? "Unknown staff" : "—"),
        prevStaffName: prevProf?.full_name ?? (r.prev_staff_id ? "Unknown staff" : null),
        group: gradeToGroup(prof?.grade),
        changedByName: changer?.full_name ?? null,
        fromList: r.prev_theatre_session_id ? listMap.get(r.prev_theatre_session_id) ?? null : null,
        toList: r.new_theatre_session_id ? listMap.get(r.new_theatre_session_id) ?? null : null,
      };
    });

    const WINDOWS = [24, 48] as const;
    const totalsByWindow: Record<string, WindowTotals> = {};
    const byGroupByWindow: Record<string, WindowByGroup> = {};
    for (const w of WINDOWS) {
      const subset = rows.filter((r) => Math.abs(r.hoursBeforeSession) <= w);
      const bg = emptyByGroup();
      let inserts = 0, updates = 0, deletes = 0, traineeListMoves = 0;
      for (const r of subset) {
        const g = bg[r.group];
        g.total += 1;
        if (r.action === "insert") { g.inserts += 1; inserts += 1; }
        else if (r.action === "delete") { g.deletes += 1; deletes += 1; }
        else { g.updates += 1; updates += 1; }
        if (r.group === "trainee") traineeListMoves += 1;
      }
      totalsByWindow[String(w)] = { all: subset.length, inserts, updates, deletes, traineeListMoves };
      byGroupByWindow[String(w)] = bg;
    }

    return {
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd,
      windowsHours: [...WINDOWS],
      totals: totalsByWindow["48"],
      byGroup: byGroupByWindow["48"],
      totalsByWindow,
      byGroupByWindow,
      rows,
    };
  });
