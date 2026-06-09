import { createFileRoute } from "@tanstack/react-router";
import { ClwRotaMetricsPage } from "./-clwrota-metrics-page";

export const Route = createFileRoute("/_authenticated/admin/clwrota-metrics")({
  head: () => ({
    meta: [
      { title: "CLWRota sync metrics — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "Admin dashboard charting CLWRota sync reliability: retries, fallbacks, succeeded, skipped, and failed rows over time.",
      },
    ],
  }),
  component: ClwRotaMetricsPage,
  errorComponent: ({ error }) => (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-destructive">
        Could not load CLWRota sync metrics
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Page not found.</div>,
});
