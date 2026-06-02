import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShieldAlert, AlertTriangle, Activity, ChevronLeft, ChevronRight, Info } from "lucide-react";
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
    <TooltipProvider>
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
          <div className="ml-auto flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/robustness/list-feasibility">Regular-list feasibility</Link>
            </Button>
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

        {/* Legend */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              Legend & definitions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex flex-wrap gap-3">
              <LegendItem color="bg-emerald-300/50" label="OK" description="Enough solo-capable staff to cover all lists." />
              <LegendItem color="bg-amber-400/80" label="Tight" description="Headroom ≤ 1 — little buffer for unexpected absence." />
              <LegendItem color="bg-orange-400/80 text-white" label="SPA needed" description="Not enough solo-capable staff; a consultant on SPA would need to be pulled onto a list." />
              <LegendItem color="bg-red-500/80 text-white" label="Shortfall" description="Even with all SPA consultants redeployed, there are not enough staff to cover lists." />
            </div>
            <div className="rounded-md bg-muted/40 p-2.5 text-muted-foreground">
              <strong className="text-foreground">Who is counted as available?</strong>{" "}
              Consultants and trainees who are <em>not</em> on approved leave, LTFT day off, on-call, ICU, obstetrics, teaching, admin or CIC duties, <em>and</em> who are <em>not</em> already covering a clinical list (theatre, POAC, pain clinic or any other theatre_session). ST6/ST7/ST8 trainees count as solo-capable; junior trainees and SAS doctors are shown for context but do <em>not</em> count toward headroom. Consultants on SPA are reported separately — they only close the gap as flexible cover.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily coverage headroom</CardTitle>
            <CardDescription>
              Each cell shows the spare solo-capable headroom, with a breakdown underneath: <span className="font-mono">consultants · SPA · senior trainees</span>. Click a date to see the full breakdown.
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
                      <ThTooltip label="Off" tooltip="Staff on approved leave (annual, study, sick) — excluded from availability." />
                      <ThTooltip label="Other duties" tooltip="Staff on on-call, ICU, obstetrics, teaching, admin or CIC — excluded from availability." />
                      <th className="px-2 py-1 text-center font-medium">AM lists</th>
                      <ThTooltip label="AM unfilled" tooltip="Theatre lists with no anaesthetist assigned (AM)." />
                      <ThTooltip label="AM headroom" tooltip="Spare solo-capable staff after covering every unfilled list. Subscript shows free consultants · consultants on SPA · free senior trainees (ST6/7/8). Staff already on a list, ICU, obstetrics or any other clinical duty are excluded." />
                      <th className="px-2 py-1 text-center font-medium">PM lists</th>
                      <ThTooltip label="PM unfilled" tooltip="Theatre lists with no anaesthetist assigned (PM)." />
                      <ThTooltip label="PM headroom" tooltip="Spare solo-capable staff after covering every unfilled list. Subscript shows free consultants · consultants on SPA · free senior trainees (ST6/7/8). Staff already on a list, ICU, obstetrics or any other clinical duty are excluded." />
                      <th className="px-2 py-1 text-left font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => {
                      const spa = d.am.consultantsOnSpa + d.pm.consultantsOnSpa;
                      const unfilled = d.am.unfilled + d.pm.unfilled;
                      const notes: string[] = [];
                      if (unfilled > 0) notes.push(`${unfilled} unfilled`);
                      if (d.am.risk === "spa_required" || d.pm.risk === "spa_required") {
                        notes.push("SPA cover needed");
                      } else if (spa > 0) {
                        notes.push(`${spa} on SPA (flex)`);
                      }
                      const renderCell = (h: typeof d.am) => (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex flex-col items-center gap-0.5 cursor-help">
                              <span className={cn("inline-block min-w-[2.5rem] rounded px-2 py-0.5 font-medium", riskColor(h.risk))}>
                                {h.headroom}
                              </span>
                              <span className="text-[10px] leading-none text-muted-foreground tabular-nums">
                                {h.consultantsAvailable}c · {h.consultantsOnSpa}s · {h.seniorTraineesAvailable}t
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p className="max-w-[18rem]">
                              {riskLabel(h.risk)} — {h.soloCapable} solo-capable free vs {h.unfilled} unfilled list(s).
                              <br />
                              <span className="text-muted-foreground">
                                Free consultants: {h.consultantsAvailable} ·
                                Consultants on SPA: {h.consultantsOnSpa} ·
                                Free senior trainees: {h.seniorTraineesAvailable} ·
                                Junior trainees: {h.juniorTraineesAvailable} ·
                                SAS: {h.sasAvailable}
                                <br />
                                Staff already covering theatre, POAC, pain clinic or any other clinical activity — and anyone on ICU, obstetrics, on-call, teaching, admin or CIC — are excluded from these counts.
                              </span>
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      );
                      return (
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
                          <td className="px-2 py-1.5 text-center text-muted-foreground">{d.am.onLeave}</td>
                          <td className="px-2 py-1.5 text-center text-muted-foreground">{d.am.onOtherDuty}</td>
                          <td className="px-2 py-1.5 text-center">{d.am.required}</td>
                          <td className="px-2 py-1.5 text-center">
                            <UnfilledBadge count={d.am.unfilled} />
                          </td>
                          <td className="px-2 py-1.5 text-center">{renderCell(d.am)}</td>
                          <td className="px-2 py-1.5 text-center">{d.pm.required}</td>
                          <td className="px-2 py-1.5 text-center">
                            <UnfilledBadge count={d.pm.unfilled} />
                          </td>
                          <td className="px-2 py-1.5 text-center">{renderCell(d.pm)}</td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground">
                            {notes.length === 0 ? "—" : notes.join(" · ")}
                          </td>
                        </tr>
                      );
                    })}
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
    </TooltipProvider>
  );
}

function ThTooltip({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <th className="px-2 py-1 text-center font-medium">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-1">
            {label}
            <Info className="h-3 w-3 text-muted-foreground/60" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="max-w-[16rem]">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </th>
  );
}

function LegendItem({ color, label, description }: { color: string; label: string; description: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("inline-block h-3 w-3 rounded-sm", color)} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">— {description}</span>
    </div>
  );
}

type StatProps = {
  label: string;
  value: number | string;
  icon: typeof Activity;
  tone: "amber" | "red" | "emerald";
};

function UnfilledBadge({ count }: { count: number }) {
  if (count === 0) return <span className="text-muted-foreground">0</span>;
  return (
    <span className="inline-flex items-center justify-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
      {count}
    </span>
  );
}

function Stat(props: StatProps) {
  const { label, value, tone } = props;
  const Icon = props.icon;
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
