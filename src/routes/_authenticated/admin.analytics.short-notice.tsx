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
import { Clock } from "lucide-react";
import { computeShortNotice, type ShortNoticeRow } from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/short-notice",
)({
  head: () => ({
    meta: [
      { title: "Short-notice changes league — HR analytics" },
      { name: "description", content: "Who is disproportionately absorbing rota changes made within 48 hours of a session." },
    ],
  }),
  component: ShortNoticePage,
});

function ShortNoticePage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-short-notice"],
    queryFn: async () => {
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 1);
      const [changeRes, profRes] = await Promise.all([
        supabase
          .from("rota_change_log")
          .select("staff_id,action,hours_before_session,changed_at")
          .gte("changed_at", since.toISOString())
          .lte("hours_before_session", 48)
          .range(0, 49999),
        supabase.from("profiles").select("id,full_name,grade,active").eq("active", true),
      ]);
      if (changeRes.error) throw changeRes.error;
      if (profRes.error) throw profRes.error;
      return {
        rows: (changeRes.data ?? []) as ShortNoticeRow[],
        profiles: profRes.data ?? [],
      };
    },
  });

  const view = useMemo(() => {
    if (!data) return [];
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));
    const gradeById = new Map(data.profiles.map((p) => [p.id, p.grade]));
    return computeShortNotice(data.rows)
      .filter((r) => nameById.has(r.staff_id))
      .map((r) => ({
        ...r,
        name: nameById.get(r.staff_id)!,
        grade: gradeById.get(r.staff_id) ?? null,
      }));
  }, [data]);

  const p90 = view.length ? sortNums(view.map((r) => r.totalShortNotice))[Math.floor(view.length * 0.9)] : 0;

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Short-notice changes league"
        description="Rota changes affecting a doctor's assignment within 48 hours of the session, last 12 months. Top-decile threshold highlights doctors absorbing a disproportionate share."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Doctors affected" value={view.length} icon={Clock} />
        <StatCard label="Total short-notice events"
          value={view.reduce((a, r) => a + r.totalShortNotice, 0)} icon={Clock} />
        <StatCard label="Top-decile threshold" value={p90 ?? 0} icon={Clock} />
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Doctor</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead className="text-right">Total ≤48h</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="text-right">Removed</TableHead>
                <TableHead className="text-right">Median hours notice</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.map((r) => (
                <TableRow key={r.staff_id}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell><Badge variant="outline">{r.grade ?? "—"}</Badge></TableCell>
                  <TableCell className="text-right font-medium">{r.totalShortNotice}</TableCell>
                  <TableCell className="text-right">{r.added}</TableCell>
                  <TableCell className="text-right">{r.removed}</TableCell>
                  <TableCell className="text-right">
                    {r.medianHoursBefore != null ? r.medianHoursBefore.toFixed(1) : "—"}
                  </TableCell>
                  <TableCell>
                    {r.totalShortNotice >= p90 && p90 > 0 && (
                      <Badge variant="destructive">Top decile</Badge>
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

function sortNums(xs: number[]): number[] { return [...xs].sort((a, b) => a - b); }
