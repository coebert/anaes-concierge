import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getTraineeProfileWithSupervisors } from "@/lib/staff-directory.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { computeProgress } from "@/lib/competency-utils";
import { computeFullAudit, type AuditAssignment, type AuditTheatreSession, type AuditTarget } from "@/lib/audit/trainee-audit";
import { ArrowLeft, AlertTriangle, Sparkles, Users } from "lucide-react";
import { formatDateWithWeekdayGB, todayISO } from "@/lib/utils";
export const Route = createFileRoute("/_authenticated/trainees/$staffId")({
  component: TraineeDetailPage,
});

function TraineeDetailPage() {
  const { staffId } = Route.useParams();
  const fetchProfile = useServerFn(getTraineeProfileWithSupervisors);

  const { data, isLoading } = useQuery({
    queryKey: ["trainee-detail", staffId],
    queryFn: async () => {
      const today = todayISO();
      const [
        { data: assignments, error: e2 },
        { data: targets, error: e3 },
        { data: specs, error: e4 },
      ] = await Promise.all([
        // Select `locally_modified` so the displacement lens actually works
        // — previously this column was missing from the projection, so every
        // trainee showed 0 displaced sessions regardless of reality.
        // `.range` lifts the default 1000-row PostgREST cap; long-tenured
        // trainees can exceed that on their own.
        supabase
          .from("rota_assignments")
          .select(
            "id,role_on_list,session_date,theatre_session_id,supervisor_id,notes,session,duty_type,locally_modified",
          )
          .eq("staff_id", staffId)
          .lte("session_date", today)
          .order("session_date", { ascending: false })
          .range(0, 9999),
        supabase.from("trainee_targets").select("*"),
        supabase.from("specialties").select("id,name"),
      ]);
      if (e2) throw e2;
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
      const [{ profile, supervisors: sups }, { data: ts }] = await Promise.all([
        fetchProfile({ data: { staffId, supervisorIds: supIds } }),
        tsIds.length
          ? supabase
              .from("theatre_sessions")
              .select("id,specialty_id,surgical_consultant,theatre_id")
              .in("id", tsIds)
              .range(0, 9999)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const theatreIds = Array.from(new Set((ts ?? []).map((t) => t.theatre_id).filter(Boolean)));
      const { data: theatres } = theatreIds.length
        ? await supabase.from("theatres").select("id,name").in("id", theatreIds)
        : { data: [] as any[] };

      // Mirror the overview page: a "solo" entry on a theatre session that
      // also has a consultant OR SAS doctor rostered is in fact supervised.
      // Without this reclassification, the detail page disagrees with the
      // overview's solo/supervised counts and curriculum-progress percentages.
      const supervisorSessionIds = new Set<string>();
      if (tsIds.length) {
        const { data: tsAssigns, error: e6 } = await supabase
          .from("rota_assignments")
          .select(
            "theatre_session_id,staff_id,profiles!rota_assignments_staff_id_fkey!inner(grade)",
          )
          .in("theatre_session_id", tsIds)
          .in("profiles.grade", ["consultant", "sas"])
          .range(0, 9999);
        if (e6) throw e6;
        for (const r of (tsAssigns ?? []) as Array<{ theatre_session_id: string | null }>) {
          if (r.theatre_session_id) supervisorSessionIds.add(r.theatre_session_id);
        }
      }

      const normalisedAssignments = (assignments ?? []).map((a) => ({
        ...a,
        role_on_list:
          a.role_on_list === "solo" &&
          a.theatre_session_id &&
          supervisorSessionIds.has(a.theatre_session_id)
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
        .filter((a) => ["solo", "supervised"].includes(a.role_on_list))
        .map((a) => ({
          specialty_id: a.theatre_session_id
            ? data.tsMap.get(a.theatre_session_id)?.specialty_id ?? null
            : null,
          role_on_list: a.role_on_list,
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

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.profile) return <p>Not found.</p>;

  const clinicalAssignments = data.assignments.filter((a) =>
    ["solo", "supervised", "supervising"].includes(a.role_on_list),
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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {data.profile.full_name || data.profile.email}
        </h1>
        <p className="text-sm text-muted-foreground">
          {data.profile.training_level ?? "No level set"} · {data.profile.email}
        </p>
      </div>

      {audit && <AuditLenses audit={audit} />}


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
            <span className={soloMix.gap < -0.1 ? "text-amber-600" : soloMix.gap > 0.15 ? "text-amber-600" : ""}>
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
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
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
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Training-list displacement
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

