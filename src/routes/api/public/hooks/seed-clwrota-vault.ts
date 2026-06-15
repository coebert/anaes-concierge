import { createFileRoute } from "@tanstack/react-router";

/**
 * One-shot seed hook: copies the runtime `CLWROTA_WEBHOOK_SECRET` env var
 * into Supabase Vault under the same name so `pg_cron` can read it when
 * invoking `/api/public/hooks/clwrota-sync`.
 *
 * Auth: caller must present the same `x-webhook-secret` header used by the
 * sync hook. This prevents unauthenticated internet users from triggering
 * Vault writes or probing whether the secret is configured.
 */
const GENERIC_UNAUTH = new Response(
  JSON.stringify({ ok: false, error: "Unauthorized" }),
  { status: 401, headers: { "Content-Type": "application/json" } },
);

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export const Route = createFileRoute("/api/public/hooks/seed-clwrota-vault")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CLWROTA_WEBHOOK_SECRET ?? "";
        const provided = request.headers.get("x-webhook-secret") ?? "";
        // Treat "secret not configured" and "wrong secret" identically so the
        // endpoint never leaks configuration state to unauthenticated probes.
        if (!expected || !provided || !timingSafeEqualStr(provided, expected)) {
          return GENERIC_UNAUTH;
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.rpc("upsert_vault_secret", {
          p_name: "CLWROTA_WEBHOOK_SECRET",
          p_secret: expected,
          p_description:
            "Used by pg_cron to authenticate to /api/public/hooks/clwrota-sync",
        });

        if (error) {
          return new Response(
            JSON.stringify({ ok: false, error: "vault upsert failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return Response.json({ ok: true });
      },
    },
  },
});
