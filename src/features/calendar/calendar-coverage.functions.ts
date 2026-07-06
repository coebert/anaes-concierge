import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Backend check that verifies the global /calendar can resolve staff names
 * for every date in a visible range.
 *
 * A calendar cell shows a name by looking the assignment's `staff_id` up in
 * the map produced by `listActiveStaffSafe` (which reads
 * `get_profiles_decrypted`). Two failure modes hide a name from the grid:
 *   1. The referenced profile is missing or has a null/blank `full_name`.
 *   2. The referenced profile exists but is inactive — `listActiveStaffSafe`
 *      filters those out, so the cell renders "—".
 *
 * We also surface dates that have zero rota assignments so admins can tell
 * "no data" apart from "data with missing names".
 */

export type CalendarCoverageDay = {
  date: string;
  assignmentCount: number;
  distinctStaff: number;
  unresolvedStaffIds: string[]; // no profile row / null full_name
  inactiveStaffIds: string[]; // profile exists but active=false
};

export type CalendarCoverageResult = {
  start: string;
  end: string;
  activeStaffTotal: number;
  activeStaffNamed: number;
  days: CalendarCoverageDay[];
  datesWithoutData: string[];
  datesWithMissingNames: string[];
  unresolvedTotal: number;
  inactiveTotal: number;
};

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "start/end must be ISO yyyy-mm-dd");

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const checkCalendarStaffCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ start: DateSchema, end: DateSchema })
      .refine((v) => v.start <= v.end, { message: "start must be <= end" })
      .refine((v) => {
        const s = new Date(v.start + "T00:00:00Z").getTime();
        const e = new Date(v.end + "T00:00:00Z").getTime();
        return (e - s) / 86400_000 <= 92;
      }, { message: "range must be <= 92 days" })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<CalendarCoverageResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Admin guard — the check enumerates staff_ids across the whole range,
    // so we keep it to the same audience as the admin dashboard.
    const { data: isAdmin, error: roleErr } = await context.supabase.rpc(
      "has_role" as never,
      { _user_id: context.userId, _role: "admin" } as never,
    );
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Forbidden: admin role required.");

    const [profilesRes, assignmentsRes] = await Promise.all([
      supabaseAdmin.rpc("get_profiles_decrypted"),
      supabaseAdmin
        .from("rota_assignments")
        .select("staff_id, session_date")
        .gte("session_date", data.start)
        .lte("session_date", data.end)
        .range(0, 99999),
    ]);
    if (profilesRes.error) throw new Error(profilesRes.error.message);
    if (assignmentsRes.error) throw new Error(assignmentsRes.error.message);

    type ProfileLite = { id: string; full_name: string | null; active: boolean };
    const profileMap = new Map<string, ProfileLite>();
    let activeTotal = 0;
    let activeNamed = 0;
    for (const p of (profilesRes.data ?? []) as ProfileLite[]) {
      profileMap.set(p.id, p);
      if (p.active) {
        activeTotal += 1;
        if (p.full_name && p.full_name.trim().length > 0) activeNamed += 1;
      }
    }

    const perDate = new Map<
      string,
      { staff: Set<string>; count: number }
    >();
    for (const iso of eachDate(data.start, data.end)) {
      perDate.set(iso, { staff: new Set(), count: 0 });
    }
    for (const a of (assignmentsRes.data ?? []) as Array<{
      staff_id: string | null;
      session_date: string;
    }>) {
      const bucket = perDate.get(a.session_date);
      if (!bucket) continue;
      bucket.count += 1;
      if (a.staff_id) bucket.staff.add(a.staff_id);
    }

    const days: CalendarCoverageDay[] = [];
    const datesWithoutData: string[] = [];
    const datesWithMissingNames: string[] = [];
    let unresolvedTotal = 0;
    let inactiveTotal = 0;

    for (const [date, bucket] of perDate) {
      if (bucket.count === 0) datesWithoutData.push(date);
      const unresolved: string[] = [];
      const inactive: string[] = [];
      for (const id of bucket.staff) {
        const p = profileMap.get(id);
        if (!p || !p.full_name || p.full_name.trim().length === 0) {
          unresolved.push(id);
        } else if (!p.active) {
          inactive.push(id);
        }
      }
      unresolvedTotal += unresolved.length;
      inactiveTotal += inactive.length;
      if (unresolved.length > 0 || inactive.length > 0) datesWithMissingNames.push(date);
      days.push({
        date,
        assignmentCount: bucket.count,
        distinctStaff: bucket.staff.size,
        unresolvedStaffIds: unresolved,
        inactiveStaffIds: inactive,
      });
    }

    days.sort((a, b) => a.date.localeCompare(b.date));
    datesWithoutData.sort();
    datesWithMissingNames.sort();

    return {
      start: data.start,
      end: data.end,
      activeStaffTotal: activeTotal,
      activeStaffNamed: activeNamed,
      days,
      datesWithoutData,
      datesWithMissingNames,
      unresolvedTotal,
      inactiveTotal,
    };
  });
