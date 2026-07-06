import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronLeft, FlaskConical } from "lucide-react";
import { addDaysISO, formatDateGB, cn } from "@/lib/utils";
import {
  computeRobustness, riskColor, type ExtraAbsence, type Grade,
} from "@/features/audit/robustness";

export const Route = createFileRoute("/_authenticated/robustness/simulate")({
  head: () => ({ meta: [{ title: "Robustness simulator — Salisbury Anaesthetics Rota" }] }),
  component: SimulatePage,
});

const WEEKS_VISIBLE = 4;

function SimulatePage() {
  const [offsetWeeks, setOffsetWeeks] = useState(0);
  const [extra, setExtra] = useState<Record<Grade, number>>({
    consultant: 0, sas: 0, trainee: 0, unknown: 0,
  });

  const { rangeStart, rangeEnd } = useMemo(() => ({
    rangeStart: addDaysISO(offsetWeeks * 7),
    rangeEnd: addDaysISO(offsetWeeks * 7 + WEEKS_VISIBLE * 7 - 1),
  }), [offsetWeeks]);

  const absences: ExtraAbsence[] = (Object.entries(extra) as [Grade, number][])
    .filter(([, n]) => n > 0)
    .map(([grade, count]) => ({ grade, count }));

  const baseline = useQuery({
    queryKey: ["robustness-base", rangeStart, rangeEnd],
    queryFn: () => computeRobustness(rangeStart, rangeEnd),
  });

  const sim = useQuery({
    queryKey: ["robustness-sim", rangeStart, rangeEnd, JSON.stringify(extra)],
    queryFn: () => computeRobustness(rangeStart, rangeEnd, absences),
  });

  const baseDays = baseline.data?.days ?? [];
  const simDays = sim.data?.days ?? [];

  // Compare per-date.
  const rows = baseDays.map((b) => {
    const s = simDays.find((x) => x.date === b.date);
    return { base: b, sim: s ?? b };
  });

  const newShortfalls = rows.filter(
    (r) =>
      (r.sim.am.risk === "shortfall" && r.base.am.risk !== "shortfall") ||
      (r.sim.pm.risk === "shortfall" && r.base.pm.risk !== "shortfall"),
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs">
            <Link to="/robustness" className="text-muted-foreground hover:underline">
              <ChevronLeft className="mr-1 inline h-3 w-3" />
              Back to robustness report
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-primary" />
            What-if simulator
          </h1>
          <p className="text-sm text-muted-foreground">
            Add hypothetical absences by staff group and see which days tip into
            shortfall in the next {WEEKS_VISIBLE} weeks.
          </p>
        </div>
        <Badge variant="secondary">
          {formatDateGB(rangeStart)} – {formatDateGB(rangeEnd)}
        </Badge>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scenario</CardTitle>
          <CardDescription>How many people are off, by staff group?</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-4">
          {(["consultant", "sas", "trainee"] as Grade[]).map((g) => (
            <div key={g} className="space-y-1">
              <Label className="capitalize text-xs">{g} off</Label>
              <Input
                type="number"
                min={0}
                value={extra[g]}
                onChange={(e) =>
                  setExtra((x) => ({ ...x, [g]: Math.max(0, Number(e.target.value) || 0) }))
                }
              />
            </div>
          ))}
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExtra({ consultant: 0, sas: 0, trainee: 0, unknown: 0 })}
            >
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks((o) => Math.max(0, o - WEEKS_VISIBLE))}>
          Earlier
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks(0)}>Today</Button>
        <Button variant="outline" size="sm" onClick={() => setOffsetWeeks((o) => o + WEEKS_VISIBLE)}>
          Later
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Impact summary</CardTitle>
          <CardDescription>
            {newShortfalls.length === 0
              ? "No new shortfall days under this scenario."
              : `${newShortfalls.length} day(s) tip from OK/tight into shortfall.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sim.isLoading || baseline.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No weekdays in range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Date</th>
                    <th className="px-2 py-1 text-center font-medium" colSpan={2}>AM headroom</th>
                    <th className="px-2 py-1 text-center font-medium" colSpan={2}>AM SPA <span className="font-normal opacity-70">(separate)</span></th>
                    <th className="px-2 py-1 text-center font-medium" colSpan={2}>PM headroom</th>
                    <th className="px-2 py-1 text-center font-medium" colSpan={2}>PM SPA <span className="font-normal opacity-70">(separate)</span></th>
                    <th className="px-2 py-1 text-left font-medium">Verdict</th>
                  </tr>
                  <tr>
                    <th />
                    <th className="px-2 text-[10px] font-normal">Base</th>
                    <th className="px-2 text-[10px] font-normal">Sim</th>
                    <th className="px-2 text-[10px] font-normal">Base</th>
                    <th className="px-2 text-[10px] font-normal">Sim</th>
                    <th className="px-2 text-[10px] font-normal">Base</th>
                    <th className="px-2 text-[10px] font-normal">Sim</th>
                    <th className="px-2 text-[10px] font-normal">Base</th>
                    <th className="px-2 text-[10px] font-normal">Sim</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ base, sim: s }) => {
                    const amTipped = s.am.risk === "shortfall" && base.am.risk !== "shortfall";
                    const pmTipped = s.pm.risk === "shortfall" && base.pm.risk !== "shortfall";
                    const verdict = amTipped || pmTipped
                      ? "New shortfall"
                      : s.am.risk === "shortfall" || s.pm.risk === "shortfall"
                      ? "Already at risk"
                      : s.am.risk === "tight" || s.pm.risk === "tight"
                      ? "Tight"
                      : "OK";
                    return (
                      <tr key={base.date} className="border-t">
                        <td className="px-2 py-1.5">{formatDateGB(base.date)}</td>
                        <td className="px-2 py-1.5 text-center">{base.am.headroom}</td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={cn("inline-block min-w-[2rem] rounded px-1.5 py-0.5 font-medium", riskColor(s.am.risk))}>
                            {s.am.headroom}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center text-orange-700">{base.am.consultantsOnSpa}</td>
                        <td className="px-2 py-1.5 text-center text-orange-700">{s.am.consultantsOnSpa}</td>
                        <td className="px-2 py-1.5 text-center">{base.pm.headroom}</td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={cn("inline-block min-w-[2rem] rounded px-1.5 py-0.5 font-medium", riskColor(s.pm.risk))}>
                            {s.pm.headroom}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-center text-orange-700">{base.pm.consultantsOnSpa}</td>
                        <td className="px-2 py-1.5 text-center text-orange-700">{s.pm.consultantsOnSpa}</td>
                        <td className={cn(
                          "px-2 py-1.5 font-medium",
                          verdict === "New shortfall" && "text-red-600",
                          verdict === "Already at risk" && "text-red-500/80",
                          verdict === "Tight" && "text-warning",
                        )}>
                          {verdict}
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
    </div>
  );
}
