import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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
import { CalendarClock, Users } from "lucide-react";
import { splitName } from "@/lib/utils";
import { countWeekendExtras } from "@/features/analytics/weekend-workload";

const searchSchema = z.object({
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute(
  "/_authenticated/admin/weekend-workload",
)({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "Weekend workload (job plan) — Audits & robustness" },
      {
        name: "description",
        content:
          "Distinct Saturday and Sunday dates worked as job-planned sessions by permanent (non-trainee) staff over a user-selected time period.",
      },
    ],
  }),
  component: WeekendWorkloadPage,
});

const PAGE_SIZE = 1000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

type Row = {
  staff_id: string | null;
  session_date: string | null;
  is_non_sag: boolean | null;
  extra_type: string | null;
  theatre_sessions:
    | { is_non_sag: boolean | null; theatres: { kind: string | null } | null }
    | null;
};

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isWeekend(isoDate: string) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function WeekendWorkloadPage() {
  const { hasRole, loading } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  // Resolve effective range: validated URL params or defaults (last 365 days).
  const fromDate = ISO_RE.test(search.from) ? search.from : isoDaysAgo(365);
  const toDate = ISO_RE.test(search.to) ? search.to : todayIso();

  // Local form state (staged) — only pushed to the URL on Apply.
  const [fromInput, setFromInput] = useState(fromDate);
  const [toInput, setToInput] = useState(toDate);

  const applyRange = (nextFrom: string, nextTo: string) => {
    setFromInput(nextFrom);
    setToInput(nextTo);
    navigate({ search: { from: nextFrom, to: nextTo } });
  };

  const preset = (days: number) => {
    applyRange(isoDaysAgo(days), todayIso());
  };

  const { data, isLoading } = useQuery({
    queryKey: ["admin-analytics-weekend-workload", fromDate, toDate],
    queryFn: async () => {
      const { data: profiles, error: pErr } = await supabase
        .from("profiles")
        .select("id,full_name,grade,active")
        .eq("active", true)
        .in("grade", ["consultant", "sas"])
        .order("full_name");
      if (pErr) throw pErr;
      const staffIds = (profiles ?? []).map((p) => p.id);
      if (staffIds.length === 0) return { profiles: profiles ?? [], rows: [] as Row[] };

      const rows: Row[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error } = await supabase
          .from("rota_assignments")
          .select(
            "staff_id,session_date,is_non_sag,extra_type,theatre_sessions:theatre_session_id(is_non_sag,theatres:theatre_id(kind))",
          )
          .in("staff_id", staffIds)
          .gte("session_date", fromDate)
          .lte("session_date", toDate)
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...((page ?? []) as unknown as Row[]));
        if (!page || page.length < PAGE_SIZE) break;
      }

      return { profiles: profiles ?? [], rows };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const nameById = new Map(
      data.profiles.map((p) => [p.id, p.full_name || "Unknown"]),
    );
    const gradeById = new Map(data.profiles.map((p) => [p.id, p.grade]));

    const weekendDatesByStaff = new Map<string, Set<string>>();

    for (const r of data.rows) {
      if (!r.staff_id || !r.session_date) continue;
      if (r.extra_type) continue;
      if (!isWeekend(r.session_date)) continue;

      const kind = r.theatre_sessions?.theatres?.kind ?? null;
      const rowNonSag = r.is_non_sag || r.theatre_sessions?.is_non_sag || false;
      if (kind === "private" && !rowNonSag) continue;

      let set = weekendDatesByStaff.get(r.staff_id);
      if (!set) {
        set = new Set<string>();
        weekendDatesByStaff.set(r.staff_id, set);
      }
      set.add(r.session_date);
    }

    const extraCountsById = new Map(
      countWeekendExtras(data.rows).map((c) => [c.staff_id, c]),
    );

    const rows = Array.from(nameById.keys()).map((id) => {
      const dates = weekendDatesByStaff.get(id) ?? new Set<string>();
      let sat = 0;
      let sun = 0;
      for (const iso of dates) {
        const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
        if (dow === 6) sat++;
        else if (dow === 0) sun++;
      }
      const extras = extraCountsById.get(id) ?? {
        staff_id: id, extra: 0, locum: 0, wli: 0, sag: 0,
      };
      return {
        staff_id: id,
        name: nameById.get(id) ?? "Unknown",
        grade: gradeById.get(id) ?? null,
        total: dates.size,
        sat,
        sun,
        extra: extras.extra,
        locum: extras.locum,
        wli: extras.wli,
        sag: extras.sag,
        ...splitName(nameById.get(id) ?? ""),
      };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    const totalDays = rows.reduce((n, r) => n + r.total, 0);
    const workedStaff = rows.filter((r) => r.total > 0).length;
    const mean = rows.length > 0 ? totalDays / rows.length : 0;

    return { rows, totalDays, workedStaff, mean };
  }, [data]);


  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Weekend workload (job plan)"
        description="Distinct Saturday and Sunday dates worked by permanent (non-trainee) staff over the selected period. Excludes shifts flagged as extra, locum, WLI, and SAG (private) lists; non-SAG NHH cover is counted as job-planned."
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="wwl-from">From</Label>
              <Input
                id="wwl-from"
                type="date"
                value={fromInput}
                max={toInput || undefined}
                onChange={(e) => setFromInput(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wwl-to">To</Label>
              <Input
                id="wwl-to"
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
                !ISO_RE.test(fromInput) ||
                !ISO_RE.test(toInput) ||
                fromInput > toInput
              }
            >
              Apply
            </Button>
            <div className="flex flex-wrap gap-2 ml-auto">
              <Button variant="outline" size="sm" onClick={() => preset(30)}>
                Last 30 days
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(90)}>
                Last 90 days
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(180)}>
                Last 6 months
              </Button>
              <Button variant="outline" size="sm" onClick={() => preset(365)}>
                Last 12 months
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
            <StatCard label="Permanent staff" value={view.rows.length} icon={Users} />
            <StatCard label="Worked ≥1 weekend day" value={view.workedStaff} icon={Users} />
            <StatCard label="Total weekend days" value={view.totalDays} icon={CalendarClock} />
            <StatCard label="Mean per staff member" value={view.mean.toFixed(1)} icon={CalendarClock} />
          </div>
          <Card>
            <CardContent className="p-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Staff</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead className="text-right">Saturdays</TableHead>
                    <TableHead className="text-right">Sundays</TableHead>
                    <TableHead className="text-right">Total weekend days</TableHead>
                    <TableHead className="text-right" title="Weekend days worked as extra sessions">
                      Extra
                    </TableHead>
                    <TableHead className="text-right" title="Weekend days worked as locum">
                      Locum
                    </TableHead>
                    <TableHead className="text-right" title="Weekend days worked as Waiting-List Initiative">
                      WLI
                    </TableHead>
                    <TableHead className="text-right" title="Weekend days worked on SAG (private) lists">
                      SAG
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.rows.map((r) => (
                    <TableRow key={r.staff_id}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell>
                        {r.grade ? <Badge variant="outline">{r.grade}</Badge> : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.sat}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.sun}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {r.total}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.extra}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.locum}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.wli}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.sag}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>

              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
