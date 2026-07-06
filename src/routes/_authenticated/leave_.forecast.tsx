import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClipboardList, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { todayISO, addDaysISO, formatDateGB, cn } from "@/lib/utils";
import { loadLeavePressure, pressureColor, type DayPressure } from "@/features/audit/leave-pressure";
import { LeaveMonthlyCalendar } from "@/components/leave-monthly-calendar";

export const Route = createFileRoute("/_authenticated/leave_/forecast")({
  head: () => ({ meta: [{ title: "Leave forecast — Salisbury Anaesthetics Rota" }] }),
  component: LeaveForecastPage,
});

const WEEKS_VISIBLE = 16;

function LeaveForecastPage() {
  const [offsetWeeks, setOffsetWeeks] = useState(0);

  // Start window on the Monday of "today + offset weeks".
  const { rangeStart, rangeEnd } = useMemo(() => {
    const start = addDaysISO(offsetWeeks * 7);
    const end = addDaysISO(offsetWeeks * 7 + WEEKS_VISIBLE * 7 - 1);
    return { rangeStart: start, rangeEnd: end };
  }, [offsetWeeks]);

  const { data, isLoading } = useQuery({
    queryKey: ["leave-pressure", rangeStart, rangeEnd],
    queryFn: () => loadLeavePressure(rangeStart, rangeEnd),
  });

  const days = data?.days ?? [];
  const weeks = data?.weeks ?? [];

  // Overall peak for colour scaling.
  const peak = days.reduce((m, d) => Math.max(m, d.total), 0);

  // Top 10 highest-pressure weeks.
  const topWeeks = [...weeks].sort((a, b) => b.total - a.total).slice(0, 10);

  // Per-grade totals across the visible range.
  const gradeTotals = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const d of days) {
      for (const [g, n] of Object.entries(d.byGrade)) {
        acc[g] = (acc[g] ?? 0) + n;
      }
    }
    return acc;
  }, [days]);

  // Group days by ISO week (Mon..Fri) for the heatmap.
  const weekGroups = useMemo(() => {
    const map = new Map<string, DayPressure[]>();
    for (const d of days) {
      const dow = new Date(d.date + "T00:00:00Z").getUTCDay();
      const diff = dow === 0 ? -6 : 1 - dow;
      const m = new Date(d.date + "T00:00:00Z");
      m.setUTCDate(m.getUTCDate() + diff);
      const wk = m.toISOString().slice(0, 10);
      const arr = map.get(wk) ?? [];
      arr.push(d);
      map.set(wk, arr);
    }
    return [...map.entries()]
      .map(([wk, ds]) => ({ wk, ds: ds.sort((a, b) => (a.date < b.date ? -1 : 1)) }))
      .sort((a, b) => (a.wk < b.wk ? -1 : 1));
  }, [days]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leave pressure forecast</h1>
          <p className="text-sm text-muted-foreground">
            Approved + pending leave across the next {WEEKS_VISIBLE} weeks. Use this to
            spot surge weeks before they bite.
          </p>
        </div>
        <Badge variant="secondary">{formatDateGB(rangeStart)} – {formatDateGB(rangeEnd)}</Badge>
      </header>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks((o) => o - WEEKS_VISIBLE)}>
          <ChevronLeft className="mr-1 h-4 w-4" /> Earlier
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks(0)}>
          Today
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks((o) => o + WEEKS_VISIBLE)}>
          Later <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>

      <LeaveMonthlyCalendar />

      {/* Heatmap */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly heatmap</CardTitle>
          <CardDescription>
            Each cell shows the number of staff on leave that weekday. Hover for names.
            Peak this window: {peak}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[110px_repeat(5,minmax(0,1fr))] gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                <div />
                <div className="text-center">Mon</div>
                <div className="text-center">Tue</div>
                <div className="text-center">Wed</div>
                <div className="text-center">Thu</div>
                <div className="text-center">Fri</div>
              </div>
              {weekGroups.map(({ wk, ds }) => (
                <div key={wk} className="grid grid-cols-[110px_repeat(5,minmax(0,1fr))] gap-1">
                  <div className="flex items-center px-2 text-xs text-muted-foreground">
                    w/c {formatDateGB(wk)}
                  </div>
                  {[1, 2, 3, 4, 5].map((dow) => {
                    const cell = ds.find(
                      (d) => new Date(d.date + "T00:00:00Z").getUTCDay() === dow,
                    );
                    if (!cell) return <div key={dow} className="h-9 rounded bg-muted/20" />;
                    return (
                      <div
                        key={dow}
                        title={`${formatDateGB(cell.date)}\n${cell.total} on leave${cell.names.length ? `\n${cell.names.join(", ")}` : ""}`}
                        className={cn(
                          "flex h-9 items-center justify-center rounded text-xs font-medium",
                          pressureColor(cell.total, peak || 1),
                        )}
                      >
                        {cell.total > 0 ? cell.total : ""}
                      </div>
                    );
                  })}
                </div>
              ))}
              <LegendBar peak={peak} />
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Top weeks */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Highest-pressure weeks
            </CardTitle>
            <CardDescription>Sorted by total weekday-staff-days lost.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {topWeeks.length === 0 && (
              <div className="text-sm text-muted-foreground">No leave booked in this window.</div>
            )}
            {topWeeks.map((w) => (
              <div key={w.weekStart} className="flex items-center justify-between rounded-md border p-2 text-sm">
                <div>
                  <div className="font-medium">w/c {formatDateGB(w.weekStart)}</div>
                  <div className="text-xs text-muted-foreground">
                    Peak {w.peak} on {formatDateGB(w.peakDay)}
                  </div>
                </div>
                <Badge variant={w.peak >= (peak * 0.65) ? "destructive" : "secondary"}>
                  {w.total} off-days
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Grade mix */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              By staff group
            </CardTitle>
            <CardDescription>Total off-days across the visible window.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(gradeTotals).length === 0 && (
              <div className="text-sm text-muted-foreground">No data.</div>
            )}
            {Object.entries(gradeTotals)
              .sort((a, b) => b[1] - a[1])
              .map(([grade, n]) => {
                const total = Object.values(gradeTotals).reduce((a, b) => a + b, 0) || 1;
                const pct = Math.round((n / total) * 100);
                return (
                  <div key={grade} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize">{grade}</span>
                      <span className="text-muted-foreground">{n} ({pct}%)</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded bg-muted">
                      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
          </CardContent>
        </Card>
      </div>

      <div className="text-xs text-muted-foreground">
        <Link to="/leave" className="underline">Back to leave</Link>
        {" · "}
        Weekends excluded. Pending leave is included so you can pre-empt approval pressure.
      </div>
    </div>
  );
}

function LegendBar({ peak }: { peak: number }) {
  if (peak <= 0) return null;
  return (
    <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
      <span>Less</span>
      <div className="h-2 w-4 rounded bg-emerald-300/50" />
      <div className="h-2 w-4 rounded bg-yellow-300/60" />
      <div className="h-2 w-4 rounded bg-amber-400/70" />
      <div className="h-2 w-4 rounded bg-orange-500/70" />
      <div className="h-2 w-4 rounded bg-red-500/80" />
      <span>More (peak {peak})</span>
    </div>
  );
}
