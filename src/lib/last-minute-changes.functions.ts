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
 *
 * This server function aggregates those rows over a date range and
 * breaks them down by staffing group (grade), with extra emphasis on
 * trainees being moved between lists (action='update') within the
 * 48 hour window.
 */

export type StaffingGroup =
  | "consultant"
  | "trainee"
  | "sas"
  | "anp"
  | "other"
  | "unknown";

export type LastMinuteChangeRow = {
  id: string;
  changedAt: string;
  sessionDate: string;
  session: string;
  action: "insert" | "update" | "delete" | string;
  hoursBeforeSession: number;
  staffId: string | null;
  staffName: string;
  group: StaffingGroup;
  changedByName: string | null;
};

export type LastMinuteChangesAudit = {
  rangeStart: string;
  rangeEnd: string;
  windowHours: 48;
  totals: {
    all: number;
    inserts: number;
    updates: number;
    deletes: number;
    traineeListMoves: number;
  };
  byGroup: Record<StaffingGroup, {
    total: number;
    inserts: number;
    updates: number;
    deletes: number;
  }>;
  rows: LastMinuteChangeRow[];
};

function gradeToGroup(grade: string | null | undefined): StaffingGroup {
  switch ((grade ?? "").toLowerCase()) {
    case "consultant": return "consultant";
    case "trainee":    return "trainee";
    case "sas":        return "sas";
    case "anp":        return "anp";
    case "":
    case null as unknown as string:
      return "unknown";
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

    // Pull every late-change row whose target session falls in range.
    const { data: logs, error } = await supabase
      .from("rota_change_log")
      .select("id, action, session_date, session, staff_id, session_start_ts, changed_at, hours_before_session, changed_by")
      .gte("session_date", data.rangeStart)
      .lte("session_date", data.rangeEnd)
      .lte("hours_before_session", 48)
      .gte("hours_before_session", -48)
      .order("changed_at", { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);

    const staffIds = Array.from(new Set(
      (logs ?? []).flatMap((r) => [r.staff_id, r.changed_by]).filter((x): x is string => !!x),
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

    const rows: LastMinuteChangeRow[] = (logs ?? []).map((r) => {
      const prof = r.staff_id ? profileMap.get(r.staff_id) : null;
      const changer = r.changed_by ? profileMap.get(r.changed_by) : null;
      return {
        id: r.id,
        changedAt: r.changed_at,
        sessionDate: r.session_date,
        session: r.session ?? "",
        action: (r.action ?? "update") as LastMinuteChangeRow["action"],
        hoursBeforeSession: Number(r.hours_before_session ?? 0),
        staffId: r.staff_id,
        staffName: prof?.full_name ?? (r.staff_id ? "Unknown staff" : "—"),
        group: gradeToGroup(prof?.grade),
        changedByName: changer?.full_name ?? null,
      };
    });

    const byGroup = emptyByGroup();
    let inserts = 0, updates = 0, deletes = 0, traineeListMoves = 0;
    for (const r of rows) {
      const g = byGroup[r.group];
      g.total += 1;
      if (r.action === "insert") { g.inserts += 1; inserts += 1; }
      else if (r.action === "delete") { g.deletes += 1; deletes += 1; }
      else { g.updates += 1; updates += 1; }
      if (r.group === "trainee" && (r.action === "update" || r.action === "insert" || r.action === "delete")) {
        traineeListMoves += 1;
      }
    }

    return {
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd,
      windowHours: 48,
      totals: { all: rows.length, inserts, updates, deletes, traineeListMoves },
      byGroup,
      rows,
    };
  });
