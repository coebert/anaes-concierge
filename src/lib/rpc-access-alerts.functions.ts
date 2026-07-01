import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Admin server functions for decryption-RPC access alerts.
 *
 * Alerts are written by `detect_rpc_access_anomalies` (invoked by the
 * `/api/public/hooks/rpc-access-alerts` cron hook). RLS restricts reads and
 * acknowledgements to admins via `has_role(auth.uid(), 'admin')`.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[];

export type RpcAccessAlertRow = {
  id: number;
  alert_type: "threshold_exceeded" | "unexpected_user";
  rpc_name: string;
  subject_user: string | null;
  window_start: string;
  window_end: string;
  call_count: number;
  threshold: number | null;
  details: JsonValue;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
};

export const listRpcAccessAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        only_unacknowledged: z.boolean().optional(),
        since: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: RpcAccessAlertRow[] }> => {
    const { supabase } = context;
    let q = supabase
      .from("rpc_access_alerts" as never)
      .select(
        "id, alert_type, rpc_name, subject_user, window_start, window_end, call_count, threshold, details, acknowledged_at, acknowledged_by, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.only_unacknowledged) q = q.is("acknowledged_at" as never, null);
    if (data.since) q = q.gte("created_at" as never, data.since);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as unknown as RpcAccessAlertRow[] };
  });

export const acknowledgeRpcAccessAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.number().int().positive() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("rpc_access_alerts" as never)
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId } as never)
      .eq("id" as never, data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Admin on-demand scan (returns count inserted). Useful for a "Run now"
 * button in the alerts UI without waiting for the cron.
 */
export const runRpcAccessAnomalyScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        window_minutes: z.number().int().min(1).max(1440).default(10),
        threshold: z.number().int().min(1).max(100000).default(50),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: inserted, error } = await supabase.rpc(
      "detect_rpc_access_anomalies" as never,
      { p_window_minutes: data.window_minutes, p_threshold: data.threshold } as never,
    );
    if (error) throw new Error(error.message);
    return { inserted: (inserted as unknown as number) ?? 0 };
  });
