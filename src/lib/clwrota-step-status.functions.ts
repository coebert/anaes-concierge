import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const SYNC_STEPS = ["staff", "rota", "leave"] as const;


/**
 * Admin-only read of per-step CLWRota sync health: combines the latest
 * `clwrota_sync_metrics` row per step with the shared rate-limiter row
 * from `clwrota_sync_rate_limit`, plus the recent run history of the
 * consolidated hourly cron job so admins can see when the rate-limiter
 * fired vs skipped each step.
 */
export type SyncStep = "staff" | "rota" | "leave";

export type StepMetric = {
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

export type StepRateLimit = {
  step: SyncStep;
  min_interval_seconds: number;
  last_attempt_at: string | null;
  last_request_id: number | null;
  updated_at: string;
  next_allowed_at: string | null;
};

export type StepStatus = {
  step: SyncStep;
  latest: StepMetric | null;
  rateLimit: StepRateLimit | null;
};

export type RateLimiterRun = {
  runid: number | null;
  start_time: string | null;
  end_time: string | null;
  status: string | null;
  return_message: string | null;
  /** Per-step decision parsed from the cron return_message, when possible. */
  decisions: Record<SyncStep, "fired" | "skipped" | "unknown">;
};

export type ClwRotaStepStatusResponse = {
  steps: StepStatus[];
  rateLimiterRuns: RateLimiterRun[];
};

const STEPS: SyncStep[] = ["staff", "rota", "leave"];

function parseDecisions(message: string | null): Record<SyncStep, "fired" | "skipped" | "unknown"> {
  const out: Record<SyncStep, "fired" | "skipped" | "unknown"> = {
    staff: "unknown",
    rota: "unknown",
    leave: "unknown",
  };
  if (!message) return out;
  for (const step of STEPS) {
    // Look for `step_request_id":<value>` or `step_request_id: <value>` in
    // the postgres return_message. A numeric value means the http_post
    // dispatched; explicit null means the rate-limiter (or advisory lock)
    // suppressed the call.
    const re = new RegExp(`${step}_request_id"?\\s*[:=]\\s*(null|\\d+)`, "i");
    const m = message.match(re);
    if (!m) continue;
    out[step] = m[1].toLowerCase() === "null" ? "skipped" : "fired";
  }
  return out;
}

export const getClwRotaStepStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ClwRotaStepStatusResponse> => {
    const { supabase, userId } = context;

    const { data: isAdmin, error: roleErr } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (roleErr) throw new Error(roleErr.message);
    if (!isAdmin) throw new Error("Admin role required");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [rateRes, cronRes] = await Promise.all([
      supabaseAdmin
        .from("clwrota_sync_rate_limit")
        .select("step, min_interval_seconds, last_attempt_at, last_request_id, updated_at"),
      supabaseAdmin.rpc("list_clwrota_cron_runs", { p_limit: 30 }),
    ]);

    if (rateRes.error) throw new Error(rateRes.error.message);
    if (cronRes.error) throw new Error(cronRes.error.message);

    // Latest metric per step — one round trip each, capped at 1 row.
    const latestPerStep = await Promise.all(
      STEPS.map(async (step) => {
        const { data, error } = await supabaseAdmin
          .from("clwrota_sync_metrics")
          .select(
            "run_at, ok, duration_ms, rows_pulled, rows_upserted, rows_failed, rows_skipped_validation, errors_count, notes",
          )
          .eq("sync_kind", step)
          .order("run_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return { step, latest: (data as StepMetric | null) ?? null };
      }),
    );

    const rateByStep = new Map<SyncStep, StepRateLimit>();
    for (const row of (rateRes.data ?? []) as Array<{
      step: SyncStep;
      min_interval_seconds: number;
      last_attempt_at: string | null;
      last_request_id: number | null;
      updated_at: string;
    }>) {
      const nextAllowedAt = row.last_attempt_at
        ? new Date(
            new Date(row.last_attempt_at).getTime() + row.min_interval_seconds * 1000,
          ).toISOString()
        : null;
      rateByStep.set(row.step, { ...row, next_allowed_at: nextAllowedAt });
    }

    const steps: StepStatus[] = latestPerStep.map(({ step, latest }) => ({
      step,
      latest,
      rateLimit: rateByStep.get(step) ?? null,
    }));

    const cronRows = (cronRes.data ?? []) as Array<{
      jobname: string;
      runid: number | null;
      start_time: string | null;
      end_time: string | null;
      status: string | null;
      return_message: string | null;
    }>;

    const rateLimiterRuns: RateLimiterRun[] = cronRows
      .filter((r) => r.jobname === "clwrota-sync-hourly-all" && r.runid != null)
      .slice(0, 12)
      .map((r) => ({
        runid: r.runid,
        start_time: r.start_time,
        end_time: r.end_time,
        status: r.status,
        return_message: r.return_message,
        decisions: parseDecisions(r.return_message),
      }));

    return { steps, rateLimiterRuns };
  });
