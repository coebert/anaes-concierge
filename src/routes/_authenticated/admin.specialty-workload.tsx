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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Activity, CalendarClock, Layers, Moon } from "lucide-react";
import {
  summariseByArea,
  tallySpecialtyWorkload,
  type SpecialtyPaRules,
  type SpecialtyRow,
} from "@/features/analytics/specialty-workload";

const searchSchema = z.object({
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  staff: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/admin/specialty-workload")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "Clinical work by specialty — Audits" },
      {
        name: "description",
        content:
          "Sessions, on-calls and programmed activities worked in every specialty by each consultant and SAS doctor over a period you choose, for appraisal evidence.",
      },
      { property: "og:title", content: "Clinical work by specialty audit" },
      {
        property: "og:description",
        content:
          "Per-specialty days, sessions, on-calls and PAs from CLWRota over any date range.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SpecialtyWorkloadPage,
});

const PAGE_SIZE = 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_RULES: SpecialtyPaRules = {
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

type AssignmentRow = {
  staff_id: string | null;
  session_date: string | null;
  session: string | null;
  duty_type: string | null;
  extra_type: string | null;
  pa_credit: number | null;
  attending_consultant_ids: string[] | null;
  theatre_session_id: string | null;
};

function SpecialtyWorkloadPage() {
  const { hasRole, loading } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const fromDate = ISO_RE.test(search.from) ? search.from : isoDaysAgo(365);
  const toDate = ISO_RE.test(search.to) ? search.to : todayIso();
  const staffFilter = search.staff || "";

  const [fromInput, setFromInput] = useState(fromDate);
  const [toInput, setToInput] = useState(toDate);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const applyRange = (nextFrom: string, nextTo: string) => {
    setFromInput(nextFrom);
    setToInput(nextTo);
    navigate({ search: { from: nextFrom, to: nextTo, staff: staffFilter } });
  };

  const preset = (days: number) => applyRange(isoDaysAgo(days), todayIso());

  const appraisalYear = () => {
    const now = new Date();
    const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    applyRange(`${y}-04-01`, `${y + 1}-03-31`);
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-specialty-workload", fromDate, toDate],
    queryFn: async () => {
      const { data: profiles, error: pErr } = await supabase
        .from("profiles")
        .select("id,full_name,grade")
        .in("grade", ["consultant", "sas"])
        .order("full_name");
      if (pErr) throw pErr;

      const { data: rulesRow } = await supabase
        .from("rota_rules")
        .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
        .limit(1)
        .maybeSingle();

      const rules: SpecialtyPaRules = {
        sessions_per_pa: Number(rulesRow?.sessions_per_pa ?? DEFAULT_RULES.sessions_per_pa),
        oncall_pa_credit: Number(rulesRow?.oncall_pa_credit ?? DEFAULT_RULES.oncall_pa_credit),
        weekend_pa_credit: Number(rulesRow?.weekend_pa_credit ?? DEFAULT_RULES.weekend_pa_credit),
      };

      const staffIds = (profiles ?? []).map((p) => p.id);
      if (staffIds.length === 0) {
        return { profiles: profiles ?? [], rows: [] as SpecialtyRow[], rules };
      }

      const raw: AssignmentRow[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error } = await supabase
          .from("rota_assignments")
          .select(
            "staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids,theatre_session_id",
          )
          .in("staff_id", staffIds)
          .gte("session_date", fromDate)
          .lte("session_date", toDate)
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        raw.push(...((page ?? []) as unknown as AssignmentRow[]));
        if (!page || page.length < PAGE_SIZE) break;
      }

      // Resolve theatre list specialties in bulk.
      const sessionIds = Array.from(
        new Set(raw.map((r) => r.theatre_session_id).filter((v): v is string => Boolean(v))),
      );
      const specialtyBySession = new Map<string, string>();
      for (let i = 0; i < sessionIds.length; i += 300) {
        const chunk = sessionIds.slice(i, i + 300);
        const { data: sessions, error } = await supabase
          .from("theatre_sessions")
          .select("id,specialty_id,specialties(name)")
          .in("id", chunk);
        if (error) throw error;
        for (const s of (sessions ?? []) as unknown as Array<{
          id: string;
          specialties: { name: string } | { name: string }[] | null;
        }>) {
          const sp = Array.isArray(s.specialties) ? s.specialties[0] : s.specialties;
          if (sp?.name) specialtyBySession.set(s.id, sp.name);
        }
      }

      const rows: SpecialtyRow[] = raw.map((r) => ({
        staff_id: r.staff_id,
        session_date: r.session_date,
        session: r.session,
        duty_type: r.duty_type,
        extra_type: r.extra_type,
        pa_credit: r.pa_credit,
        attending_consultant_ids: r.attending_consultant_ids,
        specialty_name: r.theatre_session_id
          ? specialtyBySession.get(r.theatre_session_id) ?? null
          : null,
      }));

      return { profiles: profiles ?? [], rows, rules };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const nameById = new Map(data.profiles.map((p) => [p.id, p.full_name || "Unknown"]));

    const all = tallySpecialtyWorkload(data.rows, data.rules);
    const tallies = staffFilter ? all.filter((t) => t.staff_id === staffFilter) : all;

    const areas = summariseByArea(tallies);
    const byArea = new Map<string, typeof tallies>();
    for (const t of tallies) {
      const list = byArea.get(t.area) ?? [];
      list.push(t);
      byArea.set(t.area, list);
    }

    return {
      areas,
      byArea,
      nameById,
      rules: data.rules,
      totalSessions: areas.reduce((n, a) => n + a.sessions, 0),
      totalOnCalls: areas.reduce((n, a) => n + a.onCalls, 0),
      totalPas: areas.reduce((n, a) => n + a.totalPas, 0),
    };
  }, [data, staffFilter]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin") && !hasRole("rota_coordinator")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Clinical work by specialty"
        description="Every kind of clinical work recorded on CLWRota — theatre lists by specialty, obstetrics, intensive care, on-calls, teaching and SPA — with the days, sessions and programmed activities behind them. Extra, locum, WLI and SAG work is kept separate from job-planned activity."
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="sw-from">From</Label>
              <Input
                id="sw-from"
                type="date"
                value={fromInput}
                max={toInput || undefined}
                onChange={(e) => setFromInput(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sw-to">To</Label>
              <Input
                id="sw-to"
                type="date"
                value={toInput}
                min={fromInput || undefined}
                onChange={(e) => setToInput(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <Button
              onClick={() => applyRange(fromInput, toInput)}
              disabled={!ISO_RE.test(fromInput) || !ISO_RE.test(toInput) || fromInput > toInput}
            >
              Apply
            </Button>
            <div className="space-y-1">
              <Label>Doctor</Label>
              <Select
                value={staffFilter || "all"}
                onValueChange={(v) =>
                  navigate({
                    search: { from: fromDate, to: toDate, staff: v === "all" ? "" : v },
                  })
                }
              >
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="All doctors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All doctors</SelectItem>
                  {(data?.profiles ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={() => preset(90)}>
                Last 3 months
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
            <StatCard label="Specialties & duties" value={view.areas.length} icon={Layers} />
            <StatCard label="Sessions" value={view.totalSessions} icon={CalendarClock} />
            <StatCard label="On-calls" value={view.totalOnCalls} icon={Moon} />
            <StatCard label="Total PAs" value={view.totalPas.toFixed(1)} icon={Activity} tone="info" />
          </div>

          <Card>
            <CardContent className="p-4">
              <Table data-testid="specialty-workload-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Specialty / duty</TableHead>
                    <TableHead className="text-right">Doctors</TableHead>
                    <TableHead className="text-right" title="Distinct dates with a daytime session">
                      Days
                    </TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">On-calls</TableHead>
                    <TableHead className="text-right">Total PAs</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.areas.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                        No clinical sessions found in this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    view.areas.map((a) => (
                      <Fragment key={a.area}>
                        <TableRow>
                          <TableCell className="font-medium">{a.area}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.doctors}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.days}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.sessions}</TableCell>
                          <TableCell className="text-right tabular-nums">{a.onCalls}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">
                            {a.totalPas.toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setOpenKey(openKey === a.area ? null : a.area)}
                            >
                              {openKey === a.area ? "Hide doctors" : "Doctors"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {openKey === a.area ? (
                          <TableRow>
                            <TableCell colSpan={7} className="bg-muted/40">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Doctor</TableHead>
                                    <TableHead className="text-right">Days</TableHead>
                                    <TableHead className="text-right">Sessions</TableHead>
                                    <TableHead className="text-right">On-calls</TableHead>
                                    <TableHead className="text-right">Weekend days</TableHead>
                                    <TableHead className="text-right">Job-planned PAs</TableHead>
                                    <TableHead className="text-right">Extra PAs</TableHead>
                                    <TableHead className="text-right">Total PAs</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {(view.byArea.get(a.area) ?? []).map((t) => (
                                    <TableRow key={t.staff_id}>
                                      <TableCell>
                                        {view.nameById.get(t.staff_id) ?? "Unknown"}
                                      </TableCell>
                                      <TableCell className="text-right tabular-nums">{t.days}</TableCell>
                                      <TableCell className="text-right tabular-nums">{t.sessions}</TableCell>
                                      <TableCell className="text-right tabular-nums">{t.onCalls}</TableCell>
                                      <TableCell className="text-right tabular-nums">{t.weekendDays}</TableCell>
                                      <TableCell className="text-right tabular-nums">
                                        {t.plannedPas.toFixed(1)}
                                      </TableCell>
                                      <TableCell className="text-right tabular-nums text-muted-foreground">
                                        {t.extraPas.toFixed(1)}
                                      </TableCell>
                                      <TableCell className="text-right tabular-nums font-semibold">
                                        {t.totalPas.toFixed(1)}
                                        {t.clwrotaPas > 0 ? (
                                          <div className="text-[10px] font-normal text-muted-foreground">
                                            {t.clwrotaPas.toFixed(1)} recorded ·{" "}
                                            {t.estimatedPas.toFixed(1)} est.
                                          </div>
                                        ) : null}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                              {staffFilter ? (
                                <div className="flex flex-wrap gap-1.5 pt-2">
                                  {(view.byArea.get(a.area) ?? [])
                                    .flatMap((t) => t.dates)
                                    .map((d) => (
                                      <Badge key={d} variant="secondary" className="tabular-nums">
                                        {d}
                                      </Badge>
                                    ))}
                                </div>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    ))
                  )}
                </TableBody>
              </Table>

              <p className="mt-3 text-xs text-muted-foreground">
                Where CLWRota records a PA value for a session it is used directly
                (“recorded”); the rest are estimated from the department rota rules:{" "}
                {view.rules.sessions_per_pa} session(s) per PA, {view.rules.oncall_pa_credit} PA
                per on-call, {view.rules.weekend_pa_credit} PA per weekend day. A weekend day
                counts once — weekend credit replaces the session or on-call credit.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
