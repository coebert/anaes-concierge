import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Cron-triggered anomaly detector for decryption RPC access.
 *
 * Authenticated via the `CLWROTA_WEBHOOK_SECRET` server-only secret, supplied
 * in the `x-webhook-secret` header (reused so no new secret is required).
 *
 * Runs `public.detect_rpc_access_anomalies` which inserts alerts into
 * `public.rpc_access_alerts` for:
 *  - callers exceeding the per-RPC call threshold within the window
 *  - callers who lack admin / rota_coordinator role (unexpected user)
 *
 * Query params (optional):
 *   window=<minutes>  default 10
 *   threshold=<n>     default 50
 */
export const Route = createFileRoute("/api/public/hooks/rpc-access-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-webhook-secret") ?? "";
        const expected = process.env.CLWROTA_WEBHOOK_SECRET ?? "";
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const params = new URL(request.url).searchParams;
        const windowMinutes = Math.max(1, Math.min(1440, Number(params.get("window") ?? "10") || 10));
        const threshold = Math.max(1, Math.min(100000, Number(params.get("threshold") ?? "50") || 50));

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc(
          "detect_rpc_access_anomalies" as never,
          { p_window_minutes: windowMinutes, p_threshold: threshold } as never,
        );
        if (error) {
          return new Response(
            JSON.stringify({ ok: false, error: error.message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ ok: true, inserted: data ?? 0, window_minutes: windowMinutes, threshold }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
