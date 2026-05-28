import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Cron-triggered full CLWRota resync (staff + rota).
 * Authenticated via a dedicated server-only secret (`CLWROTA_WEBHOOK_SECRET`),
 * sent in the `x-webhook-secret` header. The previously-used Supabase
 * publishable key was insecure because it is exposed in the client bundle.
 */
export const Route = createFileRoute("/api/public/hooks/clwrota-sync")({
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

        // Dynamic import — keeps server-only modules out of the client bundle.
        const { performStaffSync, performRotaSync, performLeaveSync } = await import(
          "@/lib/clwrota.functions"
        );

        const result: {
          staff?: unknown;
          rota?: unknown;
          leave?: unknown;
          staffError?: string;
          rotaError?: string;
          leaveError?: string;
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

        try {
          result.leave = await performLeaveSync();
        } catch (e) {
          result.leaveError = e instanceof Error ? e.message : String(e);
        }

        const ok = !result.staffError && !result.rotaError && !result.leaveError;
        return new Response(JSON.stringify({ ok, ...result }), {
          status: ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });

      },
    },
  },
});
