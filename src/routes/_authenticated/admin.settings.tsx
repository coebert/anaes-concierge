import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/admin/settings")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-sm text-muted-foreground">
        CLWRota sync, curriculum targets, and email setup will live here.
      </p>
    </div>
  ),
});
