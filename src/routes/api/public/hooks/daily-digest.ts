import { createFileRoute } from "@tanstack/react-router";
import { verifyWebhookRequest, unauthorizedResponse } from "@/lib/webhook-auth";

/**
 * Morning rota digest push (06:30 Europe/London).
 *
 * Scheduled twice in UTC (05:30 and 06:30) so it lands at 06:30 local time in
 * both BST and GMT; the handler only runs during the 06:00–06:59 London hour
 * and a per-person/day log stops duplicates.
 *
 * Auth: `x-webhook-secret: $PUSH_WEBHOOK_SECRET`.
 */
export const Route = createFileRoute("/api/public/hooks/daily-digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyWebhookRequest(request, "PUSH_WEBHOOK_SECRET")) {
          return unauthorizedResponse();
        }

        const params = new URL(request.url).searchParams;
        const force = params.get("force") === "1";
        const date = params.get("date") ?? undefined;

        try {
          const { dispatchDailyDigests, londonHour } = await import("@/lib/daily-digest.server");
          if (!force && londonHour() !== 6) {
            return Response.json({ ok: true, status: "skipped", reason: "not 06:00 London" });
          }
          const result = await dispatchDailyDigests({ date, force });
          return Response.json({ ok: true, status: "ran", ...result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("daily-digest failed:", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
