import { createFileRoute } from "@tanstack/react-router";
import { ClwRotaStatusPage } from "./-clwrota-status-page";

export const Route = createFileRoute("/_authenticated/admin/clwrota-status")({
  head: () => ({
    meta: [
      { title: "CLWRota sync status — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "Admin status page showing the last successful CLWRota rota sync, the most recent outcome per step, and recent pg_cron run history.",
      },
    ],
  }),
  component: ClwRotaStatusPage,
  errorComponent: ({ error }) => (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-destructive">
        Could not load CLWRota sync status
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Page not found.</div>,
});
