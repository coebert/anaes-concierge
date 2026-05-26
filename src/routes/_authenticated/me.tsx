import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { StaffWeekView } from "@/components/rota-views";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/me")({
  component: MyRotaPage,
});

function MyRotaPage() {
  const { user } = useAuth();
  if (!user) {
    return (
      <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent></Card>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">My rota</h1>
      <StaffWeekView staffId={user.id} />
    </div>
  );
}
