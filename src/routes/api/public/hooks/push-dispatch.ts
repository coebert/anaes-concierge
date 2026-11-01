import { createFileRoute } from "@tanstack/react-router";
import { verifyWebhookRequest, unauthorizedResponse } from "@/lib/webhook-auth";

// Called by pg_cron every minute. Auth: shared webhook secret header.
// Dispatches web push notifications for recent rota_change_log rows.
export const Route = createFileRoute("/api/public/hooks/push-dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!verifyWebhookRequest(request, "PUSH_WEBHOOK_SECRET")) {
          return unauthorizedResponse();
        }
        try {
          const { dispatchPendingPushNotifications, dispatchPendingLeavePushNotifications } =
            await import("@/lib/push-dispatch.server");
          const [rota, leave] = await Promise.all([
            dispatchPendingPushNotifications(),
            dispatchPendingLeavePushNotifications(),
          ]);
          return Response.json({ ok: true, rota, leave });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("push-dispatch failed:", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
