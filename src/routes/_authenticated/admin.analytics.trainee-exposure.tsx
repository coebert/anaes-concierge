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
import { GraduationCap } from "lucide-react";
import { computeTraineeExposure } from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/trainee-exposure",
)({
  head: () => ({
    meta: [
      { title: "Trainee educational exposure — HR analytics" },
      { name: "description", content: "Sessions delivered vs curriculum target per trainee." },
    ],
  }),
  component: TraineeExposurePage,
});

function TraineeExposurePage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-trainee-exposure"],
    queryFn: async () => {
      const yearAgo = new Date();
      yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
      const [profRes, rotaRes, tsRes, specRes, targetRes] = await Promise.all([
        supabase.from("profiles")
          .select("id,full_name,training_level,active,grade")
          .eq("grade", "trainee").eq("active", true),
        supabase.from("rota_assignments")
          .select("staff_id,theatre_session_id")
          .gte("session_date", yearAgo.toISOString().slice(0, 10))
          .range(0, 49999),
        supabase.from("theatre_sessions").select("id,specialty_id").range(0, 49999),
        supabase.from("specialties").select("id,name"),
        supabase.from("trainee_targets")
          .select("training_level,specialty_id,required_sessions"),
      ]);
      if (profRes.error) throw profRes.error;
      if (rotaRes.error) throw rotaRes.error;
      if (tsRes.error) throw tsRes.error;
      if (specRes.error) throw specRes.error;
      if (targetRes.error) throw targetRes.error;
      const tsById = new Map<string, string | null>();
      for (const t of tsRes.data ?? []) tsById.set(t.id, t.specialty_id);
      const specById = new Map<string, string>();
      for (const s of specRes.data ?? []) specById.set(s.id, s.name);
      return {
        trainees: profRes.data ?? [],
        assignments: (rotaRes.data ?? []).map((a) => ({
          staff_id: a.staff_id!,
          specialty_id: a.theatre_session_id ? tsById.get(a.theatre_session_id) ?? null : null,
        })),
        targets: targetRes.data ?? [],
        specById,
      };
    },
  });

  const view = useMemo(() => {
    if (!data) return [];
    const nameById = new Map(data.trainees.map((t) => [t.id, t.full_name || "Unknown"]));
    return computeTraineeExposure({
      trainees: data.trainees.map((t) => ({ id: t.id, training_level: t.training_level })),
      assignments: data.assignments,
      targets: data.targets,
    }).map((r) => ({ ...r, name: nameById.get(r.staff_id) ?? "Unknown" }));
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading) return <PageLoading />;

  const totalRed = view.reduce((a, r) => a + r.underexposedCount, 0);
  const specById = data?.specById ?? new Map<string, string>();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trainee educational exposure"
        description="Delivered sessions vs trainee_targets over the last 12 months. Red = <70% of target — surface at ARCP prep. Green ≥ 100%, amber 70–99%."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Trainees" value={view.length} icon={GraduationCap} />
        <StatCard label="Under-exposure alerts" value={totalRed} icon={GraduationCap} />
        <StatCard label="Trainees with any red flag"
          value={view.filter((r) => r.underexposedCount > 0).length} icon={GraduationCap} />
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trainee</TableHead>
                <TableHead>Level</TableHead>
                <TableHead className="text-right">Red flags</TableHead>
                <TableHead>Weakest specialty gaps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell><Badge variant="outline">{r.training_level ?? "—"}</Badge></TableCell>
                  <TableCell className="text-right">
                    {r.underexposedCount > 0 ? (
                      <Badge variant="destructive">{r.underexposedCount}</Badge>
                    ) : (
                      <Badge variant="outline">0</Badge>
                    )}
                  </TableCell>
                  <TableCell className="space-x-1">
                    {r.bySpecialty
                      .filter((s) => s.band === "red" || s.band === "amber")
                      .slice(0, 6)
                      .map((s) => (
                        <Badge
                          key={s.specialty_id}
                          variant={s.band === "red" ? "destructive" : "secondary"}
                        >
                          {specById.get(s.specialty_id) ?? s.specialty_id.slice(0, 4)}: {s.delivered}/{s.required}
                        </Badge>
                      ))}
                    {r.bySpecialty.filter((s) => s.band === "red" || s.band === "amber").length === 0 && (
                      <span className="text-muted-foreground text-xs">On target</span>
                    )}
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
