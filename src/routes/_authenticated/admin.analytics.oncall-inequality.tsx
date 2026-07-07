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
import { Users } from "lucide-react";
import { computeOnCallInequality } from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/oncall-inequality",
)({
  head: () => ({
    meta: [
      { title: "On-call frequency inequality — HR analytics" },
      { name: "description", content: "Consultant on-calls per WTE, banded by LTFT fraction, with outlier flags." },
    ],
  }),
  component: OnCallInequalityPage,
});

const ONCALL_DUTY = [
  "icu_consultant_oncall",
  "general_consultant_oncall",
  "nhh_oncall",
] as const;

function OnCallInequalityPage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-oncall"],
    queryFn: async () => {
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 1);
      const [profRes, rotaRes] = await Promise.all([
        supabase.from("profiles")
          .select("id,full_name,ltft_days_off,grade,active")
          .eq("grade", "consultant").eq("active", true),
        supabase.from("rota_assignments")
          .select("staff_id,duty_type,role_on_list")
          .gte("session_date", since.toISOString().slice(0, 10))
          .range(0, 49999),
      ]);
      if (profRes.error) throw profRes.error;
      if (rotaRes.error) throw rotaRes.error;
      const onCallRows = (rotaRes.data ?? []).filter(
        (r) =>
          r.staff_id &&
          (r.role_on_list === "on_call" ||
            (r.duty_type && (ONCALL_DUTY as readonly string[]).includes(r.duty_type))),
      ).map((r) => ({ staff_id: r.staff_id as string }));
      return { profiles: profRes.data ?? [], onCallRows };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const result = computeOnCallInequality({
      consultants: data.profiles.map((p) => ({ id: p.id, ltft_days_off: p.ltft_days_off })),
      onCallRows: data.onCallRows,
    });
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));
    return {
      ...result,
      rows: result.rows.map((r) => ({ ...r, name: nameById.get(r.staff_id) ?? "Unknown" })),
    };
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading || !view) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="On-call frequency inequality"
        description="Consultants only, rolling 12 months. Per WTE = on-calls ÷ LTFT fraction. Outliers exceed 1.5× their LTFT band's median."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Consultants" value={view.rows.length} icon={Users} />
        <StatCard label="Overall on-call Gini" value={view.giniOverall.toFixed(2)} icon={Users} />
        <StatCard label="Outliers" value={view.rows.filter((r) => r.outlier).length} icon={Users} />
        <StatCard label="Total on-calls"
          value={view.rows.reduce((a, r) => a + r.onCallCount, 0)} icon={Users} />
      </div>
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(view.byBand).map(([band, v]) => (
              <Badge key={band} variant="outline">
                {band}: median {v.median.toFixed(1)}/WTE · n={v.count}
              </Badge>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Consultant</TableHead>
                <TableHead>LTFT fraction</TableHead>
                <TableHead>Band</TableHead>
                <TableHead className="text-right">On-calls</TableHead>
                <TableHead className="text-right">Per WTE</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell>{r.ltftFraction.toFixed(2)}</TableCell>
                  <TableCell><Badge variant="outline">{r.band}</Badge></TableCell>
                  <TableCell className="text-right">{r.onCallCount}</TableCell>
                  <TableCell className="text-right">{r.onCallPerWTE.toFixed(1)}</TableCell>
                  <TableCell>
                    {r.outlier && <Badge variant="destructive">Outlier</Badge>}
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
