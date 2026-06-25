import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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

// ----- Zod schemas for runtime validation of Postgrest results -----

const RotaChangeLogRowSchema = z.object({
  id: z.string(),
  action: z.string().nullable(),
  session_date: z.string(),
  session: z.string().nullable(),
  staff_id: z.string().nullable(),
  session_start_ts: z.string(),
  changed_at: z.string(),
  hours_before_session: z.union([z.number(), z.string()]).nullable(),
  changed_by: z.string().nullable(),
  prev_theatre_session_id: z.string().nullable(),
  new_theatre_session_id: z.string().nullable(),
  prev_staff_id: z.string().nullable(),
});
type RotaChangeLogRow = z.infer<typeof RotaChangeLogRowSchema>;

const ProfileRowSchema = z.object({
  id: z.string(),
  full_name: z.string().nullable(),
  grade: z.string().nullable(),
});
type ProfileRow = z.infer<typeof ProfileRowSchema>;

const NamedRefSchema = z.union([
  z.object({ name: z.string() }),
  z.array(z.object({ name: z.string() })),
  z.null(),
]);
type NamedRef = z.infer<typeof NamedRefSchema>;

const TheatreSessionRowSchema = z.object({
  id: z.string(),
  theatre_id: z.string().nullable(),
  specialty_id: z.string().nullable(),
  theatres: NamedRefSchema,
  specialties: NamedRefSchema,
});
type TheatreSessionRow = z.infer<typeof TheatreSessionRowSchema>;

/**
 * Validate an array of rows row-by-row. Rows failing validation are dropped
 * and logged; this guarantees a typed array out and avoids crashing the audit
 * when one bad row arrives from Postgrest.
 */
function parseRows<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  label: string,
): T[] {
  if (!Array.isArray(raw)) {
    if (raw != null) console.warn(`[last-minute-changes] ${label}: expected array, got`, typeof raw);
    return [];
  }
  const out: T[] = [];
  let dropped = 0;
  for (const item of raw) {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
    else dropped += 1;
  }
  if (dropped > 0) {
    console.warn(`[last-minute-changes] ${label}: dropped ${dropped}/${raw.length} invalid rows`);
  }
  return out;
}

function firstName(ref: NamedRef): string | null {
  if (!ref) return null;
  if (Array.isArray(ref)) return ref[0]?.name ?? null;
  return ref.name ?? null;
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

    const emptyAudit = (): LastMinuteChangesAudit => {
      const WINDOWS = [24, 48] as const;
      const totalsByWindow: Record<string, WindowTotals> = {};
      const byGroupByWindow: Record<string, WindowByGroup> = {};
      for (const w of WINDOWS) {
        totalsByWindow[String(w)] = { all: 0, inserts: 0, updates: 0, deletes: 0, traineeListMoves: 0 };
        byGroupByWindow[String(w)] = emptyByGroup();
      }
      return {
        rangeStart: data.rangeStart,
        rangeEnd: data.rangeEnd,
        windowsHours: [...WINDOWS],
        totals: totalsByWindow["48"],
        byGroup: byGroupByWindow["48"],
        totalsByWindow,
        byGroupByWindow,
        rows: [],
      };
    };

    const isTransient = (e: unknown): boolean => {
      const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
      return msg.includes("networkerror") || msg.includes("fetch failed") || msg.includes("network request failed") || msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("timeout");
    };
    const withRetry = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const delays = [150, 400, 1000];
      let lastErr: unknown;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          if (attempt === delays.length || !isTransient(e)) throw e;
          console.warn(`[last-minute-changes] transient ${label} failure (attempt ${attempt + 1}), retrying in ${delays[attempt]}ms:`, e);
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
      throw lastErr;
    };

    try {
    const logsResult = await withRetry("rota_change_log", async () => await supabase
      .from("rota_change_log")
      .select("id, action, session_date, session, staff_id, session_start_ts, changed_at, hours_before_session, changed_by, prev_theatre_session_id, new_theatre_session_id, prev_staff_id")
      .gte("session_date", data.rangeStart)
      .lte("session_date", data.rangeEnd)
      .lte("hours_before_session", 48)
      .gte("hours_before_session", -48)
      .order("changed_at", { ascending: false })
      .limit(5000));
    if (logsResult.error) throw new Error(logsResult.error.message);
    const logs: RotaChangeLogRow[] = parseRows(RotaChangeLogRowSchema, logsResult.data, "rota_change_log");

    const staffIds: string[] = Array.from(new Set(
      logs.flatMap((r): (string | null)[] => [r.staff_id, r.changed_by, r.prev_staff_id])
          .filter((x): x is string => !!x),
    ));
    const sessionIds: string[] = Array.from(new Set(
      logs.flatMap((r): (string | null)[] => [r.prev_theatre_session_id, r.new_theatre_session_id])
          .filter((x): x is string => !!x),
    ));

    const profileMap = new Map<string, { full_name: string | null; grade: string | null }>();
    if (staffIds.length > 0) {
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name, grade")
        .in("id", staffIds);
      if (pErr) throw new Error(pErr.message);
      const profileRows: ProfileRow[] = parseRows(ProfileRowSchema, profs, "profiles");
      for (const p of profileRows) profileMap.set(p.id, { full_name: p.full_name, grade: p.grade });
    }

    const listMap = new Map<string, ListRef>();
    if (sessionIds.length > 0) {
      const { data: sess, error: sErr } = await supabase
        .from("theatre_sessions")
        .select("id, theatre_id, specialty_id, theatres(name), specialties(name)")
        .in("id", sessionIds);
      if (sErr) throw new Error(sErr.message);
      const sessionRows: TheatreSessionRow[] = parseRows(TheatreSessionRowSchema, sess, "theatre_sessions");
      for (const s of sessionRows) {
        const theatre = firstName(s.theatres) ?? "Unknown theatre";
        const specialty = firstName(s.specialties);
        listMap.set(s.id, {
          id: s.id,
          theatre,
          specialty,
          label: specialty ? `${theatre} · ${specialty}` : theatre,
        });
      }
    }

    const rows: LastMinuteChangeRow[] = logs.map((r): LastMinuteChangeRow => {
      const prof = r.staff_id ? profileMap.get(r.staff_id) ?? null : null;
      const prevProf = r.prev_staff_id ? profileMap.get(r.prev_staff_id) ?? null : null;
      const changer = r.changed_by ? profileMap.get(r.changed_by) ?? null : null;
      return {
        id: r.id,
        changedAt: r.changed_at,
        sessionDate: r.session_date,
        sessionStartTs: r.session_start_ts,
        session: r.session ?? "",
        action: r.action ?? "update",
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
    } catch (err) {
      console.error("getLastMinuteChangesAudit failed:", err);
      return emptyAudit();
    }
  });
