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
  MIN_ASSESSABLE_SESSIONS,
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
import { selectAdminSignalInputs } from "@/features/wellbeing/admin-inputs";
import { computeBradfordFactor } from "@/lib/bradford-factor";
import { fetchAllPaged, createQueryBudget, reportQueryBudget } from "@/lib/supabase-chunked";
import { WellbeingMetricGuide } from "@/components/wellbeing/MetricsGuide";

export const Route = createFileRoute("/_authenticated/admin/wellbeing")({
  head: () => ({
    meta: [
      { title: "Wellbeing & retention — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Per-doctor wellbeing score and an unvalidated retention signal score derived from rota load, leave and sickness records — a support prompt, not a prediction.",
      },
    ],
  }),
  component: AdminWellbeingPage,
});

export function AdminWellbeingPage() {
  const { hasRole, loading } = useAuth();
  const [q, setQ] = useState("");

  const { data, isLoading, isFetching, isError, error } = useQuery({
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
      const [profiles, assignments, changes, leave, exceptionsRaw, rtws] = await Promise.all([
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
        fetchAllPaged<{
          staff_id: string | null;
          session_date: string;
          hours_before_session: number | null;
        }>(
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
    return (
      data.profiles
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
            now,
            assignments: data.assignments,
            changes: data.changes,
            leave: staffLeave,
            exceptions: data.exceptions,
            bradfordScore: bradford.score,
          });

          const signals = selectAdminSignalInputs({
            staffId: p.id,
            asOf: now,
            leave: staffLeave,
            changes: data.changes,
            rtws: data.rtws,
          });

          const attrition = computeAttritionRisk({
            wellbeing,
            bradfordScore: bradford.score,
            denialRate12m: signals.denialRate12m,
            shortNoticeChanges12m: signals.shortNoticeChanges12m,
            daysSinceLastAnnual: signals.daysSinceLastAnnual,
            overdueRtwCount: signals.overdueRtwCount,
            pulseTrend: signals.pulseTrend,
          });

          return {
            id: p.id,
            name: p.full_name || p.email || "Unknown",
            grade: p.grade,
            wellbeing,
            attrition,
          };
        })
        // Unknown-coverage rows sort first so missing data is reviewed, not hidden.
        .sort(
          (a, b) =>
            Number(a.wellbeing.scoreKnown) - Number(b.wellbeing.scoreKnown) ||
            a.wellbeing.score - b.wellbeing.score,
        )
    );
  }, [data]);

  const filteredRows = rows.filter((r) =>
    q ? r.name.toLowerCase().includes(q.toLowerCase()) : true,
  );

  const atRiskCount = rows.filter(
    (r) => r.wellbeing.band === "at_risk" || r.wellbeing.band === "strained",
  ).length;
  const notAssessedCount = rows.filter((r) => !r.wellbeing.scoreKnown).length;
  const assessedCount = rows.length - notAssessedCount;
  const highAttrition = rows.filter(
    (r) => r.attrition.band === "high" || r.attrition.band === "elevated",
  ).length;

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  const refetching = isFetching && !isLoading;
  const errorMessage =
    isError && error instanceof Error
      ? error.message
      : isError
        ? "Failed to load wellbeing data."
        : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Wellbeing & retention"
        description="Rolling 90-day wellbeing score per active staff member, plus an unvalidated retention signal score (x/100) — a conversation prompt only, sorted with missing data first, then lowest wellbeing."
      />

      {errorMessage ? (
        <div
          data-testid="admin-wellbeing-error"
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Wellbeing update failed: {errorMessage}
        </div>
      ) : null}
      {refetching ? (
        <div
          data-testid="admin-wellbeing-refetching"
          role="status"
          aria-live="polite"
          className="rounded-md border border-muted bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          Refreshing wellbeing data…
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-5">
        <StatCard label="Staff listed" value={rows.length} icon={HeartPulse} />
        <StatCard
          label="Staff assessed"
          value={assessedCount}
          hint={`${MIN_ASSESSABLE_SESSIONS}+ sessions in 90 days`}
          icon={HeartPulse}
        />
        <StatCard label="Strained / at-risk" value={atRiskCount} icon={AlertTriangle} />
        <StatCard label="High / elevated signal score" value={highAttrition} icon={TrendingDown} />
        <StatCard label="Not enough data" value={notAssessedCount} icon={HeartPulse} />
      </div>
      <p className="text-xs text-muted-foreground" data-testid="admin-wellbeing-caveat">
        These are unvalidated operational signal scores, not predictions of who will leave. Use them
        only to prompt a supportive conversation — never for HR or performance decisions. The
        pulse-survey trend is not yet measured per person and is shown as not assessed. Scores are
        based only on the records available in the app. The {MIN_ASSESSABLE_SESSIONS}-session minimum
        is a conservative display threshold, not a validated measure of data sufficiency: a person with
        just over {MIN_ASSESSABLE_SESSIONS} sparse sessions is shown with a score, but that does not
        mean their full 90 days are covered.
      </p>

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
                  <TableHead>Retention signal</TableHead>
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

      <WellbeingMetricGuide showAttrition />
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
      <TableCell className="text-xs capitalize text-muted-foreground">{row.grade ?? "—"}</TableCell>
      <TableCell className="text-right tabular-nums">
        {row.wellbeing.scoreKnown ? row.wellbeing.score : "—"}
      </TableCell>
      <TableCell>
        <Badge className={WELLBEING_BAND_TONE[row.wellbeing.band]}>
          {WELLBEING_BAND_LABEL[row.wellbeing.band]}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge className={ATTRITION_BAND_TONE[row.attrition.band]}>
          {row.attrition.band === "not_assessed"
            ? ATTRITION_BAND_LABEL.not_assessed
            : `${ATTRITION_BAND_LABEL[row.attrition.band]} (${row.attrition.score}/100)`}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {row.attrition.topFactors.map((f) => f.label).join(" · ")}
        {row.attrition.notAssessed.length > 0
          ? ` · Not assessed: ${row.attrition.notAssessed.join(", ")}`
          : ""}
      </TableCell>
    </TableRow>
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
