import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageLoading } from "@/components/loading";
import { HeartPulse, AlertTriangle, TrendingDown } from "lucide-react";
import {
  computeWellbeing,
  WELLBEING_BAND_LABEL,
  WELLBEING_BAND_TONE,
  type WellbeingResult,
} from "@/features/wellbeing/wellbeing-score";
import {
  computeAttritionRisk,
  ATTRITION_BAND_LABEL,
  ATTRITION_BAND_TONE,
  type AttritionResult,
} from "@/lib/attrition-risk";
import { computeBradfordFactor } from "@/lib/bradford-factor";
import { fetchAllPaged, createQueryBudget, reportQueryBudget } from "@/lib/supabase-chunked";

export const Route = createFileRoute("/_authenticated/admin/wellbeing")({
  head: () => ({
    meta: [
      { title: "Wellbeing & retention — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Per-doctor wellbeing score and attrition-risk rubric derived from rota load, leave, sickness and pulse-survey signals.",
      },
    ],
  }),
  component: AdminWellbeingPage,
});

export function AdminWellbeingPage() {
  const { hasRole, loading } = useAuth();
  const [q, setQ] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-wellbeing"],
    refetchOnWindowFocus: true,
    refetchInterval: 10 * 60_000,
    queryFn: async () => {
      const yearAgo = isoDaysAgo(365);
      // Wellbeing/attrition drives sit on top of a handful of wide reads.
      // We budget the total page requests so a future regression (e.g. an
      // accidental per-staff N+1) is logged and — in dev — throws.
      // Budget math: 6 sources × up to 10 pages each ≈ 60 requests worst-case
      // on the current dataset. If real usage grows, bump this deliberately.
      const budget = createQueryBudget("admin-wellbeing", 60);
      const [profiles, assignments, changes, leave, exceptionsRaw, rtws] =
        await Promise.all([
          fetchAllPaged<{
            id: string;
            full_name: string | null;
            email: string | null;
            grade: string | null;
            active: boolean | null;
          }>(
            () =>
              supabase
                .from("profiles")
                .select("id,full_name,email,grade,active")
                .eq("active", true)
                .order("id", { ascending: true }),
            { budget, source: "profiles" },
          ),
          // Paginate — a single wide .range() is capped at db-max-rows (1000
          // on hosted Supabase), so unordered wide reads silently drop rows.
          fetchAllPaged<{ staff_id: string; session_date: string; session: string }>(
            () =>
              supabase
                .from("rota_assignments")
                .select("staff_id,session_date,session")
                .gte("session_date", yearAgo)
                .order("session_date", { ascending: true }),
            { budget, source: "rota_assignments" },
          ),
          fetchAllPaged<{ staff_id: string | null; session_date: string; hours_before_session: number | null }>(
            () =>
              supabase
                .from("rota_change_log")
                .select("staff_id,session_date,hours_before_session")
                .gte("session_date", yearAgo)
                .order("session_date", { ascending: true }),
            { budget, source: "rota_change_log" },
          ),
          fetchAllPaged<{
            id: string;
            staff_id: string;
            type: string;
            status: string;
            start_date: string;
            end_date: string;
            half_day_start: string | null;
            half_day_end: string | null;
            created_at: string;
            decided_at: string | null;
          }>(
            () =>
              supabase
                .from("leave_requests")
                .select(
                  "id,staff_id,type,status,start_date,end_date,half_day_start,half_day_end,created_at,decided_at",
                )
                .order("end_date", { ascending: false }),
            { budget, source: "leave_requests" },
          ),
          fetchAllPaged<{ trainee_id: string; event_date: string; status: string }>(
            () =>
              supabase
                .from("exception_reports")
                .select("trainee_id,event_date,status")
                .gte("event_date", yearAgo)
                .neq("status", "withdrawn")
                .order("event_date", { ascending: false }),
            { budget, source: "exception_reports" },
          ),
          fetchAllPaged<{ leave_request_id: string; conducted_at: string | null }>(
            () =>
              supabase
                .from("return_to_work_interviews")
                .select("leave_request_id,conducted_at")
                .order("conducted_at", { ascending: false, nullsFirst: false }),
            { budget, source: "return_to_work_interviews" },
          ),
        ]);
      reportQueryBudget(budget);
      return {
        profiles,
        assignments,
        changes,
        leave,
        exceptions: exceptionsRaw.map((e) => ({
          staff_id: e.trainee_id,
          event_date: e.event_date,
        })),
        rtws,
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const now = new Date();
    const oneYearMs = 365 * 86_400_000;
    return data.profiles
      .map((p) => {
        const staffLeave = data.leave.filter((l) => l.staff_id === p.id);
        const sickSpells = staffLeave
          .filter((l) => l.type === "sick" && l.status === "approved")
          .map((s) => ({
            start_date: s.start_date,
            end_date: s.end_date,
            half_day_start: !!s.half_day_start,
            half_day_end: !!s.half_day_end,
          }));
        const bradford = computeBradfordFactor(sickSpells);
        const wellbeing = computeWellbeing({
          staffId: p.id,
          assignments: data.assignments,
          changes: data.changes,
          leave: staffLeave,
          exceptions: data.exceptions,
          bradfordScore: bradford.score,
        });

        // Attrition inputs
        const totalDecisions = staffLeave.filter(
          (l) => l.status === "approved" || l.status === "rejected",
        ).length;
        const denials = staffLeave.filter((l) => l.status === "rejected").length;
        const denialRate = totalDecisions > 0 ? denials / totalDecisions : 0;
        const shortNotice12m = data.changes.filter(
          (c) =>
            c.staff_id === p.id &&
            c.hours_before_session !== null &&
            c.hours_before_session <= 48 &&
            c.hours_before_session >= -48,
        ).length;
        const approvedAnnual = staffLeave
          .filter((l) => l.type === "annual" && l.status === "approved")
          .sort((a, b) => b.end_date.localeCompare(a.end_date));
        const daysSinceAnnual = approvedAnnual[0]
          ? Math.max(
              0,
              Math.floor(
                (now.getTime() - new Date(approvedAnnual[0].end_date).getTime()) /
                  86_400_000,
              ),
            )
          : null;
        const overdueRtw = staffLeave.filter((l) => {
          if (l.type !== "sick" || l.status !== "approved") return false;
          const end = new Date(l.end_date).getTime();
          if (Number.isNaN(end)) return false;
          if (now.getTime() - end < 3 * 86_400_000) return false;
          return !data.rtws.some((r) => r.leave_request_id === l.id);
        }).length;

        const attrition = computeAttritionRisk({
          wellbeing,
          bradfordScore: bradford.score,
          denialRate12m: denialRate,
          shortNoticeChanges12m: shortNotice12m,
          daysSinceLastAnnual: daysSinceAnnual,
          overdueRtwCount: overdueRtw,
          pulseTrend: null,
        });

        return {
          id: p.id,
          name: p.full_name || p.email || "Unknown",
          grade: p.grade,
          wellbeing,
          attrition,
        };
      })
      .sort((a, b) => a.wellbeing.score - b.wellbeing.score);
    void oneYearMs;
  }, [data]);

  const filteredRows = rows.filter((r) =>
    q ? r.name.toLowerCase().includes(q.toLowerCase()) : true,
  );

  const atRiskCount = rows.filter(
    (r) => r.wellbeing.band === "at_risk" || r.wellbeing.band === "strained",
  ).length;
  const highAttrition = rows.filter(
    (r) => r.attrition.band === "high" || r.attrition.band === "elevated",
  ).length;

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wellbeing & retention"
        description="Rolling 90-day wellbeing score per active staff member, plus a transparent attrition-risk rubric — sorted worst-first for triage."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Staff assessed" value={rows.length} icon={HeartPulse} />
        <StatCard label="Strained / at-risk" value={atRiskCount} icon={AlertTriangle} />
        <StatCard label="High / elevated attrition risk" value={highAttrition} icon={TrendingDown} />
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name…"
              className="max-w-xs"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              {filteredRows.length} of {rows.length} shown
            </div>
          </div>

          {isLoading ? (
            <PageLoading />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Wellbeing</TableHead>
                  <TableHead>Attrition</TableHead>
                  <TableHead>Top drivers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <RowView key={r.id} row={r} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RowView({
  row,
}: {
  row: {
    id: string;
    name: string;
    grade: string | null;
    wellbeing: WellbeingResult;
    attrition: AttritionResult;
  };
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{row.name}</TableCell>
      <TableCell className="text-xs capitalize text-muted-foreground">
        {row.grade ?? "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.wellbeing.score}</TableCell>
      <TableCell>
        <Badge className={WELLBEING_BAND_TONE[row.wellbeing.band]}>
          {WELLBEING_BAND_LABEL[row.wellbeing.band]}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge className={ATTRITION_BAND_TONE[row.attrition.band]}>
          {ATTRITION_BAND_LABEL[row.attrition.band]} ({Math.round(row.attrition.risk * 100)}%)
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.attrition.topFactors.map((f) => f.label).join(" · ")}
      </TableCell>
    </TableRow>
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
