import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, AlertTriangle, Activity, ChevronLeft, ChevronRight } from "lucide-react";
import { addDaysISO, formatDateGB, cn } from "@/lib/utils";
import { computeRobustness, riskColor, riskLabel } from "@/lib/audit/robustness";

export const Route = createFileRoute("/_authenticated/robustness/")({
  component: RobustnessPage,
});

const WEEKS_VISIBLE = 12;

function RobustnessPage() {
  const [offsetWeeks, setOffsetWeeks] = useState(0);

  const { rangeStart, rangeEnd } = useMemo(() => ({
    rangeStart: addDaysISO(offsetWeeks * 7),
    rangeEnd: addDaysISO(offsetWeeks * 7 + WEEKS_VISIBLE * 7 - 1),
  }), [offsetWeeks]);

  const { data, isLoading } = useQuery({
    queryKey: ["robustness", rangeStart, rangeEnd],
    queryFn: () => computeRobustness(rangeStart, rangeEnd),
  });

  const days = data?.days ?? [];
  const flagged = days.filter((d) => d.am.risk !== "ok" || d.pm.risk !== "ok");
  const shortfalls = days.filter((d) => d.am.risk === "shortfall" || d.pm.risk === "shortfall");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rota robustness</h1>
          <p className="text-sm text-muted-foreground">
            Forward-looking coverage headroom for the next {WEEKS_VISIBLE} weeks.
            Headroom = consultants + ST6/7 trainees available, minus theatre lists.
            On-call, ICU, obstetrics, teaching, admin, leave and LTFT days are excluded.
          </p>
        </div>
        <Badge variant="secondary">{formatDateGB(rangeStart)} – {formatDateGB(rangeEnd)}</Badge>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks((o) => o - WEEKS_VISIBLE)}>
          <ChevronLeft className="mr-1 h-4 w-4" /> Earlier
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks(0)}>Today</Button>
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks((o) => o + WEEKS_VISIBLE)}>
          Later <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
        <div className="ml-auto">
          <Button asChild size="sm">
            <Link to="/robustness/simulate">Run what-if simulation</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Days flagged" value={flagged.length} icon={AlertTriangle} tone="amber" />
        <Stat label="Days with shortfall" value={shortfalls.length} icon={ShieldAlert} tone="red" />
        <Stat
          label="Workforce (active)"
          value={data
            ? Object.values(data.totalStaffByGrade).reduce((a, b) => a + b, 0)
            : "—"}
          icon={Activity}
          tone="emerald"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily coverage headroom</CardTitle>
          <CardDescription>
            Each cell shows available staff minus lists needing cover.
            Green = comfortable, amber = tight, red = shortfall.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : days.length === 0 ? (
            <div className="text-sm text-muted-foreground">No weekdays in range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Date</th>
                    <th className="px-2 py-1 text-left font-medium">On leave</th>
                    <th className="px-2 py-1 text-center font-medium">AM lists</th>
                    <th className="px-2 py-1 text-center font-medium">AM headroom</th>
                    <th className="px-2 py-1 text-center font-medium">PM lists</th>
                    <th className="px-2 py-1 text-center font-medium">PM headroom</th>
                    <th className="px-2 py-1 text-left font-medium">Unfilled</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.date} className="border-t">
                      <td className="px-2 py-1.5">
                        <Link
                          to="/robustness/day/$date"
                          params={{ date: d.date }}
                          className="text-primary hover:underline"
                        >
                          {formatDateGB(d.date)}
                        </Link>
                      </td>

                      <td className="px-2 py-1.5 text-muted-foreground">{d.am.onLeave}</td>
                      <td className="px-2 py-1.5 text-center">{d.am.required}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={cn("inline-block min-w-[2.5rem] rounded px-2 py-0.5 font-medium", riskColor(d.am.risk))}>
                          {d.am.headroom}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-center">{d.pm.required}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={cn("inline-block min-w-[2.5rem] rounded px-2 py-0.5 font-medium", riskColor(d.pm.risk))}>
                          {d.pm.headroom}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground">
                        {d.am.unfilled + d.pm.unfilled > 0
                          ? `${d.am.unfilled + d.pm.unfilled} session(s)`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        This is a first-pass model: available = active staff minus approved leave
        and LTFT days off. Fixed commitments, on-call rest, and SPA reallocation
        will refine future versions.
      </p>
    </div>
  );
}

function Stat({
  label, value, icon: Icon, tone,
}: {
  label: string;
  value: number | string;
  icon: typeof Activity;
  tone: "amber" | "red" | "emerald";
}) {
  const toneClass = tone === "red"
    ? "bg-red-500/10 text-red-600"
    : tone === "amber"
    ? "bg-amber-500/10 text-amber-600"
    : "bg-emerald-500/10 text-emerald-600";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-md", toneClass)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
