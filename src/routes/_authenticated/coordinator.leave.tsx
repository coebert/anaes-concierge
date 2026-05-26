import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/coordinator/leave")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Approve leave</h1>
      <p className="text-sm text-muted-foreground">Pending requests with cover-impact analysis.</p>
    </div>
  ),
});
