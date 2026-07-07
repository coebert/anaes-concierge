import { createFileRoute } from "@tanstack/react-router";

// Called by pg_cron every minute. Auth: shared webhook secret header.
// Dispatches web push notifications for recent rota_change_log rows.
export const Route = createFileRoute("/api/public/hooks/push-dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.PUSH_WEBHOOK_SECRET;
        if (!expected) {
          return new Response("PUSH_WEBHOOK_SECRET not configured", { status: 500 });
        }
        const provided = request.headers.get("x-webhook-secret");
        if (!provided || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          const { dispatchPendingPushNotifications } = await import("@/lib/push-dispatch.server");
          const summary = await dispatchPendingPushNotifications();
          return Response.json({ ok: true, ...summary });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("push-dispatch failed:", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
