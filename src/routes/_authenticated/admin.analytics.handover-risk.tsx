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
import { ArrowRightLeft } from "lucide-react";
import { computeHandoverRisk } from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/handover-risk",
)({
  head: () => ({
    meta: [
      { title: "Handover-adjacency risk — HR analytics" },
      { name: "description", content: "Consultants running consecutive high-acuity sessions on the same day." },
    ],
  }),
  component: HandoverRiskPage,
});

function HandoverRiskPage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-handover"],
    queryFn: async () => {
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 84); // 12 weeks
      const sinceIso = since.toISOString().slice(0, 10);
      const [rotaRes, tsRes, specRes, profRes] = await Promise.all([
        supabase.from("rota_assignments")
          .select("staff_id,session_date,session,theatre_session_id")
          .gte("session_date", sinceIso)
          .range(0, 49999),
        supabase.from("theatre_sessions").select("id,specialty_id").range(0, 49999),
        supabase.from("specialties").select("id,name"),
        supabase.from("profiles").select("id,full_name,grade,active")
          .eq("grade", "consultant").eq("active", true),
      ]);
      if (rotaRes.error) throw rotaRes.error;
      if (tsRes.error) throw tsRes.error;
      if (specRes.error) throw specRes.error;
      if (profRes.error) throw profRes.error;
      const tsById = new Map<string, string | null>();
      for (const t of tsRes.data ?? []) tsById.set(t.id, t.specialty_id);
      const specById = new Map<string, string>();
      for (const s of specRes.data ?? []) specById.set(s.id, s.name);
      const consultantIds = new Set((profRes.data ?? []).map((p) => p.id));
      const rows = (rotaRes.data ?? [])
        .filter((r) => r.staff_id && consultantIds.has(r.staff_id))
        .map((r) => ({
          staff_id: r.staff_id as string,
          session_date: r.session_date,
          session: r.session,
          specialty_name: r.theatre_session_id
            ? specById.get(tsById.get(r.theatre_session_id) ?? "") ?? null
            : null,
        }));
      return { rows, profiles: profRes.data ?? [] };
    },
  });

  const view = useMemo(() => {
    if (!data) return [];
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));
    return computeHandoverRisk(data.rows)
      .map((r) => ({ ...r, name: nameById.get(r.staff_id) ?? "Unknown" }));
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Handover-adjacency risk"
        description="Consecutive same-day sessions where both are high-acuity (obstetrics, ICU, CEPOD, trauma, cardiac, vascular, emergency). Rolling 12 weeks."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Consultants with events" value={view.length} icon={ArrowRightLeft} />
        <StatCard label="Total events"
          value={view.reduce((a, r) => a + r.events, 0)} icon={ArrowRightLeft} />
        <StatCard label="Max events per consultant"
          value={view.length ? view[0].events : 0} icon={ArrowRightLeft} />
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Consultant</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead>Recent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={r.events >= 3 ? "destructive" : "secondary"}>{r.events}</Badge>
                  </TableCell>
                  <TableCell className="text-xs space-x-1">
                    {r.sessions.slice(-5).map((s, i) => (
                      <Badge key={i} variant="outline">
                        {s.date} · {s.from} → {s.to}
                      </Badge>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
              {view.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    No back-to-back high-acuity events in the window.
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
