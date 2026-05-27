import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getTraineeProfileWithSupervisors } from "@/lib/staff-directory.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { computeProgress } from "@/lib/competency-utils";
import { ArrowLeft } from "lucide-react";
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
        supabase
          .from("rota_assignments")
          .select("id,role_on_list,session_date,theatre_session_id,supervisor_id,notes,session,duty_type")
          .eq("staff_id", staffId)
          .lte("session_date", today)
          .order("session_date", { ascending: false }),
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
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const theatreIds = Array.from(new Set((ts ?? []).map((t) => t.theatre_id).filter(Boolean)));
      const { data: theatres } = theatreIds.length
        ? await supabase.from("theatres").select("id,name").in("id", theatreIds)
        : { data: [] as any[] };

      return {
        profile,
        assignments: assignments ?? [],
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
