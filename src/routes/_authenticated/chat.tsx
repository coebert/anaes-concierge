import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/_authenticated/chat")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">AI assistant</h1>
      <p className="text-sm text-muted-foreground">Ask about your rota, leave, or trainee progress.</p>
    </div>
  ),
});
