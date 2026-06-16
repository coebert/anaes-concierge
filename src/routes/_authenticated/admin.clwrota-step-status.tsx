import { createFileRoute } from "@tanstack/react-router";
import { ClwRotaStepStatusPage } from "./-clwrota-step-status-page";

export const Route = createFileRoute("/_authenticated/admin/clwrota-step-status")({
  head: () => ({
    meta: [
      { title: "CLWRota step status — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "Per-step CLWRota sync status: last run time, success/failure, errors, and shared rate-limiter decisions for staff, rota, and leave.",
      },
    ],
  }),
  component: ClwRotaStepStatusPage,
  errorComponent: ({ error }) => (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-destructive">
        Could not load CLWRota step status
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Page not found.</div>,
});
