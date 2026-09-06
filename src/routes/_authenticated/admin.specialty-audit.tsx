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
  listSpecialtySessions,
  type SpecialtyPaRules,
  type SpecialtyRow,
  type SpecialtySession,
} from "@/features/analytics/specialty-workload";

const searchSchema = z.object({
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  area: fallback(z.string(), "").default(""),
  staff: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/admin/specialty-audit")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "Specialty session audit — PA credits by doctor" },
      {
        name: "description",
        content:
          "Audit every recorded CLWRota session in a chosen specialty, with the programmed activity credited to each consultant and SAS doctor and the date it came from.",
      },
      { property: "og:title", content: "Specialty session audit" },
      {
        property: "og:description",
        content:
          "Session-by-session evidence of clinical work and PA credits in any specialty over a date range you choose.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SpecialtyAuditPage,
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

function round2(n: number) {
  return Math.round(n * 100) / 100;
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

type DoctorRow = {
  staff_id: string;
  sessions: number;
  onCalls: number;
  weekendDays: number;
  days: number;
  recordedPas: number;
  estimatedPas: number;
  totalPas: number;
  unrecorded: number;
  rows: SpecialtySession[];
};

function SpecialtyAuditPage() {
  const { hasRole, loading } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const fromDate = ISO_RE.test(search.from) ? search.from : isoDaysAgo(365);
  const toDate = ISO_RE.test(search.to) ? search.to : todayIso();
  const areaFilter = search.area || "";
  const staffFilter = search.staff || "";

  const [fromInput, setFromInput] = useState(fromDate);
  const [toInput, setToInput] = useState(toDate);
  const [openId, setOpenId] = useState<string | null>(null);

  const setSearch = (next: Partial<z.infer<typeof searchSchema>>) =>
    navigate({
      search: { from: fromDate, to: toDate, area: areaFilter, staff: staffFilter, ...next },
    });

  const applyRange = (nextFrom: string, nextTo: string) => {
    setFromInput(nextFrom);
    setToInput(nextTo);
    setSearch({ from: nextFrom, to: nextTo });
  };

  const preset = (days: number) => applyRange(isoDaysAgo(days), todayIso());

  const appraisalYear = () => {
    const now = new Date();
    const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    applyRange(`${y}-04-01`, `${y + 1}-03-31`);
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-specialty-audit", fromDate, toDate],
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
    const allSessions = listSpecialtySessions(data.rows, data.rules);
    const areas = Array.from(new Set(allSessions.map((s) => s.area))).sort((a, b) =>
      a.localeCompare(b),
    );

    const known = new Set(data.profiles.map((p) => p.id));
    const filtered = allSessions.filter(
      (s) =>
        known.has(s.staff_id) &&
        (!areaFilter || s.area === areaFilter) &&
        (!staffFilter || s.staff_id === staffFilter),
    );

    const byDoctor = new Map<string, DoctorRow>();
    for (const s of filtered) {
      let d = byDoctor.get(s.staff_id);
      if (!d) {
        d = {
          staff_id: s.staff_id,
          sessions: 0,
          onCalls: 0,
          weekendDays: 0,
          days: 0,
          recordedPas: 0,
          estimatedPas: 0,
          totalPas: 0,
          unrecorded: 0,
          rows: [],
        };
        byDoctor.set(s.staff_id, d);
      }
      d.rows.push(s);
      if (s.isOnCall) d.onCalls += 1;
      else d.sessions += 1;
      if (s.recordedPa !== null) d.recordedPas += s.creditedPa;
      else {
        d.estimatedPas += s.creditedPa;
        if (s.creditedPa > 0) d.unrecorded += 1;
      }
      d.totalPas += s.creditedPa;
    }

    const doctors = Array.from(byDoctor.values()).map((d) => {
      const dates = new Set(d.rows.map((r) => r.date));
      const weekendDates = new Set(d.rows.filter((r) => r.isWeekend).map((r) => r.date));
      return {
        ...d,
        days: dates.size,
        weekendDays: weekendDates.size,
        recordedPas: round2(d.recordedPas),
        estimatedPas: round2(d.estimatedPas),
        totalPas: round2(d.totalPas),
        rows: d.rows.sort((a, b) => b.date.localeCompare(a.date) || a.session.localeCompare(b.session)),
      };
    });
    doctors.sort(
      (a, b) =>
        b.totalPas - a.totalPas ||
        (nameById.get(a.staff_id) ?? "").localeCompare(nameById.get(b.staff_id) ?? ""),
    );

    return {
      areas,
      doctors,
      nameById,
      totalSessions: doctors.reduce((n, d) => n + d.sessions, 0),
      totalOnCalls: doctors.reduce((n, d) => n + d.onCalls, 0),
      totalPas: round2(doctors.reduce((n, d) => n + d.totalPas, 0)),
      unrecorded: doctors.reduce((n, d) => n + d.unrecorded, 0),
    };
  }, [data, areaFilter, staffFilter]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin") && !hasRole("rota_coordinator")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Specialty session audit"
        description="Every recorded CLWRota session in a chosen area of work, with the programmed activities credited to each consultant and SAS doctor and the exact dates behind them. Values recorded by CLWRota are shown separately from the ones worked out from the rota rules."
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="sa-from">From</Label>
              <Input
                id="sa-from"
                type="date"
                className="w-[10.5rem]"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sa-to">To</Label>
              <Input
                id="sa-to"
                type="date"
                className="w-[10.5rem]"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
              />
            </div>
            <Button onClick={() => applyRange(fromInput, toInput)}>Apply</Button>
            <Button variant="outline" onClick={() => preset(90)}>Last 3 months</Button>
            <Button variant="outline" onClick={() => preset(365)}>Last 12 months</Button>
            <Button variant="outline" onClick={appraisalYear}>Appraisal year</Button>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Area of work</Label>
              <Select
                value={areaFilter || "all"}
                onValueChange={(v) => setSearch({ area: v === "all" ? "" : v })}
              >
                <SelectTrigger className="w-[18rem]" data-testid="specialty-audit-area">
                  <SelectValue placeholder="All areas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All areas</SelectItem>
                  {(view?.areas ?? []).map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Doctor</Label>
              <Select
                value={staffFilter || "all"}
                onValueChange={(v) => setSearch({ staff: v === "all" ? "" : v })}
              >
                <SelectTrigger className="w-[18rem]">
                  <SelectValue placeholder="All doctors" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All doctors</SelectItem>
                  {(data?.profiles ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.full_name || "Unknown"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading || !view ? (
        <PageLoading />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Sessions" value={String(view.totalSessions)} icon={Layers} />
            <StatCard label="On-calls" value={String(view.totalOnCalls)} icon={Moon} />
            <StatCard label="Programmed activities" value={view.totalPas.toFixed(2)} icon={Activity} />
            <StatCard
              label="Without a recorded value"
              value={String(view.unrecorded)}
              icon={CalendarClock}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              <Table data-testid="specialty-audit-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Doctor</TableHead>
                    <TableHead className="text-right">Days</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">On-calls</TableHead>
                    <TableHead className="text-right">Weekend days</TableHead>
                    <TableHead className="text-right">Recorded PAs</TableHead>
                    <TableHead className="text-right">Estimated PAs</TableHead>
                    <TableHead className="text-right">Total PAs</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.doctors.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        No sessions recorded for this area and period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    view.doctors.map((d) => (
                      <Fragment key={d.staff_id}>
                        <TableRow>
                          <TableCell className="font-medium">
                            {view.nameById.get(d.staff_id) ?? "Unknown"}
                          </TableCell>
                          <TableCell className="text-right">{d.days}</TableCell>
                          <TableCell className="text-right">{d.sessions}</TableCell>
                          <TableCell className="text-right">{d.onCalls}</TableCell>
                          <TableCell className="text-right">{d.weekendDays}</TableCell>
                          <TableCell className="text-right">{d.recordedPas.toFixed(2)}</TableCell>
                          <TableCell className="text-right">{d.estimatedPas.toFixed(2)}</TableCell>
                          <TableCell className="text-right font-semibold">
                            {d.totalPas.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setOpenId(openId === d.staff_id ? null : d.staff_id)}
                            >
                              {openId === d.staff_id ? "Hide sessions" : "Show sessions"}
                            </Button>
                          </TableCell>
                        </TableRow>
                        {openId === d.staff_id && (
                          <TableRow>
                            <TableCell colSpan={9} className="bg-muted/40">
                              <div
                                className="max-h-[26rem] overflow-auto"
                                data-testid="specialty-audit-sessions"
                              >
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Date</TableHead>
                                      <TableHead>Half</TableHead>
                                      <TableHead>Area</TableHead>
                                      <TableHead>Type</TableHead>
                                      <TableHead className="text-right">PA credit</TableHead>
                                      <TableHead>Shared with</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {d.rows.map((s, i) => (
                                      <TableRow key={`${s.date}-${s.session}-${s.area}-${i}`}>
                                        <TableCell>{s.date}</TableCell>
                                        <TableCell className="uppercase">{s.session}</TableCell>
                                        <TableCell>{s.area}</TableCell>
                                        <TableCell className="space-x-1">
                                          {s.isOnCall && <Badge variant="secondary">On-call</Badge>}
                                          {s.isWeekend && <Badge variant="outline">Weekend</Badge>}
                                          {s.extraType && (
                                            <Badge variant="outline" className="uppercase">
                                              {s.extraType}
                                            </Badge>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {s.creditedPa.toFixed(2)}{" "}
                                          <Badge
                                            variant={s.recordedPa !== null ? "default" : "outline"}
                                          >
                                            {s.recordedPa !== null ? "recorded" : "estimated"}
                                          </Badge>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground">
                                          {s.sharedWith.length === 0
                                            ? "—"
                                            : s.sharedWith
                                                .map((id) => view.nameById.get(id) ?? "Unknown")
                                                .join(", ")}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
