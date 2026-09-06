import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Scheduled weekly intensive-care (ICU) backfill + audit verification.
 *
 * Called on a short cron cadence; the job itself decides whether a weekly
 * pass is due, re-downloads one bounded CLWRota slice, re-scans it for ICU
 * sessions, and raises an alert row when CLWRota and the audit diverge.
 *
 * Auth: `x-webhook-secret: $CLWROTA_WEBHOOK_SECRET`.
 */
export const Route = createFileRoute("/api/public/hooks/icu-weekly-audit")({
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
        const maxSlices = Number(params.get("maxSlices")) || undefined;
        const sliceDays = Number(params.get("sliceDays")) || undefined;
        const force = params.get("force") === "true";

        try {
          const { runIcuWeeklyAuditJob } = await import(
            "@/features/analytics/icu-weekly-job.server"
          );
          const result = await runIcuWeeklyAuditJob({ maxSlices, sliceDays, force });
          return new Response(JSON.stringify({ ok: result.status !== "failed", ...result }), {
            status: result.status === "failed" ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("icu-weekly-audit hook failed:", message);
          return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
