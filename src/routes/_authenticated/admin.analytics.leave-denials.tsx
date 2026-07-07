import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { XCircle } from "lucide-react";
import { computeDenials } from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/leave-denials",
)({
  head: () => ({
    meta: [
      { title: "Leave denials — HR analytics" },
      { name: "description", content: "Denial-reason taxonomy inferred from decision notes, by month and grade." },
    ],
  }),
  component: DenialsPage,
});

function DenialsPage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-denials"],
    queryFn: async () => {
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 1);
      const [lrRes, profRes] = await Promise.all([
        supabase
          .from("leave_requests")
          .select("staff_id,status,decided_at,decision_notes")
          .gte("decided_at", since.toISOString())
          .eq("status", "rejected")
          .range(0, 19999),
        supabase.from("profiles").select("id,grade"),
      ]);
      if (lrRes.error) throw lrRes.error;
      if (profRes.error) throw profRes.error;
      const gradeById = new Map((profRes.data ?? []).map((p) => [p.id, p.grade]));
      return (lrRes.data ?? []).map((r) => ({
        status: r.status,
        decided_at: r.decided_at,
        decision_notes: r.decision_notes,
        grade: r.staff_id ? gradeById.get(r.staff_id) ?? null : null,
      }));
    },
  });

  const agg = useMemo(() => data ? computeDenials(data) : null, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading || !agg) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave denials — reason taxonomy"
        description="Rolling 12 months. Reasons are inferred from decision-notes keywords; edit rules in features/analytics/analyses.ts to refine."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total denials" value={agg.total} icon={XCircle} />
        <StatCard label="Reason categories" value={agg.byCategory.length} icon={XCircle} />
        <StatCard label="Months covered" value={agg.byMonth.length} icon={XCircle} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">By reason</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {agg.byCategory.map((c) => (
            <Badge key={c.category} variant="secondary" className="capitalize">
              {c.category}: {c.count}
            </Badge>
          ))}
          {agg.byCategory.length === 0 && (
            <span className="text-sm text-muted-foreground">No denials in window.</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">By month</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-end gap-1 h-24">
            {agg.byMonth.map((m) => {
              const max = Math.max(1, ...agg.byMonth.map((x) => x.count));
              const h = (m.count / max) * 100;
              return (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1 min-w-8">
                  <div className="w-full bg-primary/70 rounded-sm" style={{ height: `${h}%` }} />
                  <span className="text-[10px] text-muted-foreground rotate-45 origin-left">
                    {m.month}
                  </span>
                  <span className="text-[10px]">{m.count}</span>
                </div>
              );
            })}
            {agg.byMonth.length === 0 && (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">By grade × reason</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {agg.byGradeCategory.map((r) => (
            <Badge key={`${r.grade}-${r.category}`} variant="outline" className="capitalize">
              {r.grade} · {r.category}: {r.count}
            </Badge>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
