import { createFileRoute, Navigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageLoading } from "@/components/loading";
import { StatCard } from "@/components/stat-card";
import { HeartPulse, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { compareBySurname } from "@/lib/name-sort";
import { formatDateWithWeekdayGB } from "@/lib/utils";
import { RTWInterviewDialog } from "@/components/absence/RTWInterviewDialog";
import {
  summariseAbsence,
  type AbsenceSummary,
  type RtwRow,
  type SickSpellRow,
} from "@/features/absence/absence-summary";
import { BAND_THRESHOLDS, type BradfordBand } from "@/lib/bradford-factor";

export const Route = createFileRoute("/_authenticated/admin/absence")({
  head: () => ({
    meta: [
      { title: "Absence & Bradford Factor — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Sickness monitoring: Bradford Factor league table, patterns and Return-to-Work interview status.",
      },
    ],
  }),
  component: AdminAbsencePage,
});

type BandFilter = "all" | BradfordBand;

const BAND_ORDER: BradfordBand[] = ["critical", "red", "amber", "green"];
const BAND_TONE: Record<BradfordBand, string> = {
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  red: "bg-orange-500/20 text-orange-700 dark:text-orange-300",
  critical: "bg-destructive/15 text-destructive",
};

function AdminAbsencePage() {
  const { hasRole, loading } = useAuth();
  const [bandFilter, setBandFilter] = useState<BandFilter>("all");
  const [q, setQ] = useState("");
  const [openRtw, setOpenRtw] = useState<{
    staffId: string;
    staffName: string | null;
    leaveRequestId: string;
    spellStart: string;
    spellEnd: string;
  } | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-absence"],
    queryFn: async () => {
      const [profilesRes, leaveRes, rtwRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id,full_name,email,grade,active,left_at")
          .eq("active", true),
        supabase
          .from("leave_requests")
          .select("id,staff_id,type,status,start_date,end_date,half_day_start,half_day_end")
          .eq("type", "sick")
          .eq("status", "approved")
          .range(0, 9999),
        supabase
          .from("return_to_work_interviews")
          .select("leave_request_id,conducted_at,fitness_confirmed,follow_up_required,follow_up_date")
          .range(0, 9999),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (rtwRes.error) throw rtwRes.error;
      return {
        profiles: profilesRes.data ?? [],
        spells: (leaveRes.data ?? []) as SickSpellRow[],
        rtws: (rtwRes.data ?? []) as RtwRow[],
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    return data.profiles
      .map((p) => {
        const staffSpells = data.spells.filter((s) => s.staff_id === p.id);
        const staffRtws = data.rtws.filter((r) =>
          staffSpells.some((s) => s.id === r.leave_request_id),
        );
        const summary = summariseAbsence(staffSpells, staffRtws);
        return {
          id: p.id,
          name: p.full_name || p.email || "Unknown",
          grade: p.grade,
          summary,
        };
      })
      .filter((r) => r.summary.bradford.spellCount > 0)
      .sort((a, b) => b.summary.bradford.score - a.summary.bradford.score);
  }, [data]);

  const bandCounts = useMemo(() => {
    const counts: Record<BradfordBand, number> = { green: 0, amber: 0, red: 0, critical: 0 };
    for (const r of rows) counts[r.summary.bradford.band] += 1;
    return counts;
  }, [rows]);

  const totalOpenRtw = rows.reduce((n, r) => n + r.summary.openRtwCount, 0);
  const totalOverdue = rows.reduce((n, r) => n + r.summary.overdueRtwCount, 0);

  const filteredRows = rows.filter((r) => {
    if (bandFilter !== "all" && r.summary.bradford.band !== bandFilter) return false;
    if (q && !r.name.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Absence & Bradford Factor"
        description="Rolling 12-month sickness scoring (S² × D). Highlights patterns that a single-metric view misses — e.g. many short spells that add up to a manageable day count but a high Bradford score."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Staff with sickness (12m)" value={rows.length} icon={HeartPulse} />
        <StatCard
          label="Red / critical"
          value={bandCounts.red + bandCounts.critical}
          icon={AlertTriangle}
        />
        <StatCard label="Open RTW interviews" value={totalOpenRtw} icon={Clock} />
        <StatCard label="Overdue RTW" value={totalOverdue} icon={AlertTriangle} />
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name…"
              className="max-w-xs"
            />
            <Select value={bandFilter} onValueChange={(v) => setBandFilter(v as BandFilter)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All bands</SelectItem>
                {BAND_ORDER.map((b) => (
                  <SelectItem key={b} value={b}>
                    {BAND_THRESHOLDS[b].label} ({bandCounts[b]})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto text-xs text-muted-foreground">
              {filteredRows.length} of {rows.length} staff shown
            </div>
          </div>

          {isLoading ? (
            <PageLoading />
          ) : filteredRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No sickness spells match the current filter.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Spells (12m)</TableHead>
                  <TableHead className="text-right">Days (12m)</TableHead>
                  <TableHead className="text-right">Bradford</TableHead>
                  <TableHead>Band</TableHead>
                  <TableHead>Patterns</TableHead>
                  <TableHead>RTW</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <AbsenceRow
                    key={r.id}
                    id={r.id}
                    name={r.name}
                    grade={r.grade}
                    summary={r.summary}
                    onLogRtw={(spell) =>
                      setOpenRtw({
                        staffId: r.id,
                        staffName: r.name,
                        leaveRequestId: spell.id,
                        spellStart: spell.start_date,
                        spellEnd: spell.end_date,
                      })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openRtw ? (
        <RTWInterviewDialog
          open
          onOpenChange={(o) => {
            if (!o) setOpenRtw(null);
          }}
          onSaved={() => {
            setOpenRtw(null);
            void refetch();
          }}
          staffId={openRtw.staffId}
          staffName={openRtw.staffName}
          leaveRequestId={openRtw.leaveRequestId}
          spellStart={openRtw.spellStart}
          spellEnd={openRtw.spellEnd}
        />
      ) : null}
    </div>
  );
}

function AbsenceRow({
  id,
  name,
  grade,
  summary,
  onLogRtw,
}: {
  id: string;
  name: string;
  grade: string | null;
  summary: AbsenceSummary;
  onLogRtw: (spell: { id: string; start_date: string; end_date: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const openSpell = summary.spells.find((s) => s.rtwStatus !== "completed");
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setExpanded((e) => !e)}>
        <TableCell className="font-medium">
          <Link
            to="/trainees/$staffId"
            params={{ staffId: id }}
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {name}
          </Link>
        </TableCell>
        <TableCell className="capitalize text-muted-foreground">{grade ?? "—"}</TableCell>
        <TableCell className="text-right">{summary.bradford.spellCount}</TableCell>
        <TableCell className="text-right">{summary.bradford.totalDays}</TableCell>
        <TableCell className="text-right font-semibold">{summary.bradford.score}</TableCell>
        <TableCell>
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_TONE[summary.bradford.band]}`}
          >
            {BAND_THRESHOLDS[summary.bradford.band].label}
          </span>
        </TableCell>
        <TableCell className="space-x-1">
          {summary.frequentShortSpells ? (
            <Badge variant="outline" className="text-xs">
              Frequent short
            </Badge>
          ) : null}
          {summary.spells.some((s) => s.postWeekend) ? (
            <Badge variant="outline" className="text-xs">
              Post-weekend
            </Badge>
          ) : null}
        </TableCell>
        <TableCell>
          {summary.overdueRtwCount > 0 ? (
            <Badge variant="destructive">{summary.overdueRtwCount} overdue</Badge>
          ) : summary.openRtwCount > 0 ? (
            <Badge variant="secondary">{summary.openRtwCount} open</Badge>
          ) : (
            <Badge variant="default" className="gap-1">
              <CheckCircle2 className="h-3 w-3" /> up to date
            </Badge>
          )}
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/30">
            <div className="space-y-2 py-2">
              <p className="text-xs text-muted-foreground">
                Bradford window: {summary.bradford.windowStart} → {summary.bradford.windowEnd}.{" "}
                Score band: {BAND_THRESHOLDS[summary.bradford.band].action}.
              </p>
              <ul className="space-y-1 text-sm">
                {summary.spells.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background px-3 py-2"
                  >
                    <span>
                      {formatDateWithWeekdayGB(s.start_date)} → {formatDateWithWeekdayGB(s.end_date)}{" "}
                      · {s.days}d
                      {s.postWeekend ? (
                        <Badge variant="outline" className="ml-2 text-xs">
                          Post-weekend
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2">
                      {s.rtwStatus === "completed" ? (
                        <Badge variant="default" className="gap-1">
                          <CheckCircle2 className="h-3 w-3" /> RTW done
                        </Badge>
                      ) : s.rtwStatus === "overdue" ? (
                        <Badge variant="destructive">RTW overdue</Badge>
                      ) : (
                        <Badge variant="secondary">RTW pending</Badge>
                      )}
                      {s.rtwStatus !== "completed" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            onLogRtw({
                              id: s.id,
                              start_date: s.start_date,
                              end_date: s.end_date,
                            })
                          }
                        >
                          Log RTW
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {openSpell ? null : (
                <p className="text-xs text-muted-foreground">All RTW interviews recorded.</p>
              )}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
