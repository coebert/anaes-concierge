import { createFileRoute } from "@tanstack/react-router";

/**
 * One-shot seed hook: copies the runtime `CLWROTA_WEBHOOK_SECRET` env var
 * into Supabase Vault under the same name so `pg_cron` can read it when
 * invoking `/api/public/hooks/clwrota-sync`.
 *
 * Safe to expose under `/api/public/`:
 *   - reads only from `process.env` (server-only); never returns the value
 *   - writes only into Vault (encrypted at rest, no SELECT for anon/auth)
 *   - idempotent — re-running it just refreshes the stored value
 */
export const Route = createFileRoute("/api/public/hooks/seed-clwrota-vault")({
  server: {
    handlers: {
      POST: async () => {
        const secret = process.env.CLWROTA_WEBHOOK_SECRET ?? "";
        if (!secret) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "CLWROTA_WEBHOOK_SECRET is not set in the server environment.",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc("upsert_vault_secret", {
          p_name: "CLWROTA_WEBHOOK_SECRET",
          p_secret: secret,
          p_description:
            "Used by pg_cron to authenticate to /api/public/hooks/clwrota-sync",
        });

        if (error) {
          return new Response(
            JSON.stringify({ ok: false, error: `vault upsert failed: ${error.message}` }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return Response.json({ ok: true, vault_id: data });
      },
    },
  },
});
