import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatDateGB, parseDateLocal } from "@/lib/utils";
import { chunkIds } from "@/lib/supabase-chunked";
import { AuditCoverageBadge } from "@/components/audit-coverage-badge";

import {
  computePoacWeeklyStats,
  validatePoacBaseline,
  type PoacBaselineViolation,
} from "@/features/audit/poac-baseline";

// PostgREST defaults to a 1000-row response cap. Walk the result set in
// pages so audits over long date ranges (or as data grows) cannot silently
// drop rows and under-report sessions/assignments. Returns the rows plus a
// page count and a `complete` flag (true when the final page was shorter
// than the page size, proving the cap was not hit).
async function fetchAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<{ rows: T[]; pages: number; complete: boolean }> {
  const out: T[] = [];
  let offset = 0;
  let pages = 0;
  let complete = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await build(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    pages += 1;
    if (rows.length < pageSize) {
      complete = true;
      break;
    }
    // Full page — keep walking. If the very next page returns empty we still
    // count as complete; only a full page with no further fetch would be
    // ambiguous, and the loop always fetches the next page in that case.
    complete = false;
    offset += pageSize;
  }
  return { rows: out, pages, complete };
}



type DrilldownRow = {
  assignmentId: string;
  sessionId: string | null;
  date: string;
  session: "am" | "pm" | string;
  staffId: string | null;
  staffName: string;
  grade: "consultant" | "sas" | "trainee" | "unknown";
  theatreName: string;
  specialty: string | null;
  surgicalConsultant: string | null;
};


export const Route = createFileRoute("/_authenticated/robustness/poac-audit")({
  head: () => ({ meta: [{ title: "POAC audit — Salisbury Anaesthetics Rota" }] }),
  component: PoacAuditPage,
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ISO week start (Monday) for a given local Date.
function weekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type WeekRow = {
  weekStart: string;
  total: number;
  wedAm: number;
  wedPm: number;
  baseline: number;
  additional: number;
  consultant: number;
  sas: number;
  trainee: number;
  unknown: number;
  additionalConsultant: number;
};


// Match any theatre that represents the Pre-Operative Assessment clinic,
// regardless of which terminology is in use (POAU, POAC, "pre-op assessment",
// "preoperative assessment", "pre-assessment", etc.).
const POAC_THEATRE_FILTER = [
  "name.ilike.%poau%",
  "name.ilike.%poac%",
  "name.ilike.%pre-op%",
  "name.ilike.%pre op%",
  "name.ilike.%preop%",
  "name.ilike.%pre-assess%",
  "name.ilike.%pre assess%",
  "name.ilike.%preassess%",
  "name.ilike.%pre-operative%",
  "name.ilike.%preoperative%",
].join(",");


function PoacAuditPage() {
  const [from, setFrom] = useState<string>(isoDaysAgo(7 * 12));
  const [to, setTo] = useState<string>(todayIso());

  const { data, isLoading } = useQuery({
    queryKey: ["poac-audit", from, to],
    queryFn: async () => {
      // POAU theatre = POAC clinic. Match all common terminology variants.
      const { data: theatres, error: te } = await supabase
        .from("theatres")
        .select("id,name")
        .or(POAC_THEATRE_FILTER);
      if (te) throw te;
      const poacTheatres = theatres ?? [];
      const poacTheatreIds = poacTheatres.map((t) => t.id);
      const theatreNameById = new Map(poacTheatres.map((t) => [t.id, t.name] as const));
      const emptyCoverage = {
        steps: [
          { label: "theatre_sessions", chunks: 0, pages: 0, rows: 0, complete: true },
          { label: "rota_assignments", chunks: 0, pages: 0, rows: 0, complete: true },
          { label: "specialties", chunks: 0, pages: 0, rows: 0, complete: true },
          { label: "profiles", chunks: 0, pages: 0, rows: 0, complete: true },
        ],
      };
      const emptyResult = {
        weeks: [] as WeekRow[],
        totals: { total: 0, additional: 0, consultant: 0, sas: 0, trainee: 0, unknown: 0, additionalConsultant: 0 },
        drilldown: [] as DrilldownRow[],
        baselineViolations: [] as PoacBaselineViolation[],
        coverage: emptyCoverage,
      };

      if (!poacTheatreIds.length) return emptyResult;


      // Track pagination/chunking coverage for the UI status indicator.
      const sessionCov = { chunks: 0, pages: 0, rows: 0, complete: true };
      const assignmentCov = { chunks: 0, pages: 0, rows: 0, complete: true };
      const specialtyCov = { chunks: 0, pages: 0, rows: 0, complete: true };
      const staffCov = { chunks: 0, pages: 0, rows: 0, complete: true };

      // All POAC theatre sessions in range — paged to defeat the 1000-row
      // default cap, and chunked on theatre_id to avoid URL-length truncation
      // if the trust ever splits POAC across many theatres.
      const sessionList: Array<{
        id: string;
        session_date: string;
        session: string;
        theatre_id: string;
        specialty_id: string | null;
        surgical_consultant: string | null;
      }> = [];
      for (const theatreSlice of chunkIds(poacTheatreIds)) {
        const res = await fetchAllPaged((lo, hi) =>
          supabase
            .from("theatre_sessions")
            .select("id,session_date,session,theatre_id,specialty_id,surgical_consultant")
            .in("theatre_id", theatreSlice)
            .gte("session_date", from)
            .lte("session_date", to)
            .range(lo, hi),
        );
        sessionList.push(...res.rows);
        sessionCov.chunks += 1;
        sessionCov.pages += res.pages;
        sessionCov.rows += res.rows.length;
        if (!res.complete) sessionCov.complete = false;
      }
      const sessionIds = sessionList.map((s) => s.id);
      if (!sessionIds.length) {
        return {
          ...emptyResult,
          coverage: {
            steps: [
              { label: "theatre_sessions", ...sessionCov },
              { label: "rota_assignments", ...assignmentCov },
              { label: "specialties", ...specialtyCov },
              { label: "profiles", ...staffCov },
            ],
          },
        };
      }
      const sessionById = new Map(sessionList.map((s) => [s.id, s] as const));

      // Resolve specialty names referenced by these sessions.
      const specialtyIds = Array.from(
        new Set(sessionList.map((s) => s.specialty_id).filter(Boolean)),
      ) as string[];
      const specialtyNameById = new Map<string, string>();
      for (const slice of chunkIds(specialtyIds)) {
        const { data: specs, error: spe } = await supabase
          .from("specialties")
          .select("id,name")
          .in("id", slice);
        if (spe) throw spe;
        const rows = specs ?? [];
        for (const s of rows) specialtyNameById.set(s.id, s.name);
        specialtyCov.chunks += 1;
        specialtyCov.pages += 1;
        specialtyCov.rows += rows.length;
      }

      // Assignments to those POAC sessions in range — chunked on
      // theatre_session_id and paged per chunk so neither URL length nor
      // the 1000-row cap can silently drop rows from the audit totals.
      const assignmentList: Array<{
        id: string;
        staff_id: string;
        session_date: string;
        session: string;
        theatre_session_id: string | null;
      }> = [];
      for (const slice of chunkIds(sessionIds)) {
        const res = await fetchAllPaged((lo, hi) =>
          supabase
            .from("rota_assignments")
            .select("id,staff_id,session_date,session,theatre_session_id")
            .in("theatre_session_id", slice)
            .range(lo, hi),
        );
        assignmentList.push(...res.rows);
        assignmentCov.chunks += 1;
        assignmentCov.pages += res.pages;
        assignmentCov.rows += res.rows.length;
        if (!res.complete) assignmentCov.complete = false;
      }

      // Resolve grade + name for each staff member appearing in assignments.
      const staffIds = Array.from(
        new Set(assignmentList.map((a) => a.staff_id).filter(Boolean)),
      ) as string[];
      const staffById = new Map<string, { grade: string | null; full_name: string | null }>();
      for (const slice of chunkIds(staffIds)) {
        const { data: profs, error: pe } = await supabase
          .from("profiles")
          .select("id,grade,full_name")
          .in("id", slice);
        if (pe) throw pe;
        const rows = profs ?? [];
        for (const p of rows) {
          staffById.set(p.id, { grade: p.grade ?? null, full_name: p.full_name ?? null });
        }
        staffCov.chunks += 1;
        staffCov.pages += 1;
        staffCov.rows += rows.length;
      }


      const normGrade = (g: string | null | undefined): DrilldownRow["grade"] =>
        g === "consultant" || g === "sas" || g === "trainee" ? g : "unknown";

      // Bucket by ISO-week-start (Monday).
      const buckets = new Map<
        string,
        {
          total: number;
          wedAm: Set<string>;
          wedPm: Set<string>;
          wedHasConsultant: boolean;
          consultant: number;
          sas: number;
          trainee: number;
          unknown: number;
        }
      >();
      const ensure = (k: string) => {
        let b = buckets.get(k);
        if (!b) {
          b = {
            total: 0,
            wedAm: new Set(),
            wedPm: new Set(),
            wedHasConsultant: false,
            consultant: 0,
            sas: 0,
            trainee: 0,
            unknown: 0,
          };
          buckets.set(k, b);
        }
        return b;
      };

      const drilldown: DrilldownRow[] = [];

      for (const a of assignmentList) {
        const sess = a.theatre_session_id ? sessionById.get(a.theatre_session_id) : null;
        if (!sess) continue;
        const d = parseDateLocal(a.session_date);
        if (!d) continue;
        const wk = fmtIso(weekStart(d));
        const b = ensure(wk);
        b.total += 1;
        const staff = a.staff_id ? staffById.get(a.staff_id) : undefined;
        const grade = normGrade(staff?.grade);
        b[grade] += 1;
        if (d.getDay() === 3) {
          if (a.session === "am") b.wedAm.add(a.staff_id);
          else if (a.session === "pm") b.wedPm.add(a.staff_id);
          if (grade === "consultant") b.wedHasConsultant = true;
        }

        drilldown.push({
          assignmentId: a.id,
          sessionId: a.theatre_session_id ?? null,
          date: a.session_date,
          session: a.session,
          staffId: a.staff_id,
          staffName: staff?.full_name ?? "(unknown staff)",
          grade,
          theatreName: theatreNameById.get(sess.theatre_id) ?? "(unknown)",
          specialty: sess.specialty_id ? (specialtyNameById.get(sess.specialty_id) ?? null) : null,
          surgicalConsultant: sess.surgical_consultant ?? null,
        });
      }

      drilldown.sort((x, y) => {
        if (x.date !== y.date) return y.date.localeCompare(x.date);
        if (x.session !== y.session) return String(x.session).localeCompare(String(y.session));
        return x.staffName.localeCompare(y.staffName);
      });

      // Compute baseline/additional via the shared, unit-tested rule so the
      // UI numbers can never drift from the validator's expectations.
      const baselineStats = computePoacWeeklyStats(
        assignmentList.map((a) => ({
          date: a.session_date,
          session: a.session,
          staffId: a.staff_id,
        })),
      );
      const baselineByWeek = new Map(baselineStats.map((s) => [s.weekStart, s] as const));

      const weeks: WeekRow[] = Array.from(buckets.entries())
        .map(([k, b]) => {
          const stat = baselineByWeek.get(k);
          const wedAm = b.wedAm.size;
          const wedPm = b.wedPm.size;
          const baseline = stat?.baseline ?? ((wedAm > 0 || wedPm > 0) ? 1 : 0);
          const additional = stat?.additional ?? Math.max(0, b.total - baseline);
          return {
            weekStart: k,
            total: b.total,
            wedAm,
            wedPm,
            baseline,
            additional,
            consultant: b.consultant,
            sas: b.sas,
            trainee: b.trainee,
            unknown: b.unknown,
            // The baseline slot is one Wed AM/PM session. If a consultant
            // covered that slot, subtract it from consultant work to get the
            // "additional" consultant sessions.
            additionalConsultant: Math.max(
              0,
              b.consultant - (b.wedHasConsultant ? 1 : 0),
            ),
          };
        })
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

      const baselineViolations = validatePoacBaseline(
        weeks.map((w) => ({
          weekStart: w.weekStart,
          total: w.total,
          wedAm: w.wedAm,
          wedPm: w.wedPm,
          baseline: (w.baseline === 1 ? 1 : 0) as 0 | 1,
          additional: w.additional,
        })),
      );


      const totals = weeks.reduce(
        (acc, w) => ({
          total: acc.total + w.total,
          additional: acc.additional + w.additional,
          consultant: acc.consultant + w.consultant,
          sas: acc.sas + w.sas,
          trainee: acc.trainee + w.trainee,
          unknown: acc.unknown + w.unknown,
          additionalConsultant: acc.additionalConsultant + w.additionalConsultant,
        }),
        { total: 0, additional: 0, consultant: 0, sas: 0, trainee: 0, unknown: 0, additionalConsultant: 0 },

      );

      return {
        weeks,
        totals,
        drilldown,
        baselineViolations,
        coverage: {
          steps: [
            { label: "theatre_sessions", ...sessionCov },
            { label: "rota_assignments", ...assignmentCov },
            { label: "specialties", ...specialtyCov },
            { label: "profiles", ...staffCov },
          ],
        },
      };
    },
  });

  const weeks = data?.weeks ?? [];
  const drilldown = data?.drilldown ?? [];
  const baselineViolations: PoacBaselineViolation[] = data?.baselineViolations ?? [];
  const coverage = data?.coverage ?? null;


  const totals = data?.totals ?? {
    total: 0,
    additional: 0,
    consultant: 0,
    sas: 0,
    trainee: 0,
    unknown: 0,
    additionalConsultant: 0,
  };




  const maxTotal = useMemo(
    () => weeks.reduce((m, w) => Math.max(m, w.total), 0),
    [weeks],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">POAC audit</h1>
        <p className="text-sm text-muted-foreground">
          Weekly POAC (POAU) clinic sessions covered by anaesthetists.
          &lsquo;Additional&rsquo; counts anything above the baseline of one
          consultant on Wednesday (either AM or PM, not both).
        </p>

      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-[170px]"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <AuditCoverageBadge coverage={coverage} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">

        <SummaryCard label="Weeks shown" value={weeks.length} />
        <SummaryCard label="Total POAC sessions" value={totals.total} tone="primary" />
        <SummaryCard
          label="Total additional sessions"
          value={totals.additional}
          tone="amber"
        />
        <SummaryCard
          label="Total additional consultant sessions"
          value={totals.additionalConsultant}
          tone="amber"
        />
      </div>


      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Consultant sessions" value={totals.consultant} tone="primary" />
        <SummaryCard label="SAS sessions" value={totals.sas} />
        <SummaryCard label="Trainee sessions" value={totals.trainee} />
        <SummaryCard label="Unknown grade" value={totals.unknown} tone={totals.unknown ? "amber" : "default"} />
      </div>


      <Card
        className={
          baselineViolations.length
            ? "border-warning/40 bg-warning-muted/30"
            : "border-success/40 bg-success-muted/30"
        }
      >
        <CardHeader>
          <CardTitle className="text-base">
            Baseline rule validation
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {weeks.length === 0 ? (
            <p className="text-muted-foreground">
              No weeks in range — nothing to validate.
            </p>
          ) : baselineViolations.length === 0 ? (
            <p>
              <Badge className="bg-emerald-500/15 text-success hover:bg-emerald-500/15">
                PASS
              </Badge>{" "}
              All {weeks.length} week{weeks.length === 1 ? "" : "s"} satisfy the
              rule: at most one Wednesday baseline session (AM or PM, not both).
            </p>
          ) : (
            <div className="space-y-2">
              <p>
                <Badge className="bg-amber-500/15 text-warning hover:bg-amber-500/15">
                  {baselineViolations.length} violation
                  {baselineViolations.length === 1 ? "" : "s"}
                </Badge>{" "}
                Some weeks do not satisfy the baseline rule.
              </p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {baselineViolations.slice(0, 10).map((v) => (
                  <li key={`${v.weekStart}-${v.reason}`}>
                    Week of {formatDateGB(v.weekStart)} — {v.reason}
                  </li>
                ))}
                {baselineViolations.length > 10 ? (
                  <li>…and {baselineViolations.length - 10} more.</li>
                ) : null}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>

          <CardTitle className="text-base">Weekly breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !weeks.length ? (
            <p className="text-sm text-muted-foreground">
              No POAC sessions found in this range.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week starting</TableHead>
                  <TableHead className="text-right">Total POAC</TableHead>
                  <TableHead className="text-right">Consultant</TableHead>
                  <TableHead className="text-right">SAS</TableHead>
                  <TableHead className="text-right">Trainee</TableHead>
                  <TableHead className="text-right">Wed AM</TableHead>
                  <TableHead className="text-right">Wed PM</TableHead>
                  <TableHead className="text-right">Baseline</TableHead>
                  <TableHead className="text-right">Additional</TableHead>
                  <TableHead className="w-[160px]">Distribution</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeks.map((w) => {
                  const basePct = maxTotal ? (w.baseline / maxTotal) * 100 : 0;
                  const addPct = maxTotal ? (w.additional / maxTotal) * 100 : 0;
                  return (
                    <TableRow key={w.weekStart}>
                      <TableCell className="font-medium">
                        {formatDateGB(w.weekStart)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.total}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.consultant}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.sas}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.trainee}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {w.wedAm}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {w.wedPm}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <Badge variant="secondary">{w.baseline}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.additional > 0 ? (
                          <Badge className="bg-amber-500/15 text-warning hover:bg-amber-500/15 dark:text-amber-300">
                            +{w.additional}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="bg-primary"
                            style={{ width: `${basePct}%` }}
                          />
                          <div
                            className="bg-amber-500"
                            style={{ width: `${addPct}%` }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session drill-down</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Every matched POAU/POAC session in the selected range, grouped by the
            covering anaesthetist&rsquo;s grade. &lsquo;Theatre (CLWRota)&rsquo;
            shows the original terminology stored from the CLWRota feed
            (e.g. POAU, POAC, pre-op assessment).
          </p>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !drilldown.length ? (
            <p className="text-sm text-muted-foreground">
              No POAC sessions found in this range.
            </p>
          ) : (
            <Tabs defaultValue="consultant">
              <TabsList>
                <TabsTrigger value="consultant">
                  Consultant ({totals.consultant})
                </TabsTrigger>
                <TabsTrigger value="sas">SAS ({totals.sas})</TabsTrigger>
                <TabsTrigger value="trainee">
                  Trainee ({totals.trainee})
                </TabsTrigger>
                {totals.unknown > 0 ? (
                  <TabsTrigger value="unknown">
                    Unknown ({totals.unknown})
                  </TabsTrigger>
                ) : null}
              </TabsList>
              {(["consultant", "sas", "trainee", "unknown"] as const).map((g) => (
                <TabsContent key={g} value={g} className="mt-3">
                  <DrilldownTable rows={drilldown.filter((r) => r.grade === g)} />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DrilldownTable({ rows }: { rows: DrilldownRow[] }) {
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No matched sessions for this grade in the selected range.
      </p>
    );
  }
  // Group by staff for readability while keeping the row-level detail.
  const byStaff = new Map<string, DrilldownRow[]>();
  for (const r of rows) {
    const key = r.staffId ?? `__name__${r.staffName}`;
    const arr = byStaff.get(key) ?? [];
    arr.push(r);
    byStaff.set(key, arr);
  }
  const groups = Array.from(byStaff.entries())
    .map(([k, list]) => ({ key: k, name: list[0].staffName, list }))
    .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name));

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.key} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{g.name}</h3>
            <Badge variant="secondary">{g.list.length} session{g.list.length === 1 ? "" : "s"}</Badge>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Half</TableHead>
                <TableHead>Theatre (CLWRota)</TableHead>
                <TableHead>Specialty</TableHead>
                <TableHead>Surgical consultant</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.list.map((r) => (
                <TableRow key={r.assignmentId}>
                  <TableCell className="font-medium">{formatDateGB(r.date)}</TableCell>
                  <TableCell className="uppercase tabular-nums">{r.session}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.theatreName}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.specialty ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.surgicalConsultant ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}


function SummaryCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "primary" | "amber";
}) {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "amber"
        ? "text-warning"
        : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className={`mt-1 text-3xl font-semibold tabular-nums ${toneClass}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
