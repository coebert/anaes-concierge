import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { computeProgress } from "@/lib/competency-utils";
import { ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { todayISO, getSurname } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/trainees")({
  component: TraineesGuard,
});

function TraineesGuard() {
  const { hasRole, grade, loading } = useAuth();
  if (loading) return null;
  if (!hasRole("admin") && grade !== "trainee") {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Trainee progress is only available to trainees and administrators.
        </CardContent>
      </Card>
    );
  }
  return <TraineesPage />;
}

function TraineesPage() {
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["trainees-overview"],
    queryFn: async () => {
      const [{ data: trainees, error: e1 }, { data: targets, error: e2 }, { data: specs, error: e3 }] =
        await Promise.all([
          supabase
            .from("profiles")
            .select("id,full_name,email,training_level,active")
            .eq("grade", "trainee")
            .eq("active", true)
            .order("full_name"),
          supabase.from("trainee_targets").select("*"),
          supabase.from("specialties").select("id,name"),
        ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;

      const today = todayISO();
      const traineeIds = (trainees ?? []).map((t) => t.id);
      let assignments: Array<{
        staff_id: string;
        role_on_list: string;
        theatre_session_id: string | null;
      }> = [];
      if (traineeIds.length) {
        const { data: rows, error: e4 } = await supabase
          .from("rota_assignments")
          .select("staff_id,role_on_list,theatre_session_id,session_date")
          .in("staff_id", traineeIds)
          .lte("session_date", today)
          .in("role_on_list", ["solo", "supervised"]);
        if (e4) throw e4;
        assignments = rows ?? [];
      }
      const tsIds = Array.from(
        new Set(assignments.map((a) => a.theatre_session_id).filter(Boolean) as string[]),
      );
      let tsMap = new Map<string, string | null>();
      if (tsIds.length) {
        const { data: ts, error: e5 } = await supabase
          .from("theatre_sessions")
          .select("id,specialty_id")
          .in("id", tsIds);
        if (e5) throw e5;
        tsMap = new Map((ts ?? []).map((s) => [s.id, s.specialty_id]));
      }

      const specMap = new Map((specs ?? []).map((s) => [s.id, s.name]));
      return {
        trainees: trainees ?? [],
        targets: targets ?? [],
        specMap,
        assignmentsByStaff: assignments.reduce<Record<string, Array<{ specialty_id: string | null; role_on_list: string }>>>(
          (acc, a) => {
            (acc[a.staff_id] ||= []).push({
              specialty_id: a.theatre_session_id ? tsMap.get(a.theatre_session_id) ?? null : null,
              role_on_list: a.role_on_list,
            });
            return acc;
          },
          {},
        ),
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    return data.trainees
      .filter((t) => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return (
          t.full_name?.toLowerCase().includes(q) ||
          t.email?.toLowerCase().includes(q) ||
          t.training_level?.toLowerCase().includes(q)
        );
      })
      .map((t) => {
        const targetsForLevel = (data.targets ?? []).filter(
          (tg) => tg.training_level === t.training_level,
        );
        const enriched = targetsForLevel.map((tg) => ({
          specialty_id: tg.specialty_id,
          specialty_name: data.specMap.get(tg.specialty_id) ?? "Unknown",
          required_solo: tg.required_solo,
          required_supervised: tg.required_supervised,
          required_sessions: tg.required_sessions,
        }));
        const progress = computeProgress(enriched, data.assignmentsByStaff[t.id] ?? []);
        const overall = progress.length
          ? Math.round(progress.reduce((s, p) => s + p.percent, 0) / progress.length)
          : null;
        return { trainee: t, progress, overall };
      });
  }, [data, filter]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trainees</h1>
          <p className="text-sm text-muted-foreground">
            Per-subspecialty progress against curriculum targets.
          </p>
        </div>
        <Input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All trainees</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !rows.length ? (
            <p className="text-sm text-muted-foreground">No trainees on record.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Overall</TableHead>
                  <TableHead>Specialties</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ trainee, progress, overall }) => (
                  <TableRow key={trainee.id} className="cursor-pointer">
                    <TableCell>
                      <Link
                        to="/trainees/$staffId"
                        params={{ staffId: trainee.id }}
                        className="font-medium hover:underline"
                      >
                        {trainee.full_name || trainee.email}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {trainee.training_level ? (
                        <Badge variant="secondary">{trainee.training_level}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="w-48">
                      {overall === null ? (
                        <span className="text-xs text-muted-foreground">No targets set</span>
                      ) : (
                        <div className="space-y-1">
                          <Progress value={overall} className="h-2" />
                          <div className="text-xs text-muted-foreground">{overall}%</div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {progress.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          progress.map((p) => (
                            <Badge
                              key={p.specialty_id}
                              variant={p.percent >= 100 ? "default" : "outline"}
                              className="text-xs"
                            >
                              {p.specialty_name}: {p.percent}%
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link to="/trainees/$staffId" params={{ staffId: trainee.id }}>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
