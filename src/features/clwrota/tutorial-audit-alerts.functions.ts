import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type TutorialAuditAlert = {
  id: string;
  window_start: string;
  window_end: string;
  source_count: number;
  audit_count: number;
  created_at: string;
  acknowledged_at: string | null;
  missingFromAudit: Array<{ staffName: string; session_date: string; session: string; label: string | null }>;
  extraInAudit: Array<{ staffName: string; session_date: string; session: string; label: string | null }>;
};

export type TutorialAuditStatus = {
  enabled: boolean;
  paused: boolean;
  pausedReason: string | null;
  cursorStart: string | null;
  horizonEnd: string | null;
  nextPassAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  openAlerts: TutorialAuditAlert[];
  recentRuns: Array<{
    id: string;
    window_start: string;
    window_end: string;
    source_count: number;
    audit_count: number;
    diverged: boolean;
    created_at: string;
  }>;
};

async function assertCoordinator(context: { supabase: typeof import("@/integrations/supabase/client").supabase; userId: string }) {
  const { data: roles, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .in("role", ["admin", "rota_coordinator"]);
  if (error) throw new Error(error.message);
  if (!roles || roles.length === 0) {
    throw new Error("Forbidden: requires admin or rota coordinator access.");
  }
}

export const getTutorialAuditStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TutorialAuditStatus> => {
    await assertCoordinator(context);

    const [stateRes, alertRes, runsRes] = await Promise.all([
      context.supabase.from("tutorial_audit_job_state").select("*").eq("id", 1).maybeSingle(),
      context.supabase
        .from("tutorial_audit_alerts")
        .select("*")
        .is("acknowledged_at", null)
        .order("created_at", { ascending: false })
        .limit(25),
      context.supabase
        .from("tutorial_audit_runs")
        .select("id,window_start,window_end,source_count,audit_count,diverged,created_at")
        .order("created_at", { ascending: false })
        .limit(15),
    ]);
    if (stateRes.error) throw new Error(stateRes.error.message);
    if (alertRes.error) throw new Error(alertRes.error.message);
    if (runsRes.error) throw new Error(runsRes.error.message);

    const state = stateRes.data;
    return {
      enabled: state?.enabled ?? false,
      paused: state?.paused ?? false,
      pausedReason: state?.paused_reason ?? null,
      cursorStart: state?.cursor_start ?? null,
      horizonEnd: state?.horizon_end ?? null,
      nextPassAt: state?.next_pass_at ?? null,
      lastRunAt: state?.last_run_at ?? null,
      lastError: state?.last_error ?? null,
      openAlerts: (alertRes.data ?? []).map((a) => {
        const details = (a.details ?? {}) as Record<string, unknown>;
        return {
          id: a.id as string,
          window_start: a.window_start as string,
          window_end: a.window_end as string,
          source_count: a.source_count as number,
          audit_count: a.audit_count as number,
          created_at: a.created_at as string,
          acknowledged_at: (a.acknowledged_at as string | null) ?? null,
          missingFromAudit: (details.missingFromAudit ?? []) as TutorialAuditAlert["missingFromAudit"],
          extraInAudit: (details.extraInAudit ?? []) as TutorialAuditAlert["extraInAudit"],
        };
      }),
      recentRuns: (runsRes.data ?? []) as TutorialAuditStatus["recentRuns"],
    };
  });

export const acknowledgeTutorialAuditAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await assertCoordinator(context);
    const { error } = await context.supabase
      .from("tutorial_audit_alerts")
      .update({
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: context.userId,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
