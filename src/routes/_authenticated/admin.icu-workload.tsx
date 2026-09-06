import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Activity, CalendarClock, Moon, Users } from "lucide-react";
import {
  ICU_DUTY_TYPES,
  tallyIcuWorkload,
  type IcuRow,
  type IcuPaRules,
} from "@/features/analytics/icu-workload";

const searchSchema = z.object({
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/admin/icu-workload")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "ICU sessions & PAs — Audits & robustness" },
      {
        name: "description",
        content:
          "Intensive care days, on-calls and programmed activities worked by each consultant and SAS doctor over a selectable period, for appraisal and revalidation evidence.",
      },
      { property: "og:title", content: "ICU sessions & PAs audit" },
      {
        property: "og:description",
        content:
          "Per-consultant intensive care days, on-calls and PAs over a date range you choose.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: IcuWorkloadPage,
});

const PAGE_SIZE = 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_RULES: IcuPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function IcuWorkloadPage() {
  const { hasRole, loading } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const fromDate = ISO_RE.test(search.from) ? search.from : isoDaysAgo(365);
  const toDate = ISO_RE.test(search.to) ? search.to : todayIso();

  const [fromInput, setFromInput] = useState(fromDate);
  const [toInput, setToInput] = useState(toDate);
  const [openStaff, setOpenStaff] = useState<string | null>(null);

  const applyRange = (nextFrom: string, nextTo: string) => {
    setFromInput(nextFrom);
    setToInput(nextTo);
    navigate({ search: { from: nextFrom, to: nextTo } });
  };

  const preset = (days: number) => applyRange(isoDaysAgo(days), todayIso());

  const appraisalYear = () => {
    // NHS appraisal years commonly run 1 April → 31 March.
    const now = new Date();
    const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    applyRange(`${y}-04-01`, `${y + 1}-03-31`);
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-icu-workload", fromDate, toDate],
    queryFn: async () => {
      const { data: profiles, error: pErr } = await supabase
        .from("profiles")
        .select("id,full_name,grade,active")
        .in("grade", ["consultant", "sas"])
        .order("full_name");
      if (pErr) throw pErr;

      const { data: rulesRow } = await supabase
        .from("rota_rules")
        .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
        .limit(1)
        .maybeSingle();

      const rules: IcuPaRules = {
        sessions_per_pa: Number(rulesRow?.sessions_per_pa ?? DEFAULT_RULES.sessions_per_pa),
        oncall_pa_credit: Number(rulesRow?.oncall_pa_credit ?? DEFAULT_RULES.oncall_pa_credit),
        weekend_pa_credit: Number(rulesRow?.weekend_pa_credit ?? DEFAULT_RULES.weekend_pa_credit),
      };

      const staffIds = (profiles ?? []).map((p) => p.id);
      if (staffIds.length === 0) {
        return { profiles: profiles ?? [], rows: [] as IcuRow[], rules };
      }

      const rows: IcuRow[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error } = await supabase
          .from("rota_assignments")
          .select("staff_id,session_date,session,duty_type,extra_type")
          .in("staff_id", staffIds)
          .in("duty_type", [...ICU_DUTY_TYPES])
          .gte("session_date", fromDate)
          .lte("session_date", toDate)
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...((page ?? []) as unknown as IcuRow[]));
        if (!page || page.length < PAGE_SIZE) break;
      }

      return { profiles: profiles ?? [], rows, rules };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));
    const gradeById = new Map(data.profiles.map((p) => [p.id, p.grade]));

    const tallies = tallyIcuWorkload(data.rows, data.rules).map((t) => ({
      ...t,
      name: nameById.get(t.staff_id) ?? "Unknown",
      grade: gradeById.get(t.staff_id) ?? null,
    }));

    return {
      rows: tallies,
      rules: data.rules,
      totalDays: tallies.reduce((n, t) => n + t.days, 0),
      totalOnCalls: tallies.reduce((n, t) => n + t.onCalls, 0),
      totalPas: tallies.reduce((n, t) => n + t.totalPas, 0),
    };
  }, [data]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin") && !hasRole("rota_coordinator")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="ICU sessions & PAs"
        description="Intensive care days, on-calls and programmed activities worked by each consultant and SAS doctor over the selected period — evidence for appraisal and revalidation. Extra, locum, WLI and SAG work is shown separately from job-planned activity."
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="icu-from">From</Label>
              <Input
                id="icu-from"
                type="date"
                value={fromInput}
                max={toInput || undefined}
                onChange={(e) => setFromInput(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="icu-to">To</Label>
              <Input
                id="icu-to"
                type="date"
                value={toInput}
                min={fromInput || undefined}
                onChange={(e) => setToInput(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <Button
              onClick={() => applyRange(fromInput, toInput)}
              disabled={
                !ISO_RE.test(fromInput) || !ISO_RE.test(toInput) || fromInput > toInput
              }
            >
              Apply
            </Button>
            <div className="flex flex-wrap gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={() => preset(90)}>
                Last 3 months
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(180)}>
                Last 6 months
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(365)}>
                Last 12 months
              </Button>
              <Button variant="outline" size="sm" onClick={appraisalYear}>
                This appraisal year
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {fromDate} to {toDate}.
          </p>
        </CardContent>
      </Card>

      {isLoading || !view ? (
        <PageLoading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Doctors with ICU activity" value={view.rows.length} icon={Users} />
            <StatCard label="ICU days worked" value={view.totalDays} icon={CalendarClock} />
            <StatCard label="ICU on-calls" value={view.totalOnCalls} icon={Moon} />
            <StatCard label="Total ICU PAs" value={view.totalPas.toFixed(1)} icon={Activity} tone="info" />
          </div>

          <Card>
            <CardContent className="p-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Doctor</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead className="text-right" title="Distinct dates with a daytime ICU session">
                      ICU days
                    </TableHead>
                    <TableHead className="text-right" title="Daytime ICU session halves (AM + PM)">
                      Sessions
                    </TableHead>
                    <TableHead className="text-right" title="Distinct dates with an evening or overnight ICU on-call">
                      On-calls
                    </TableHead>
                    <TableHead className="text-right" title="Distinct Saturday/Sunday ICU dates">
                      Weekend days
                    </TableHead>
                    <TableHead className="text-right">Job-planned PAs</TableHead>
                    <TableHead className="text-right" title="Extra, locum, WLI and SAG ICU sessions">
                      Extra PAs
                    </TableHead>
                    <TableHead className="text-right">Total PAs</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-sm text-muted-foreground">
                        No ICU sessions found in this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    view.rows.map((r) => (
                      <Fragment key={r.staff_id}>
                        <TableRow>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell>
                            {r.grade ? <Badge variant="outline">{r.grade}</Badge> : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.days}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.sessions}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.onCalls}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.weekendDays}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.plannedPas.toFixed(1)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {r.extraPas.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">
                            {r.totalPas.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setOpenStaff(openStaff === r.staff_id ? null : r.staff_id)
                              }
                            >
                              {openStaff === r.staff_id ? "Hide dates" : "Dates"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {openStaff === r.staff_id ? (
                          <TableRow>
                            <TableCell colSpan={10} className="bg-muted/40 text-xs">
                              <div className="flex flex-wrap gap-1.5 py-1">
                                {r.dates.map((d) => (
                                  <Badge key={d} variant="secondary" className="tabular-nums">
                                    {d}
                                  </Badge>
                                ))}
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    ))
                  )}
                </TableBody>
              </Table>

              <p className="mt-3 text-xs text-muted-foreground">
                PAs calculated from the department rota rules:{" "}
                {view.rules.sessions_per_pa} session(s) per PA,{" "}
                {view.rules.oncall_pa_credit} PA per on-call,{" "}
                {view.rules.weekend_pa_credit} PA per weekend day.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
