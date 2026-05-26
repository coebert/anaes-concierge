import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/trainees")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">Trainees</h1>
      <p className="text-sm text-muted-foreground">Per-subspecialty progress against curriculum targets.</p>
    </div>
  ),
});
