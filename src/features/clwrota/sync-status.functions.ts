import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Admin-only read of CLWRota sync health:
 *   - `state`: the singleton `clwrota_sync_state` row (last run + the
 *     "high water mark" timestamp that incremental syncs use).
 *   - `metrics`: most recent rows from `clwrota_sync_metrics`, grouped
 *     per sync_kind so the page can show a per-step history table.
 *   - `cron`: recent rows from `cron.job_run_details` for every
 *     `clwrota%` cron job, fetched through a SECURITY DEFINER helper
 *     because the cron schema is not reachable via PostgREST.
 *
 * Everything is loaded through the user-scoped Supabase client so RLS
 * gates the read to admins (table policies already require
 * `has_role(auth.uid(), 'admin')`).
 */
export type ClwRotaStatusState = {
  last_sync_at: string | null;
  last_successful_rota_sync_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_pulled_rows: number | null;
  sync_days_back: number | null;
  sync_days_ahead: number | null;
  incremental_days_back: number | null;
  incremental_days_ahead: number | null;
};

export type ClwRotaMetricRow = {
  id: string;
  sync_kind: "staff" | "rota" | "leave";
  run_at: string;
  ok: boolean;
  duration_ms: number | null;
  rows_pulled: number;
  rows_upserted: number;
  rows_failed: number;
  rows_skipped_validation: number;
  errors_count: number;
  notes: string | null;
};

export type ClwRotaCronRow = {
  jobname: string;
  schedule: string;
  active: boolean;
  runid: number | null;
  start_time: string | null;
  end_time: string | null;
  status: string | null;
  return_message: string | null;
  command: string;
};

export type ClwRotaStatusResponse = {
  state: ClwRotaStatusState | null;
  metrics: ClwRotaMetricRow[];
  cron: ClwRotaCronRow[];
};

export const getClwRotaSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ClwRotaStatusResponse> => {
    const { supabase, userId } = context;

    // Belt-and-braces admin check — RLS enforces this too, but a clean
    // error message is friendlier than an empty result.
    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Admin role required");

    // After the admin check, switch to the service-role client. The cron
    // RPC is restricted to service_role (never callable by signed-in
    // users) so it must be invoked here, not via the user-scoped client.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [stateRes, metricsRes, cronRes] = await Promise.all([
      supabaseAdmin
        .from("clwrota_sync_state")
        .select(
          "last_sync_at, last_successful_rota_sync_at, last_status, last_error, last_pulled_rows, sync_days_back, sync_days_ahead, incremental_days_back, incremental_days_ahead",
        )
        .eq("id", 1)
        .maybeSingle(),
      supabaseAdmin
        .from("clwrota_sync_metrics")
        .select(
          "id, sync_kind, run_at, ok, duration_ms, rows_pulled, rows_upserted, rows_failed, rows_skipped_validation, errors_count, notes",
        )
        .order("run_at", { ascending: false })
        .limit(60),
      supabaseAdmin.rpc("list_clwrota_cron_runs", { p_limit: 50 }),
    ]);

    if (stateRes.error) throw new Error(stateRes.error.message);
    if (metricsRes.error) throw new Error(metricsRes.error.message);
    if (cronRes.error) throw new Error(cronRes.error.message);

    return {
      state: (stateRes.data as ClwRotaStatusState | null) ?? null,
      metrics: (metricsRes.data ?? []) as ClwRotaMetricRow[],
      cron: (cronRes.data ?? []) as ClwRotaCronRow[],
    };
  });
