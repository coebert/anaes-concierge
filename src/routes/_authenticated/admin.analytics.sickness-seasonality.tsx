import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Thermometer } from "lucide-react";
import { computeSicknessSeasonality } from "@/features/analytics/analyses";

export const Route = createFileRoute(
  "/_authenticated/admin/analytics/sickness-seasonality",
)({
  head: () => ({
    meta: [
      { title: "Sickness seasonality — HR analytics" },
      { name: "description", content: "Monthly absence-day counts with Pearson correlation vs rota density." },
    ],
  }),
  component: SicknessSeasonalityPage,
});

function SicknessSeasonalityPage() {
  const { hasRole, loading } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-sickness-seasonality"],
    queryFn: async () => {
      const since = new Date();
      since.setUTCFullYear(since.getUTCFullYear() - 2);
      const sinceIso = since.toISOString().slice(0, 10);
      const [sickRes, rotaRes] = await Promise.all([
        supabase.from("leave_requests")
          .select("start_date,end_date")
          .eq("type", "sick").eq("status", "approved")
          .gte("start_date", sinceIso)
          .range(0, 19999),
        supabase.from("rota_assignments").select("session_date")
          .gte("session_date", sinceIso)
          .range(0, 49999),
      ]);
      if (sickRes.error) throw sickRes.error;
      if (rotaRes.error) throw rotaRes.error;
      return {
        sickRows: sickRes.data ?? [],
        rotaRows: rotaRes.data ?? [],
      };
    },
  });

  const view = useMemo(() => data ? computeSicknessSeasonality(data) : null, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  if (isLoading || !view) return <PageLoading />;

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const maxAbs = Math.max(1, ...view.cells.map((c) => c.absenceDays));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sickness seasonality"
        description="Absence days approved as sick leave grouped by month, over the last 2 years. Pearson r is between monthly absence-days and monthly rota session count."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Months covered" value={view.cells.length} icon={Thermometer} />
        <StatCard label="Total absence-days"
          value={view.cells.reduce((a, c) => a + c.absenceDays, 0)} icon={Thermometer} />
        <StatCard label="Pearson r vs rota density"
          value={view.pearson == null ? "—" : view.pearson.toFixed(2)} icon={Thermometer} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Monthly heatmap</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1">
            {view.cells.map((c) => {
              const intensity = c.absenceDays / maxAbs;
              return (
                <div key={c.month}
                  title={`${c.month}: ${c.absenceDays} absence-days, ${c.rotaSessions} sessions`}
                  className="w-14 h-10 rounded flex flex-col items-center justify-center text-[10px]"
                  style={{ background: `hsl(0 70% ${100 - intensity * 55}%)` }}>
                  <span className="font-medium">{c.month.slice(5)}</span>
                  <span>{c.absenceDays}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">By month of year (aggregated)</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-end gap-2 h-32">
            {view.byMonthOfYear.map((m) => {
              const max = Math.max(1, ...view.byMonthOfYear.map((x) => x.days));
              return (
                <div key={m.mm} className="flex flex-1 flex-col items-center gap-1">
                  <div className="w-full bg-primary/70 rounded-sm"
                    style={{ height: `${(m.days / max) * 100}%` }} />
                  <span className="text-[10px] text-muted-foreground">
                    {monthNames[parseInt(m.mm, 10) - 1]}
                  </span>
                  <span className="text-[10px]">{m.days}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
