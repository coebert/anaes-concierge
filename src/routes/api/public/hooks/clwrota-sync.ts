import { createFileRoute } from "@tanstack/react-router";

/**
 * Cron-triggered full CLWRota resync (staff + rota).
 * Called by pg_cron with the Supabase anon key in the `apikey` header.
 */
export const Route = createFileRoute("/api/public/hooks/clwrota-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!expected || apiKey !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Dynamic import — keeps server-only modules out of the client bundle.
        const { performStaffSync, performRotaSync } = await import(
          "@/lib/clwrota.functions"
        );

        const result: {
          staff?: unknown;
          rota?: unknown;
          staffError?: string;
          rotaError?: string;
        } = {};

        try {
          result.staff = await performStaffSync();
        } catch (e) {
          result.staffError = e instanceof Error ? e.message : String(e);
        }

        try {
          result.rota = await performRotaSync();
        } catch (e) {
          result.rotaError = e instanceof Error ? e.message : String(e);
        }

        const ok = !result.staffError && !result.rotaError;
        return new Response(JSON.stringify({ ok, ...result }), {
          status: ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
