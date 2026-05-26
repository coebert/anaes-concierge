import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/me")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">My rota</h1>
      <p className="text-sm text-muted-foreground">Your sessions, leave balance and job plan summary will appear here.</p>
    </div>
  ),
});
