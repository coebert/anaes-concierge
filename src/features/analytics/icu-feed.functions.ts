import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Status of the daily intensive-care feed job, plus the raw ICU sessions it
 * has collected so far. Admin / rota coordinator only; read-only.
 */

export type IcuFeedRun = {
  id: string;
  windowStart: string;
  windowEnd: string;
  sourceCount: number;
  auditCount: number;
  diverged: boolean;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
};

export type IcuFeedSession = {
  id: string;
  sessionDate: string;
  session: string;
  staffName: string;
  dutyType: string | null;
  placeName: string | null;
  matchedValue: string | null;
  paCredit: number | null;
  clwrotaExternalId: string | null;
};

export type IcuFeedStatus = {
  enabled: boolean;
  cursor: string | null;
  sliceDays: number;
  daysBack: number;
  daysAhead: number;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalSessions: number;
  runs: IcuFeedRun[];
  sessions: IcuFeedSession[];
};

async function assertCoordinator(context: {
  supabase: { from: (t: string) => any };
  userId: string;
}) {
  const { data: roles, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .in("role", ["admin", "rota_coordinator"]);
  if (error) throw new Error(error.message);
  if (!roles || roles.length === 0) {
    throw new Error("Forbidden: the ICU feed requires admin or rota coordinator access.");
  }
}

export const getIcuFeedStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({
        startIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .refine((v) => v.startIso <= v.endIso, { message: "startIso must be before endIso" })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<IcuFeedStatus> => {
    await assertCoordinator(context as never);

    const [stateRes, runsRes, sessionsRes, countRes] = await Promise.all([
      context.supabase.from("icu_sync_state").select("*").eq("id", 1).maybeSingle(),
      context.supabase
        .from("icu_sync_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20),
      context.supabase
        .from("icu_detection_matches")
        .select(
          "id,session_date,session,duty_type,place_name,matched_value,pa_credit,clwrota_external_id,staff_id,person_label",
        )
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso)
        .order("session_date", { ascending: false })
        .limit(500),
      context.supabase
        .from("icu_detection_matches")
        .select("id", { count: "exact", head: true })
        .gte("session_date", data.startIso)
        .lte("session_date", data.endIso),
    ]);

    if (stateRes.error) throw new Error(stateRes.error.message);
    if (runsRes.error) throw new Error(runsRes.error.message);
    if (sessionsRes.error) throw new Error(sessionsRes.error.message);

    const rows = sessionsRes.data ?? [];
    const ids = [...new Set(rows.map((r: { staff_id: string }) => r.staff_id))];
    const nameById = new Map<string, string>();
    if (ids.length > 0) {
      const { data: profiles } = await context.supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", ids);
      for (const p of profiles ?? []) nameById.set(p.id, p.full_name);
    }

    const state = stateRes.data;
    return {
      enabled: state?.enabled ?? true,
      cursor: state?.cursor_start ?? null,
      sliceDays: state?.slice_days ?? 7,
      daysBack: state?.days_back ?? 365,
      daysAhead: state?.days_ahead ?? 60,
      lastRunAt: state?.last_run_at ?? null,
      lastError: state?.last_error ?? null,
      consecutiveFailures: state?.consecutive_failures ?? 0,
      totalSessions: countRes.count ?? rows.length,
      runs: (runsRes.data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        windowStart: r.window_start as string,
        windowEnd: r.window_end as string,
        sourceCount: (r.source_count as number) ?? 0,
        auditCount: (r.audit_count as number) ?? 0,
        diverged: Boolean(r.diverged),
        ok: Boolean(r.ok),
        error: (r.error as string | null) ?? null,
        durationMs: (r.duration_ms as number | null) ?? null,
        createdAt: r.created_at as string,
      })),
      sessions: rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        sessionDate: r.session_date as string,
        session: r.session as string,
        staffName:
          nameById.get(r.staff_id as string) ??
          ((r.person_label as string | null) || (r.staff_id as string)),
        dutyType: (r.duty_type as string | null) ?? null,
        placeName: (r.place_name as string | null) ?? null,
        matchedValue: (r.matched_value as string | null) ?? null,
        paCredit: (r.pa_credit as number | null) ?? null,
        clwrotaExternalId: (r.clwrota_external_id as string | null) ?? null,
      })),
    };
  });
