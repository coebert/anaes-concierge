import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Scheduled tutorial re-sync + backfill.
 *
 * Re-fetches the CLWRota rota feed for the trailing `days` window (default 30,
 * plus `ahead` days forward, default 30) and re-applies the current
 * tutorial-detection rules to the saved rows. Safe to run daily on cron, or to
 * trigger from a CLWRota feed-change webhook.
 *
 * Auth: `x-webhook-secret: $CLWROTA_WEBHOOK_SECRET`.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoOffsetDays(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export const Route = createFileRoute("/api/public/hooks/tutorial-backfill")({
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
        const from = params.get("from");
        const to = params.get("to");
        if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
          return new Response(
            JSON.stringify({ ok: false, error: "from/to must be YYYY-MM-DD." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const days = Math.min(
          365,
          Math.max(1, Number(params.get("days")) || 14),
        );
        const ahead = Math.min(
          365,
          Math.max(0, Number(params.get("ahead")) || 14),
        );
        const startIso = from ?? isoOffsetDays(-days);
        const endIso = to ?? isoOffsetDays(ahead);
        const dryRun = params.get("dryRun") === "true";

        if (startIso > endIso) {
          return new Response(
            JSON.stringify({ ok: false, error: "from must be before to." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
          const { runTutorialBackfill } = await import(
            "@/features/clwrota/tutorial-backfill.server"
          );
          // One upstream CLWRota download per invocation keeps the Worker
          // inside its memory budget; the detection re-scan still covers the
          // whole requested window from rows already in the database.
          const result = await runTutorialBackfill({
            startIso,
            endIso,
            dryRun,
            maxSlices: 1,
          });
          return new Response(JSON.stringify({ ok: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error("tutorial-backfill hook failed:", message);
          return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
