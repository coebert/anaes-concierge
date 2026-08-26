import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Scheduled weekly tutorial backfill + audit verification.
 *
 * Called on a short cron cadence; the job itself decides whether a weekly
 * pass is due, processes a bounded number of windows, and exits. Divergences
 * between CLWRota and the audit raise an alert row surfaced in the app.
 *
 * Auth: `x-webhook-secret: $CLWROTA_WEBHOOK_SECRET`.
 */
export const Route = createFileRoute("/api/public/hooks/tutorial-weekly-audit")({
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
          const { runWeeklyTutorialAuditJob } = await import(
            "@/features/clwrota/tutorial-weekly-job.server"
          );
          const result = await runWeeklyTutorialAuditJob({
            maxSlices,
            sliceDays,
            force,
          });
          return new Response(JSON.stringify({ ok: result.status !== "failed", ...result }), {
            status: result.status === "failed" ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("tutorial-weekly-audit hook failed:", message);
          return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
