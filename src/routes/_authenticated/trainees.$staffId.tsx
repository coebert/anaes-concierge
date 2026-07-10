import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaged } from "@/lib/supabase-chunked";
import { getTraineeProfileWithSupervisors } from "@/features/staff/staff-directory.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { computeProgress } from "@/lib/competency-utils";
import { computeFullAudit, isIcuBlockOnly, type AuditAssignment, type AuditTheatreSession, type AuditTarget } from "@/features/audit/trainee-audit";
import { IcuBlockBadge } from "@/components/trainees/IcuBlockBadge";
import { ArrowLeft, AlertTriangle, Sparkles, Users, FileWarning, HeartPulse, CheckCircle2 } from "lucide-react";
import { formatDateWithWeekdayGB, todayISO } from "@/lib/utils";
import { PageLoading } from "@/components/loading";
import { STATUS_LABEL, type ExceptionStatus } from "@/features/exceptions/types";
import {
  summariseAbsence,
  type RtwRow,
  type SickSpellRow,
} from "@/features/absence/absence-summary";
import { BAND_THRESHOLDS } from "@/lib/bradford-factor";
import { RTWInterviewDialog } from "@/components/absence/RTWInterviewDialog";
import { useState } from "react";
export const Route = createFileRoute("/_authenticated/trainees/$staffId")({
  head: () => ({ meta: [{ title: "Trainee — Salisbury Anaesthetics Rota" }] }),
  component: TraineeDetailPage,
});

function TraineeDetailPage() {
  const { staffId } = Route.useParams();
  const fetchProfile = useServerFn(getTraineeProfileWithSupervisors);

  const { data, isLoading } = useQuery({
    queryKey: ["trainee-detail", staffId],
    queryFn: async () => {
      const today = todayISO();
      const [assignments, { data: targets, error: e3 }, { data: specs, error: e4 }, futureRows] =
        await Promise.all([
          // Paginated with deterministic order — long-tenured trainees can
          // exceed the 1000-row PostgREST cap on their own history.
          fetchAllPaged<{
            id: string;
            role_on_list: string | null;
            session_date: string;
            theatre_session_id: string | null;
            supervisor_id: string | null;
            notes: string | null;
            session: string;
            duty_type: string | null;
            locally_modified: boolean | null;
          }>(() =>
            supabase
              .from("rota_assignments")
              .select(
                "id,role_on_list,session_date,theatre_session_id,supervisor_id,notes,session,duty_type,locally_modified",
              )
              .eq("staff_id", staffId)
              .lte("session_date", today)
              .order("session_date", { ascending: false }),
          ),
          supabase.from("trainee_targets").select("*"),
          supabase.from("specialties").select("id,name"),
          // Future rota assignments — used to flag "ICU block only" trainees
          // whose remaining rotation contains no theatre work.
          fetchAllPaged<{ session_date: string; duty_type: string | null }>(() =>
            supabase
              .from("rota_assignments")
              .select("session_date,duty_type")
              .eq("staff_id", staffId)
              .gt("session_date", today)
              .order("session_date", { ascending: true }),
          ),
        ]);
      if (e3) throw e3;
      if (e4) throw e4;

      const tsIds = Array.from(
        new Set(
          (assignments ?? []).map((a) => a.theatre_session_id).filter(Boolean) as string[],
        ),
      );
      const supIds = Array.from(
        new Set(
          (assignments ?? []).map((a) => a.supervisor_id).filter(Boolean) as string[],
        ),
      );
      const [{ profile, supervisors: sups }, ts] = await Promise.all([
        fetchProfile({ data: { staffId, supervisorIds: supIds } }),
        tsIds.length
          ? fetchAllPaged<{
              id: string;
              specialty_id: string | null;
              surgical_consultant: string | null;
              theatre_id: string | null;
            }>(() =>
              supabase
                .from("theatre_sessions")
                .select("id,specialty_id,surgical_consultant,theatre_id")
                .in("id", tsIds)
                .order("id", { ascending: true }),
            )
          : Promise.resolve([] as Array<{
              id: string;
              specialty_id: string | null;
              surgical_consultant: string | null;
              theatre_id: string | null;
            }>),
      ]);
      const theatreIds = Array.from(
        new Set((ts ?? []).map((t) => t.theatre_id).filter(Boolean) as string[]),
      );
      const { data: theatres } = theatreIds.length
        ? await supabase.from("theatres").select("id,name").in("id", theatreIds)
        : { data: [] as any[] };

      // Mirror the overview page: a "solo" entry on a theatre session that
      // also has a consultant OR SAS doctor rostered is in fact supervised.
      // Without this reclassification, the detail page disagrees with the
      // overview's solo/supervised counts and curriculum-progress percentages.
      const supervisorSessionIds = new Set<string>();
      if (tsIds.length) {
        const tsAssigns = await fetchAllPaged<{ theatre_session_id: string | null }>(
          () =>
            supabase
              .from("rota_assignments")
              .select(
                "theatre_session_id,staff_id,profiles!rota_assignments_staff_id_fkey!inner(grade)",
              )
              .in("theatre_session_id", tsIds)
              .in("profiles.grade", ["consultant", "sas"])
              .order("theatre_session_id", { ascending: true }),
        );
        for (const r of tsAssigns) {
          if (r.theatre_session_id) supervisorSessionIds.add(r.theatre_session_id);
        }
      }

      const isJuniorTrainee = (() => {
        const lvl = profile?.training_level?.trim().toUpperCase().replace(/\s+/g, "");
        return !!lvl && ["FY2", "ACCS", "CT1", "CT2", "ST1", "ST2"].includes(lvl);
      })();

      const normalisedAssignments = (assignments ?? []).map((a) => ({
        ...a,
        role_on_list:
          a.role_on_list === "solo" &&
          a.theatre_session_id &&
          (supervisorSessionIds.has(a.theatre_session_id) || isJuniorTrainee)
            ? "supervised"
            : a.role_on_list,
      }));

      return {
        profile,
        assignments: normalisedAssignments,
        targets: targets ?? [],
        specMap: new Map((specs ?? []).map((s) => [s.id, s.name])),
        tsMap: new Map((ts ?? []).map((t) => [t.id, t])),
        supMap: new Map((sups ?? []).map((s) => [s.id, s.full_name])),
        theatreMap: new Map((theatres ?? []).map((t) => [t.id, t.name])),
        futureAssignments: (futureRows ?? []) as Array<{
          duty_type: string | null;
          session_date: string;
        }>,
      };
    },
  });


  const progress = useMemo(() => {
    if (!data?.profile) return [];
    const targetsForLevel = data.targets.filter(
      (t) => t.training_level === data.profile!.training_level,
    );
    return computeProgress(
      targetsForLevel.map((t) => ({
        specialty_id: t.specialty_id,
        specialty_name: data.specMap.get(t.specialty_id) ?? "Unknown",
        required_solo: t.required_solo,
        required_supervised: t.required_supervised,
        required_sessions: t.required_sessions,
      })),
      data.assignments
        .filter((a) => ["solo", "supervised"].includes(a.role_on_list ?? ""))
        .map((a) => ({
          specialty_id: a.theatre_session_id
            ? data.tsMap.get(a.theatre_session_id)?.specialty_id ?? null
            : null,
          role_on_list: a.role_on_list ?? "",
        })),
    );
  }, [data]);

  const audit = useMemo(() => {
    if (!data?.profile) return null;
    return computeFullAudit({
      trainingLevel: data.profile.training_level ?? null,
      assignments: data.assignments as AuditAssignment[],
      tsById: data.tsMap as Map<string, AuditTheatreSession>,
      specNames: data.specMap,
      supNames: data.supMap,
      targets: data.targets as AuditTarget[],
    });
  }, [data]);

  if (isLoading) return <PageLoading />;
  if (!data?.profile) return <p>Not found.</p>;

  const clinicalAssignments = data.assignments.filter((a) =>
    ["solo", "supervised", "supervising"].includes(a.role_on_list ?? ""),
  );

  const rotationEnd =
    (data.profile as { rotation_end_date?: string | null }).rotation_end_date ??
    null;
  const icuOnly = isIcuBlockOnly(
    data.futureAssignments,
    todayISO(),
    rotationEnd,
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/trainees"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> All trainees
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {data.profile.full_name || data.profile.email}
          </h1>
          {icuOnly ? <IcuBlockBadge /> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {data.profile.training_level ?? "No level set"} · {data.profile.email}
        </p>
      </div>

      {icuOnly ? (
        <div className="rounded-md border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-sm text-sky-800 dark:text-sky-200">
          This trainee is currently on an ICU block. No theatre lists are
          expected for the remainder of their rotation, so any "no matched
          theatre list" warnings can be safely ignored.
        </div>
      ) : null}

      {audit && <AuditLenses audit={audit} />}

      <ExceptionReportsCard staffId={staffId} />

      <AbsenceCard
        staffId={staffId}
        staffName={data.profile.full_name || data.profile.email || null}
      />







      <Card>
        <CardHeader>
          <CardTitle className="text-base">Curriculum progress</CardTitle>
        </CardHeader>
        <CardContent>
          {progress.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No targets defined for {data.profile.training_level ?? "this level"}.
            </p>
          ) : (
            <div className="space-y-4">
              {progress.map((p) => (
                <div key={p.specialty_id} className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <div className="font-medium">{p.specialty_name}</div>
                    <div className="text-sm text-muted-foreground">
                      {p.done_total}/{p.required_sessions || p.required_solo + p.required_supervised} sessions · {p.percent}%
                    </div>
                  </div>
                  <Progress value={p.percent} className="h-2" />
                  <div className="flex gap-3 text-xs text-muted-foreground">
                    <span>
                      Solo: <strong className="text-foreground">{p.done_solo}</strong>/{p.required_solo}
                    </span>
                    <span>
                      Supervised: <strong className="text-foreground">{p.done_supervised}</strong>/{p.required_supervised}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session log ({clinicalAssignments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {clinicalAssignments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No clinical sessions logged yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Session</TableHead>
                  <TableHead>Theatre</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Supervisor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clinicalAssignments.map((a) => {
                  const ts = a.theatre_session_id ? data.tsMap.get(a.theatre_session_id) : null;
                  return (
                    <TableRow key={a.id}>
                      <TableCell>{formatDateWithWeekdayGB(a.session_date)}</TableCell>
                      <TableCell className="capitalize">{a.session}</TableCell>
                      <TableCell>{ts ? data.theatreMap.get(ts.theatre_id) ?? "—" : "—"}</TableCell>
                      <TableCell>
                        {ts?.specialty_id ? data.specMap.get(ts.specialty_id) ?? "—" : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.role_on_list === "solo" ? "default" : "secondary"}>
                          {a.role_on_list}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {a.supervisor_id ? data.supMap.get(a.supervisor_id) ?? "—" : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AuditLenses({ audit }: { audit: ReturnType<typeof computeFullAudit> }) {
  const { breadth, soloMix, supervisorExposure, displacement } = audit;
  const deficits = breadth.filter((b) => b.status === "deficit");
  const overs = breadth.filter((b) => b.status === "over");
  const soloPct = Math.round(soloMix.soloRatio * 100);
  const targetSoloPct = Math.round(soloMix.targetSoloRatio * 100);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" /> Specialty breadth
          </CardTitle>
          <CardDescription className="text-xs">
            {deficits.length} deficit · {overs.length} over-exposed · {breadth.length - deficits.length - overs.length} on track
          </CardDescription>
        </CardHeader>
        <CardContent>
          {breadth.length === 0 ? (
            <p className="text-xs text-muted-foreground">No targets defined for this level.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {breadth.slice(0, 6).map((b) => (
                <li key={b.specialty_id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{b.specialty_name}</span>
                  <Badge
                    variant={b.status === "deficit" ? "destructive" : b.status === "over" ? "secondary" : "default"}
                    className="shrink-0"
                  >
                    {b.done}/{b.target} · {b.percent}%
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Solo vs supervised mix</CardTitle>
          <CardDescription className="text-xs">
            Actual {soloPct}% solo · target {targetSoloPct}%
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Progress value={soloPct} className="h-2" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Solo: <strong className="text-foreground">{soloMix.solo}</strong></span>
            <span>Supervised: <strong className="text-foreground">{soloMix.supervised}</strong></span>
            <span className={soloMix.gap < -0.1 ? "text-warning" : soloMix.gap > 0.15 ? "text-warning" : ""}>
              Gap: {(soloMix.gap * 100).toFixed(0)}%
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" /> Supervisor exposure
          </CardTitle>
          <CardDescription className="text-xs">
            {supervisorExposure.distinctSupervisors} distinct · {supervisorExposure.totalSupervisedSessions} supervised sessions
            {supervisorExposure.narrowExposure && (
              <span className="ml-2 inline-flex items-center gap-1 text-warning">
                <AlertTriangle className="h-3 w-3" /> narrow exposure
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {supervisorExposure.rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No named supervisor sessions yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {supervisorExposure.rows.slice(0, 5).map((r) => (
                <li key={r.supervisor_id} className="flex justify-between">
                  <span className="truncate">{r.supervisor_name}</span>
                  <span className="text-muted-foreground">{r.sessions}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-warning" /> Training-list displacement
          </CardTitle>
          <CardDescription className="text-xs">
            {displacement.displacedSessions} displaced · ~{displacement.approxHoursLost}h of training lost
          </CardDescription>
        </CardHeader>
        <CardContent>
          {displacement.recentDisplacements.length === 0 ? (
            <p className="text-xs text-muted-foreground">No displacement detected in this window.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {displacement.recentDisplacements.map((d, i) => (
                <li key={i} className="flex justify-between">
                  <span>{formatDateWithWeekdayGB(d.session_date)}</span>
                  <span className="capitalize text-muted-foreground">{d.session}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ExceptionReportsCard({ staffId }: { staffId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["trainee-exception-reports", staffId],
    queryFn: async () => {
      const data = await fetchAllPaged<{
        id: string;
        status: string;
        category: string;
        event_date: string;
        immediate_safety_concern: boolean;
        due_by: string;
        resolved_at: string | null;
        created_at: string;
      }>(() =>
        supabase
          .from("exception_reports")
          .select("id,status,category,event_date,immediate_safety_concern,due_by,resolved_at,created_at")
          .eq("trainee_id", staffId)
          .order("created_at", { ascending: false }),
      );
      return data as Array<{
        id: string;
        status: ExceptionStatus;
        category: string;
        event_date: string;
        immediate_safety_concern: boolean;
        due_by: string;
        resolved_at: string | null;
        created_at: string;
      }>;
    },
  });

  const rows = data ?? [];
  const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const now = Date.now();
  const openStatuses: ExceptionStatus[] = ["submitted", "acknowledged", "under_review", "escalated"];
  const open = rows.filter((r) => openStatuses.includes(r.status));
  const overdue = open.filter((r) => new Date(r.due_by).getTime() < now).length;
  const safety = rows.filter((r) => r.immediate_safety_concern).length;
  const recent = rows.slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileWarning className="h-4 w-4 text-primary" /> Exception reports
        </CardTitle>
        <CardDescription className="text-xs">
          {isLoading
            ? "Loading…"
            : `${rows.length} total · ${open.length} open${
                overdue > 0 ? ` · ${overdue} past SLA` : ""
              }${safety > 0 ? ` · ${safety} safety-flagged` : ""}`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No exception reports submitted by this trainee.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(STATUS_LABEL) as ExceptionStatus[])
                .filter((s) => (byStatus[s] ?? 0) > 0)
                .map((s) => (
                  <Badge
                    key={s}
                    variant={
                      s === "resolved"
                        ? "default"
                        : s === "escalated"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {STATUS_LABEL[s]}: {byStatus[s]}
                  </Badge>
                ))}
            </div>
            <ul className="space-y-1 text-xs">
              {recent.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 truncate">
                    {r.immediate_safety_concern ? (
                      <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                    ) : null}
                    <span className="truncate">
                      {formatDateWithWeekdayGB(r.event_date)} · {r.category.replace(/_/g, " ")}
                    </span>
                  </span>
                  <Badge
                    variant={r.status === "resolved" ? "default" : "outline"}
                    className="shrink-0"
                  >
                    {STATUS_LABEL[r.status]}
                  </Badge>
                </li>
              ))}
            </ul>
            {rows.length > recent.length ? (
              <p className="text-xs text-muted-foreground">
                Showing 5 of {rows.length}. Guardian/Supervisor view has the full history.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AbsenceCard({ staffId, staffName }: { staffId: string; staffName: string | null }) {
  const [rtwSpell, setRtwSpell] = useState<{ id: string; start_date: string; end_date: string } | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["trainee-absence", staffId],
    queryFn: async () => {
      const [leaveRes, rtwRes] = await Promise.all([
        supabase
          .from("leave_requests")
          .select("id,staff_id,type,status,start_date,end_date,half_day_start,half_day_end")
          .eq("staff_id", staffId)
          .eq("type", "sick")
          .eq("status", "approved")
          .range(0, 999),
        supabase
          .from("return_to_work_interviews")
          .select("leave_request_id,conducted_at,fitness_confirmed,follow_up_required,follow_up_date")
          .eq("staff_id", staffId)
          .range(0, 999),
      ]);
      if (leaveRes.error) throw leaveRes.error;
      if (rtwRes.error) throw rtwRes.error;
      return summariseAbsence(
        (leaveRes.data ?? []) as SickSpellRow[],
        (rtwRes.data ?? []) as RtwRow[],
      );
    },
  });

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Absence & wellbeing</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const b = data.bradford;
  const bandInfo = BAND_THRESHOLDS[b.band];
  const recent = data.spells.slice(0, 5);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HeartPulse className="h-4 w-4 text-primary" /> Absence & wellbeing
        </CardTitle>
        <CardDescription className="text-xs">
          Bradford Factor {b.score} ({bandInfo.label}) · {b.spellCount} spell
          {b.spellCount === 1 ? "" : "s"} · {b.totalDays}d over 12 months
          {data.overdueRtwCount > 0 ? ` · ${data.overdueRtwCount} overdue RTW` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {b.spellCount === 0 ? (
          <p className="text-xs text-muted-foreground">
            No sickness spells in the last 12 months.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge
                variant={
                  b.band === "critical" || b.band === "red"
                    ? "destructive"
                    : b.band === "amber"
                      ? "secondary"
                      : "default"
                }
              >
                {bandInfo.label}: {bandInfo.action}
              </Badge>
              {data.frequentShortSpells ? (
                <Badge variant="outline">Frequent short spells</Badge>
              ) : null}
            </div>
            <ul className="space-y-1 text-xs">
              {recent.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {formatDateWithWeekdayGB(s.start_date)} → {formatDateWithWeekdayGB(s.end_date)} ·{" "}
                    {s.days}d
                    {s.postWeekend ? (
                      <Badge variant="outline" className="ml-1.5 text-[10px]">
                        Post-weekend
                      </Badge>
                    ) : null}
                  </span>
                  {s.rtwStatus === "completed" ? (
                    <Badge variant="default" className="shrink-0 gap-1">
                      <CheckCircle2 className="h-3 w-3" /> RTW done
                    </Badge>
                  ) : s.rtwStatus === "overdue" ? (
                    <button
                      className="shrink-0"
                      onClick={() =>
                        setRtwSpell({ id: s.id, start_date: s.start_date, end_date: s.end_date })
                      }
                    >
                      <Badge variant="destructive">RTW overdue</Badge>
                    </button>
                  ) : (
                    <button
                      className="shrink-0"
                      onClick={() =>
                        setRtwSpell({ id: s.id, start_date: s.start_date, end_date: s.end_date })
                      }
                    >
                      <Badge variant="secondary">RTW pending</Badge>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      {rtwSpell ? (
        <RTWInterviewDialog
          open
          onOpenChange={(o) => {
            if (!o) setRtwSpell(null);
          }}
          onSaved={() => {
            setRtwSpell(null);
            void refetch();
          }}
          staffId={staffId}
          staffName={staffName}
          leaveRequestId={rtwSpell.id}
          spellStart={rtwSpell.start_date}
          spellEnd={rtwSpell.end_date}
        />
      ) : null}
    </Card>
  );
}



