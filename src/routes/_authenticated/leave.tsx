import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/leave")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Leave</h1>
      <p className="text-sm text-muted-foreground">Submit and track annual, study and compassionate leave requests.</p>
    </div>
  ),
});
