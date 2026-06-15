import { createFileRoute } from "@tanstack/react-router";

/**
 * One-shot seed hook: copies the runtime `CLWROTA_WEBHOOK_SECRET` env var
 * into Supabase Vault under the same name so `pg_cron` can read it when
 * invoking the sync hook.
 *
 * Safe to expose publicly:
 *   - reads only from `process.env` (server-only); cannot reveal the value
 *   - writes only into Vault (encrypted at rest, no SELECT grant to anon)
 *   - idempotent — re-running it just updates the stored value
 */
export const Route = createFileRoute("/api/public/hooks/seed-clwrota-vault")({
  server: {
    handlers: {
      POST: async () => {
        const secret = process.env.CLWROTA_WEBHOOK_SECRET ?? "";
        if (!secret) {
          return new Response(
            JSON.stringify({ ok: false, error: "CLWROTA_WEBHOOK_SECRET is not set in the server environment." }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Use vault.create_secret / vault.update_secret via RPC-style SQL.
        // Look up an existing entry first; create or update accordingly.
        const { data: existing, error: lookupErr } = await supabaseAdmin
          .schema("vault" as never)
          .from("secrets" as never)
          .select("id,name")
          .eq("name", "CLWROTA_WEBHOOK_SECRET")
          .maybeSingle();

        if (lookupErr) {
          return new Response(
            JSON.stringify({ ok: false, error: `vault lookup failed: ${lookupErr.message}` }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }

        if (existing && (existing as { id: string }).id) {
          const { error: updErr } = await supabaseAdmin.rpc("vault_update_secret" as never, {
            secret_id: (existing as { id: string }).id,
            new_secret: secret,
            new_name: "CLWROTA_WEBHOOK_SECRET",
            new_description: "Used by pg_cron to authenticate to /api/public/hooks/clwrota-sync",
          } as never);
          if (updErr) {
            return new Response(
              JSON.stringify({ ok: false, error: `vault update failed: ${updErr.message}` }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
          return Response.json({ ok: true, action: "updated" });
        }

        const { error: createErr } = await supabaseAdmin.rpc("vault_create_secret" as never, {
          new_secret: secret,
          new_name: "CLWROTA_WEBHOOK_SECRET",
          new_description: "Used by pg_cron to authenticate to /api/public/hooks/clwrota-sync",
        } as never);
        if (createErr) {
          return new Response(
            JSON.stringify({ ok: false, error: `vault create failed: ${createErr.message}` }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return Response.json({ ok: true, action: "created" });
      },
    },
  },
});
