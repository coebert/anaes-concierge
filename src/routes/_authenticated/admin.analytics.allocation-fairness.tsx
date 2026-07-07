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
import { Scale } from "lucide-react";
import {
  computeAllocationFairness,
  type AllocRotaRow,
} from "@/features/analytics/analyses";
import { gini } from "@/lib/analytics-gini";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/allocation-fairness",
)({
  head: () => ({
    meta: [
      { title: "Allocation fairness — HR analytics" },
      { name: "description", content: "Per-doctor Gini across list types, weekends and on-calls over 12 months." },
    ],
  }),
  component: AllocationFairnessPage,
});

function AllocationFairnessPage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-alloc"],
    queryFn: async () => {
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 1);
      const sinceIso = since.toISOString().slice(0, 10);
      const [profRes, rotaRes, tsRes, specRes] = await Promise.all([
        supabase.from("profiles").select("id,full_name,grade,active").eq("active", true),
        supabase
          .from("rota_assignments")
          .select("staff_id,session_date,duty_type,role_on_list,theatre_session_id")
          .gte("session_date", sinceIso)
          .range(0, 49999),
        supabase.from("theatre_sessions").select("id,specialty_id").range(0, 49999),
        supabase.from("specialties").select("id,name"),
      ]);
      if (profRes.error) throw profRes.error;
      if (rotaRes.error) throw rotaRes.error;
      if (tsRes.error) throw tsRes.error;
      if (specRes.error) throw specRes.error;
      const tsById = new Map<string, string | null>();
      for (const t of tsRes.data ?? []) tsById.set(t.id, t.specialty_id);
      const specById = new Map<string, string>();
      for (const s of specRes.data ?? []) specById.set(s.id, s.name);
      const rows: AllocRotaRow[] = (rotaRes.data ?? [])
        .filter((r) => r.staff_id)
        .map((r) => ({
          staff_id: r.staff_id as string,
          session_date: r.session_date,
          duty_type: r.duty_type,
          role_on_list: r.role_on_list,
          specialty_id: r.theatre_session_id
            ? tsById.get(r.theatre_session_id) ?? null
            : null,
        }));
      return { rows, profiles: profRes.data ?? [], specById };
    },
  });

  const view = useMemo(() => {
    if (!data) return { rows: [], overallGini: 0 };
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));
    const gradeById = new Map(data.profiles.map((p) => [p.id, p.grade]));
    const rows = computeAllocationFairness(data.rows)
      .filter((r) => nameById.has(r.staff_id))
      .map((r) => ({
        ...r,
        name: nameById.get(r.staff_id)!,
        grade: gradeById.get(r.staff_id) ?? null,
      }));
    return { rows, overallGini: gini(rows.map((r) => r.totalSessions)) };
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Allocation fairness"
        description="Rolling 12 months. Higher list-type Gini = more skewed exposure across specialties. Weekend and on-call shares are per-doctor totals."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Doctors with rota (12m)" value={view.rows.length} icon={Scale} />
        <StatCard label="Workload Gini" value={view.overallGini.toFixed(2)} icon={Scale} />
        <StatCard label="Median list-type Gini"
          value={median(view.rows.map((r) => r.listTypeGini)).toFixed(2)} icon={Scale} />
        <StatCard label="Total sessions"
          value={view.rows.reduce((a, r) => a + r.totalSessions, 0)} icon={Scale} />
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Doctor</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">List types</TableHead>
                <TableHead className="text-right">List-type Gini</TableHead>
                <TableHead className="text-right">Weekends</TableHead>
                <TableHead className="text-right">On-calls</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell><Badge variant="outline">{r.grade ?? "—"}</Badge></TableCell>
                  <TableCell className="text-right">{r.totalSessions}</TableCell>
                  <TableCell className="text-right">{r.listTypeCount}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={r.listTypeGini > 0.5 ? "destructive" : r.listTypeGini > 0.3 ? "secondary" : "outline"}>
                      {r.listTypeGini.toFixed(2)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {r.weekendCount} <span className="text-muted-foreground">({(r.weekendShare * 100).toFixed(0)}%)</span>
                  </TableCell>
                  <TableCell className="text-right">
                    {r.onCallCount} <span className="text-muted-foreground">({(r.onCallShare * 100).toFixed(0)}%)</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
