import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, ShieldAlert } from "lucide-react";
import { PageLoading } from "@/components/loading";
import { StatCard } from "@/components/stat-card";
import { ExceptionSubmitDialog } from "@/components/exceptions/ExceptionSubmitDialog";
import { ExceptionCard } from "@/components/exceptions/ExceptionCard";
import type { ExceptionReport } from "@/features/exceptions/types";

export const Route = createFileRoute("/_authenticated/exceptions")({
  head: () => ({
    meta: [
      { title: "Exception reports — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Log and track variances from your rostered work schedule under the 2016 Junior Doctor TCS.",
      },
    ],
  }),
  component: MyExceptionsPage,
});

function MyExceptionsPage() {
  const { user, loading } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    enabled: !!user,
    queryKey: ["exceptions", "mine", user?.id],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("exception_reports")
        .select("*")
        .eq("trainee_id", user!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const reports = (rows ?? []) as ExceptionReport[];
      const responderIds = Array.from(
        new Set(reports.map((r) => r.responder_id).filter(Boolean) as string[]),
      );
      const responderById = new Map<string, string>();
      if (responderIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", responderIds);
        for (const p of profs ?? []) responderById.set(p.id, p.full_name);
      }
      return { reports, responderById };
    },
  });

  if (loading || isLoading) return <PageLoading />;

  const reports = data?.reports ?? [];
  const open = reports.filter((r) => !["resolved", "withdrawn"].includes(r.status));
  const resolved = reports.filter((r) => r.status === "resolved");
  const overdue = open.filter((r) => new Date(r.due_by).getTime() < Date.now()).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My exception reports"
        description="Raise a variance from your work schedule under the 2016 TCS. Your educational supervisor responds within 7 days; immediate patient-safety concerns are same-day."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            New exception
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Open" value={open.length} />
        <StatCard label="Resolved (all time)" value={resolved.length} />
        <StatCard
          icon={ShieldAlert}
          tone={overdue > 0 ? "destructive" : "default"}
          label="Overdue response"
          value={overdue}
        />
      </div>

      {reports.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            You haven't raised any exception reports yet. Use the button above
            when your working day varies materially from your rostered schedule.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => (
            <ExceptionCard
              key={r.id}
              report={r}
              responderName={r.responder_id ? data?.responderById.get(r.responder_id) : null}
              canRespond={false}
              onChange={() => refetch()}
            />
          ))}
        </div>
      )}

      <ExceptionSubmitDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmitted={() => refetch()}
      />
    </div>
  );
}
