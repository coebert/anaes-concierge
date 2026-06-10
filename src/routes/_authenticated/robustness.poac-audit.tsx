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
import { formatDateGB, parseDateLocal } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/robustness/poac-audit")({
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
      const poacTheatreIds = (theatres ?? []).map((t) => t.id);
      if (!poacTheatreIds.length) {
        return {
          weeks: [] as WeekRow[],
          totals: { total: 0, additional: 0, consultant: 0, sas: 0, trainee: 0, unknown: 0 },
        };
      }

      // All POAC theatre sessions in range.
      const { data: sessions, error: se } = await supabase
        .from("theatre_sessions")
        .select("id,session_date,session,theatre_id")
        .in("theatre_id", poacTheatreIds)
        .gte("session_date", from)
        .lte("session_date", to);
      if (se) throw se;
      const sessionIds = (sessions ?? []).map((s) => s.id);
      if (!sessionIds.length) {
        return {
          weeks: [] as WeekRow[],
          totals: { total: 0, additional: 0, consultant: 0, sas: 0, trainee: 0, unknown: 0 },
        };
      }
      const sessionById = new Map(
        (sessions ?? []).map((s) => [s.id, s] as const),
      );

      // Assignments to those POAC sessions in range.
      const { data: assignments, error: ae } = await supabase
        .from("rota_assignments")
        .select("staff_id,session_date,session,theatre_session_id")
        .in("theatre_session_id", sessionIds);
      if (ae) throw ae;

      // Resolve grade for each staff member appearing in assignments.
      const staffIds = Array.from(
        new Set((assignments ?? []).map((a) => a.staff_id).filter(Boolean)),
      ) as string[];
      const gradeByStaff = new Map<string, string | null>();
      if (staffIds.length) {
        const { data: profs, error: pe } = await supabase
          .from("profiles")
          .select("id,grade")
          .in("id", staffIds);
        if (pe) throw pe;
        for (const p of profs ?? []) gradeByStaff.set(p.id, p.grade ?? null);
      }

      // Bucket by ISO-week-start (Monday).
      const buckets = new Map<
        string,
        {
          total: number;
          wedAm: Set<string>;
          wedPm: Set<string>;
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
            consultant: 0,
            sas: 0,
            trainee: 0,
            unknown: 0,
          };
          buckets.set(k, b);
        }
        return b;
      };

      for (const a of assignments ?? []) {
        const sess = a.theatre_session_id
          ? sessionById.get(a.theatre_session_id)
          : null;
        if (!sess) continue;
        const d = parseDateLocal(a.session_date);
        if (!d) continue;
        const wk = fmtIso(weekStart(d));
        const b = ensure(wk);
        b.total += 1;
        const grade = a.staff_id ? gradeByStaff.get(a.staff_id) : null;
        if (grade === "consultant") b.consultant += 1;
        else if (grade === "sas") b.sas += 1;
        else if (grade === "trainee") b.trainee += 1;
        else b.unknown += 1;
        if (d.getDay() === 3) {
          if (a.session === "am") b.wedAm.add(a.staff_id);
          else if (a.session === "pm") b.wedPm.add(a.staff_id);
        }
      }

      const weeks: WeekRow[] = Array.from(buckets.entries())
        .map(([k, b]) => {
          const wedAm = b.wedAm.size;
          const wedPm = b.wedPm.size;
          const baseline = (wedAm > 0 ? 1 : 0) + (wedPm > 0 ? 1 : 0);
          const additional = Math.max(0, b.total - baseline);
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
          };
        })
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

      const totals = weeks.reduce(
        (acc, w) => ({
          total: acc.total + w.total,
          additional: acc.additional + w.additional,
          consultant: acc.consultant + w.consultant,
          sas: acc.sas + w.sas,
          trainee: acc.trainee + w.trainee,
          unknown: acc.unknown + w.unknown,
        }),
        { total: 0, additional: 0, consultant: 0, sas: 0, trainee: 0, unknown: 0 },
      );

      return { weeks, totals };
    },
  });

  const weeks = data?.weeks ?? [];
  const totals = data?.totals ?? {
    total: 0,
    additional: 0,
    consultant: 0,
    sas: 0,
    trainee: 0,
    unknown: 0,
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
          consultant on Wednesday AM and one on Wednesday PM.
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

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Weeks shown" value={weeks.length} />
        <SummaryCard label="Total POAC sessions" value={totals.total} tone="primary" />
        <SummaryCard
          label="Total additional sessions"
          value={totals.additional}
          tone="amber"
        />
      </div>

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
                          <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300">
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
        ? "text-amber-600 dark:text-amber-400"
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
