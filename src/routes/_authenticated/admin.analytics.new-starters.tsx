import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AlertTriangle } from "lucide-react";
import {
  computeNewStarterWarnings,
  type ShortNoticeRow,
} from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/new-starters",
)({
  head: () => ({
    meta: [
      { title: "New-starter early warning — HR analytics" },
      { name: "description", content: "First-90-days sickness, exception reports, and short-notice changes for new joiners." },
    ],
  }),
  component: NewStartersPage,
});

function NewStartersPage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-new-starters"],
    queryFn: async () => {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - 90);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      const [profRes, sickRes, exRes, changeRes] = await Promise.all([
        supabase.from("profiles")
          .select("id,full_name,grade,start_date,active,training_level")
          .gte("start_date", cutoffIso)
          .eq("active", true),
        supabase.from("leave_requests")
          .select("staff_id,start_date,end_date")
          .eq("type", "sick").eq("status", "approved")
          .gte("start_date", cutoffIso)
          .range(0, 9999),
        supabase.from("exception_reports")
          .select("trainee_id,created_at")
          .gte("created_at", cutoff.toISOString())
          .range(0, 9999),
        supabase.from("rota_change_log")
          .select("staff_id,action,hours_before_session,changed_at")
          .gte("changed_at", cutoff.toISOString())
          .lte("hours_before_session", 48)
          .range(0, 9999),
      ]);
      if (profRes.error) throw profRes.error;
      if (sickRes.error) throw sickRes.error;
      if (exRes.error) throw exRes.error;
      if (changeRes.error) throw changeRes.error;
      return {
        starters: (profRes.data ?? []).filter((p) => p.start_date),
        sickRows: (sickRes.data ?? []).map((s) => ({
          staff_id: s.staff_id as string,
          start_date: s.start_date,
          end_date: s.end_date,
        })),
        exceptionRows: (exRes.data ?? []).map((e) => ({
          trainee_id: e.trainee_id as string,
          created_at: e.created_at as string,
        })),
        shortNoticeRows: (changeRes.data ?? []) as ShortNoticeRow[],
      };
    },
  });

  const view = useMemo(() => {
    if (!data) return [];
    const nameById = new Map(data.starters.map((s) => [s.id, s.full_name || "Unknown"]));
    const gradeById = new Map(data.starters.map((s) => [s.id, s.grade]));
    return computeNewStarterWarnings({
      newStarters: data.starters.map((s) => ({ id: s.id, start_date: s.start_date! })),
      sickRows: data.sickRows,
      exceptionRows: data.exceptionRows,
      shortNoticeRows: data.shortNoticeRows,
      now: new Date(),
    }).map((r) => ({
      ...r,
      name: nameById.get(r.staff_id) ?? "Unknown",
      grade: gradeById.get(r.staff_id) ?? null,
    }));
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="New-starter early warning"
        description="Doctors whose start_date is within the last 90 days. Composite score weights sickness (×3), exception reports (×4) and short-notice changes (×1, capped)."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="New starters (90d)" value={view.length} icon={AlertTriangle} />
        <StatCard label="With any signal"
          value={view.filter((r) => r.score > 0).length} icon={AlertTriangle} />
        <StatCard label="Highest score"
          value={view.length ? view[0].score : 0} icon={AlertTriangle} />
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Doctor</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Days in</TableHead>
                <TableHead className="text-right">Sickness</TableHead>
                <TableHead className="text-right">Exceptions</TableHead>
                <TableHead className="text-right">Short-notice</TableHead>
                <TableHead className="text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell><Badge variant="outline">{r.grade ?? "—"}</Badge></TableCell>
                  <TableCell className="text-right">{r.daysSinceStart}</TableCell>
                  <TableCell className="text-right">{r.sicknessDays}</TableCell>
                  <TableCell className="text-right">{r.exceptionReports}</TableCell>
                  <TableCell className="text-right">{r.shortNoticeReceived}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={r.score >= 10 ? "destructive" : r.score >= 4 ? "secondary" : "outline"}>
                      {r.score}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {view.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    No new starters in the last 90 days.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
