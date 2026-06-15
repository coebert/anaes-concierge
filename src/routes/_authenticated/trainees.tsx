import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { listTraineesForOverview } from "@/lib/staff-directory.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { computeProgress } from "@/lib/competency-utils";
import { ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { cn, todayISO } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import { chunkIds } from "@/lib/supabase-chunked";
import { computeTraineeMetrics, type MetricAssignment } from "@/lib/trainee-metrics";
import { isIcuBlockOnly } from "@/lib/audit/trainee-audit";
import { IcuBlockBadge } from "@/components/trainees/IcuBlockBadge";
import { TraineeMetricsCard } from "@/components/trainee-metrics-card";

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
  const { hasRole } = useAuth();
  const [filter, setFilter] = useState("");
  const [fromDate, setFromDate] = useState<Date | undefined>(undefined);
  const [toDate, setToDate] = useState<Date | undefined>(new Date());

  const [debouncedFrom, setDebouncedFrom] = useState<Date | undefined>(undefined);
  const [debouncedTo, setDebouncedTo] = useState<Date | undefined>(new Date());

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedFrom(fromDate);
      setDebouncedTo(toDate);
    }, 350);
    return () => clearTimeout(id);
  }, [fromDate, toDate]);

  const fetchTrainees = useServerFn(listTraineesForOverview);
  const { data, isLoading } = useQuery({
    queryKey: ["trainees-overview"],
    queryFn: async () => {
      const [trainees, { data: targets, error: e2 }, { data: specs, error: e3 }] =
        await Promise.all([
          fetchTrainees(),
          supabase.from("trainee_targets").select("*"),
          supabase.from("specialties").select("id,name"),
        ]);
      if (e2) throw e2;
      if (e3) throw e3;

      const traineeIds = (trainees ?? []).map((t) => t.id);
      const todayIso = todayISO();
      let allAssignments: Array<{
        staff_id: string;
        role_on_list: string;
        session: string;
        duty_type: string | null;
        theatre_session_id: string | null;
        session_date: string;
        locally_modified: boolean | null;
      }> = [];
      if (traineeIds.length) {
        // Explicit high range — the default PostgREST cap is 1000 rows, and
        // active trainees collectively easily exceed that. Truncated reads
        // were silently dropping assignments from longer-tenured trainees,
        // making their progress percentages look artificially low.
        // Also restrict to sessions on/before today so future-scheduled lists
        // don't pre-credit curriculum progress.
        const { data: rows, error: e4 } = await supabase
          .from("rota_assignments")
          .select(
            "staff_id,role_on_list,session,duty_type,theatre_session_id,session_date,locally_modified",
          )
          .in("staff_id", traineeIds)
          .lte("session_date", todayIso)
          .range(0, 49999);
        if (e4) throw e4;
        allAssignments = (rows ?? []) as typeof allAssignments;
      }
      const tsIds = Array.from(
        new Set(allAssignments.map((a) => a.theatre_session_id).filter(Boolean) as string[]),
      );
      // Chunked `.in()` lookup — see src/lib/supabase-chunked.ts. With
      // ~1000+ distinct UUIDs across all active trainees, a single
      // `.in("id", tsIds)` URL exceeds the edge proxy's length limit and
      // is silently truncated — theatre sessions that don't make it back
      // get bucketed as "Unknown" specialty in the per-trainee metric card.
      const tsIdChunks = chunkIds(tsIds);

      const tsMap = new Map<string, string | null>();
      if (tsIds.length) {
        const tsResults = await Promise.all(
          tsIdChunks.map((c) =>
            supabase
              .from("theatre_sessions")
              .select("id,specialty_id")
              .in("id", c)
              .range(0, 49999),
          ),
        );
        for (const { data: ts, error: e5 } of tsResults) {
          if (e5) throw e5;
          for (const s of ts ?? []) tsMap.set(s.id, s.specialty_id);
        }
      }

      // Determine which theatre sessions have a supervisor-capable doctor
      // (consultant OR SAS) assigned — a trainee marked "solo" on such a
      // session is in fact supervised, so we should not count it as a solo
      // list. (rota_assignments.role_on_list defaults to "solo" on import
      // from clwrota, which otherwise inflates solo %.)
      const supervisorSessionIds = new Set<string>();
      if (tsIds.length) {
        // rota_assignments has TWO FKs to profiles (staff_id + supervisor_id),
        // so PostgREST can't auto-resolve `profiles!inner` — disambiguate via
        // the staff_id FK constraint name. Without this hint the embed throws
        // and the whole query errors out, leaving the page empty.
        const supResults = await Promise.all(
          tsIdChunks.map((c) =>
            supabase
              .from("rota_assignments")
              .select("theatre_session_id,staff_id,profiles!rota_assignments_staff_id_fkey!inner(grade)")
              .in("theatre_session_id", c)
              .in("profiles.grade", ["consultant", "sas"])
              .range(0, 49999),
          ),
        );
        for (const { data: tsAssigns, error: e6 } of supResults) {
          if (e6) throw e6;
          for (const r of (tsAssigns ?? []) as Array<{ theatre_session_id: string | null }>) {
            if (r.theatre_session_id) supervisorSessionIds.add(r.theatre_session_id);
          }
        }
      }

      const effectiveRole = (a: { role_on_list: string; theatre_session_id: string | null }) =>
        a.role_on_list === "solo" && a.theatre_session_id && supervisorSessionIds.has(a.theatre_session_id)
          ? "supervised"
          : a.role_on_list;

      const specMap = new Map((specs ?? []).map((s) => [s.id, s.name]));

      // Competency progress only counts clinical lists (solo/supervised) up to today.
      const clinicalByStaff = allAssignments
        .filter((a) => a.role_on_list === "solo" || a.role_on_list === "supervised")
        .reduce<Record<string, Array<{ specialty_id: string | null; role_on_list: string }>>>(
          (acc, a) => {
            (acc[a.staff_id] ||= []).push({
              specialty_id: a.theatre_session_id ? tsMap.get(a.theatre_session_id) ?? null : null,
              role_on_list: effectiveRole(a),
            });
            return acc;
          },
          {},
        );

      // All assignments grouped per staff for metric cards (date-filtered client-side).
      const allByStaff = allAssignments.reduce<Record<string, MetricAssignment[]>>((acc, a) => {
        (acc[a.staff_id] ||= []).push({
          role_on_list: effectiveRole(a),
          session: a.session,
          duty_type: a.duty_type,
          theatre_session_id: a.theatre_session_id,
          session_date: a.session_date,
        });
        return acc;
      }, {});

      // Future assignments (today+ through end of rotation) — used to flag
      // "ICU block only" trainees whose remaining rotation has no theatre work.
      let futureAssignments: Array<{
        staff_id: string;
        duty_type: string | null;
        session_date: string;
      }> = [];
      if (traineeIds.length) {
        const { data: futureRows, error: eFut } = await supabase
          .from("rota_assignments")
          .select("staff_id,duty_type,session_date")
          .in("staff_id", traineeIds)
          .gt("session_date", todayIso)
          .range(0, 49999);
        if (eFut) throw eFut;
        futureAssignments = (futureRows ?? []) as typeof futureAssignments;
      }
      const futureByStaff = futureAssignments.reduce<Record<string, Array<{ duty_type: string | null; session_date: string }>>>(
        (acc, a) => {
          (acc[a.staff_id] ||= []).push({ duty_type: a.duty_type, session_date: a.session_date });
          return acc;
        },
        {},
      );

      return {
        trainees: trainees ?? [],
        targets: targets ?? [],
        specMap,
        tsSpecMap: tsMap,
        assignmentsByStaff: clinicalByStaff,
        allAssignmentsByStaff: allByStaff,
        futureAssignmentsByStaff: futureByStaff,
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
        const rotationEnd =
          (t as { rotation_end_date?: string | null }).rotation_end_date ?? null;
        const icuOnly = isIcuBlockOnly(
          data.futureAssignmentsByStaff[t.id] ?? [],
          todayISO(),
          rotationEnd,
        );
        return { trainee: t, progress, overall, icuOnly };
      })
      .sort((a, b) => compareBySurname(a.trainee.full_name, b.trainee.full_name));
  }, [data, filter]);

  const { fromISO, toISO, asOfMs } = useMemo(() => {
    const to = debouncedTo ?? new Date();
    return {
      fromISO: debouncedFrom ? format(debouncedFrom, "yyyy-MM-dd") : null,
      toISO: format(to, "yyyy-MM-dd"),
      asOfMs: to.getTime(),
    };
  }, [debouncedFrom, debouncedTo]);

  const today = todayISO();
  const isNotYetStarted = (sd: string | null | undefined): sd is string =>
    typeof sd === "string" && sd > today;

  const notYetStartedTrainees = useMemo(
    () =>
      rows
        .filter(({ trainee }) => isNotYetStarted(trainee.start_date))
        .sort((a, b) =>
          (a.trainee.start_date ?? "").localeCompare(b.trainee.start_date ?? ""),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, today],
  );

  const metricRows = useMemo(() => {
    if (!data) return [];
    return rows
      .filter(({ trainee }) => !isNotYetStarted(trainee.start_date))
      .map(({ trainee }) => {
        const all = data.allAssignmentsByStaff[trainee.id] ?? [];
        const filtered = all.filter((a) => {
          const d = a.session_date ?? "";
          if (fromISO && d < fromISO) return false;
          if (d > toISO) return false;
          return true;
        });
        const icuOnly = rows.find((r) => r.trainee.id === trainee.id)?.icuOnly ?? false;
        return {
          trainee,
          icuOnly,
          metrics: computeTraineeMetrics(
            filtered,
            trainee.start_date,
            data.tsSpecMap,
            data.specMap,
            asOfMs,
            (trainee as { rotation_end_date?: string | null }).rotation_end_date ?? null,
            icuOnly,
          ),
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rows, fromISO, toISO, asOfMs, today]);

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
      {notYetStartedTrainees.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">Not yet started</CardTitle>
                <p className="text-xs text-muted-foreground">
                  On CLWRota but not scheduled for any activity (and not on leave) in
                  the next two weeks. Predicted start date taken from their first
                  future CLWRota assignment or the staff feed.
                </p>
              </div>
              {hasRole("admin") ? (
                <Button asChild size="sm" variant="outline">
                  <Link to="/trainees/start-date-audit">Verify leave logic</Link>
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Predicted start</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {notYetStartedTrainees.map(({ trainee }) => (
                  <TableRow key={trainee.id}>
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
                    <TableCell>
                      <Badge variant="outline">
                        {trainee.start_date
                          ? format(new Date(trainee.start_date), "PPP")
                          : "Unknown"}
                      </Badge>
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
          </CardContent>
        </Card>
      ) : null}


      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Trainee summary</h2>
            <p className="text-xs text-muted-foreground">
              Time at Salisbury, time remaining, specialty mix, solo daytime %, and on-call share.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateField
              label="From"
              value={fromDate}
              onChange={(d) => {
                if (d && toDate && d > toDate) {
                  setFromDate(toDate);
                  setToDate(d);
                } else {
                  setFromDate(d);
                }
              }}
              placeholder="Start"
              clearable
            />
            <DateField
              label="To"
              value={toDate}
              onChange={(d) => {
                if (d && fromDate && d < fromDate) {
                  setToDate(fromDate);
                  setFromDate(d);
                } else {
                  setToDate(d);
                }
              }}
              placeholder="Today"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromDate(undefined);
                setToDate(new Date());
              }}
            >
              Reset
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {fromISO
            ? `Counting assignments from ${fromISO} through ${toISO}.`
            : `Counting all assignments up to ${toISO}.`}
        </p>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading metrics…</p>
        ) : metricRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trainees on record.</p>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {metricRows.map(({ trainee, metrics, icuOnly }) => (
              <TraineeMetricsCard
                key={trainee.id}
                title={trainee.full_name || trainee.email || "—"}
                subtitle={trainee.training_level ?? "No level set"}
                metrics={metrics}
                startDate={trainee.start_date}
                rotationEndDate={(trainee as { rotation_end_date?: string | null }).rotation_end_date ?? null}
                icuBlockOnly={icuOnly}
              />
            ))}
          </div>
        )}
      </section>

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
                {rows.map(({ trainee, progress, overall, icuOnly }) => (
                  <TableRow key={trainee.id} className="cursor-pointer">
                    <TableCell>
                      <Link
                        to="/trainees/$staffId"
                        params={{ staffId: trainee.id }}
                        className="font-medium hover:underline"
                      >
                        {trainee.full_name || trainee.email}
                      </Link>
                      {isNotYetStarted(trainee.start_date) ? (
                        <Badge variant="outline" className="ml-2 text-xs">
                          Not yet started · {format(new Date(trainee.start_date), "d MMM yyyy")}
                        </Badge>
                      ) : null}
                      {icuOnly ? <IcuBlockBadge className="ml-2" /> : null}
                      {(trainee as { left_at?: string | null }).left_at ? (
                        <Badge
                          variant="outline"
                          className="ml-2 text-xs border-rose-500/60 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                          title="Automatically marked inactive after >4 weeks with no rota assignment and no approved leave."
                        >
                          No longer at Salisbury · since {format(new Date((trainee as { left_at: string }).left_at), "d MMM yyyy")}
                        </Badge>
                      ) : null}
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

function DateField({
  label,
  value,
  onChange,
  placeholder,
  clearable,
}: {
  label: string;
  value: Date | undefined;
  onChange: (d: Date | undefined) => void;
  placeholder: string;
  clearable?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "h-9 min-w-[160px] justify-start text-left font-normal",
              !value && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">
              {label}
            </span>
            {value ? format(value, "PPP") : <span>{placeholder}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value}
            onSelect={onChange}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
      {clearable && value ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onChange(undefined)}
          aria-label={`Clear ${label}`}
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
