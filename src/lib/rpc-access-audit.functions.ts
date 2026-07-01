import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Admin-only reader for the `rpc_access_audit` log. Rows are written by
 * SECURITY DEFINER helpers whenever a decryption RPC
 * (get_profiles_decrypted, get_profile_decrypted,
 *  get_access_requests_decrypted, get_leave_requests_decrypted) is called.
 *
 * RLS on the table already restricts SELECT to admins via has_role(); we
 * use the caller-scoped supabase client so the check is enforced.
 */
const querySchema = z.object({
  rpc_name: z.string().max(80).optional(),
  called_by: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export type RpcAccessAuditRow = {
  id: number;
  rpc_name: string;
  called_by: string | null;
  db_role: string;
  row_count: number | null;
  args: unknown;
  called_at: string;
};

export const listRpcAccessAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => querySchema.parse(d))
  .handler(async ({ data, context }): Promise<{ rows: RpcAccessAuditRow[] }> => {
    const { supabase } = context;

    let q = supabase
      .from("rpc_access_audit" as never)
      .select("id, rpc_name, called_by, db_role, row_count, args, called_at")
      .order("called_at", { ascending: false })
      .limit(data.limit);

    if (data.rpc_name) q = q.eq("rpc_name" as never, data.rpc_name);
    if (data.called_by) q = q.eq("called_by" as never, data.called_by);
    if (data.since) q = q.gte("called_at" as never, data.since);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as unknown as RpcAccessAuditRow[] };
  });

/**
 * Summary metrics: counts and last-called-at, grouped by rpc_name and caller.
 * Useful for dashboards that surface "who's been pulling decrypted data".
 */
export const summarizeRpcAccessAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        since: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    let q = supabase
      .from("rpc_access_audit" as never)
      .select("rpc_name, called_by, called_at, row_count")
      .order("called_at", { ascending: false })
      .limit(5000);
    if (data.since) q = q.gte("called_at" as never, data.since);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    type Row = { rpc_name: string; called_by: string | null; called_at: string; row_count: number | null };
    const buckets = new Map<
      string,
      { rpc_name: string; called_by: string | null; calls: number; total_rows: number; last_called_at: string }
    >();
    for (const r of (rows ?? []) as unknown as Row[]) {
      const key = `${r.rpc_name}::${r.called_by ?? "anon"}`;
      const b = buckets.get(key);
      if (b) {
        b.calls += 1;
        b.total_rows += r.row_count ?? 0;
        if (r.called_at > b.last_called_at) b.last_called_at = r.called_at;
      } else {
        buckets.set(key, {
          rpc_name: r.rpc_name,
          called_by: r.called_by,
          calls: 1,
          total_rows: r.row_count ?? 0,
          last_called_at: r.called_at,
        });
      }
    }
    return { summary: [...buckets.values()].sort((a, b) => b.calls - a.calls) };
  });
