import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Scheduled daily intensive-care (ICU) feed sync.
 *
 * Each invocation processes one bounded slice of the ICU window and stores the
 * raw CLWRota records behind every detected ICU session, so the feed builds up
 * gradually across days without exhausting the Worker's memory.
 *
 * Auth: `x-webhook-secret: $CLWROTA_WEBHOOK_SECRET`.
 */
export const Route = createFileRoute("/api/public/hooks/icu-sync")({
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

        try {
          const { runIcuSyncJob } = await import("@/features/analytics/icu-sync-job.server");
          const result = await runIcuSyncJob({ maxSlices, sliceDays });
          return new Response(JSON.stringify({ ok: result.status !== "failed", ...result }), {
            status: result.status === "failed" ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("icu-sync hook failed:", message);
          return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
