import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronLeft, Info, Users, AlertTriangle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  computeListFeasibility,
  DEFAULT_THRESHOLDS,
  DOW_LABEL,
  type DepartmentSummary,
  type FeasibilityThresholds,
  type ListSlotFeasibility,
  type Verdict,
} from "@/lib/audit/list-feasibility";

export const Route = createFileRoute("/_authenticated/robustness/list-feasibility")({
  component: ListFeasibilityPage,
});

function ListFeasibilityPage() {
  const [monthsBack, setMonthsBack] = useState(6);
  const [thresholds, setThresholds] = useState<FeasibilityThresholds>(DEFAULT_THRESHOLDS);

  const { data, isLoading } = useQuery({
    queryKey: ["list-feasibility", monthsBack, JSON.stringify(thresholds)],
    queryFn: () => computeListFeasibility({ monthsBack, thresholds }),
  });

  const summary = data?.summary;
  const slots = data?.slots ?? [];

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <header className="space-y-1">
          <div className="text-xs">
            <Link to="/robustness" className="text-muted-foreground hover:underline">
              <ChevronLeft className="mr-1 inline h-3 w-3" />
              Back to robustness report
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            Regular-list feasibility
          </h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            For every recurring surgical list in the last {monthsBack} months,
            this model asks: <em>if we named one consultant as its regular
            owner, would current staffing, leave and on-call patterns
            actually let them be there?</em> Outputs a per-list verdict and
            an estimate of extra consultant WTE needed to make all the
            "not feasible" slots work.
          </p>
        </header>

        <ThresholdControls
          monthsBack={monthsBack}
          setMonthsBack={setMonthsBack}
          thresholds={thresholds}
          setThresholds={setThresholds}
        />

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Modelling…</div>
        ) : !summary ? (
          <div className="text-sm text-muted-foreground">No data.</div>
        ) : (
          <>
            <DepartmentSummaryCard summary={summary} />
            <SlotsTable slots={slots} />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

function ThresholdControls({
  monthsBack,
  setMonthsBack,
  thresholds,
  setThresholds,
}: {
  monthsBack: number;
  setMonthsBack: (n: number) => void;
  thresholds: FeasibilityThresholds;
  setThresholds: (t: FeasibilityThresholds) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Feasibility bar</CardTitle>
        <CardDescription>
          Tune the rules for what counts as a workable regular assignment.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label className="text-xs flex items-center justify-between">
            Owner present ≥
            <span className="font-mono">{thresholds.ownerPresentMinPct}%</span>
          </Label>
          <Slider
            min={50}
            max={100}
            step={5}
            value={[thresholds.ownerPresentMinPct]}
            onValueChange={([v]) =>
              setThresholds({ ...thresholds, ownerPresentMinPct: v })
            }
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs flex items-center justify-between">
            Owner or deputy ≥
            <span className="font-mono">{thresholds.ownerOrDeputyMinPct}%</span>
          </Label>
          <Slider
            min={70}
            max={100}
            step={5}
            value={[thresholds.ownerOrDeputyMinPct]}
            onValueChange={([v]) =>
              setThresholds({ ...thresholds, ownerOrDeputyMinPct: v })
            }
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Min recurrences to count</Label>
          <Input
            type="number"
            min={2}
            max={26}
            value={thresholds.minOccurrences}
            onChange={(e) =>
              setThresholds({
                ...thresholds,
                minOccurrences: Math.max(2, Number(e.target.value) || 4),
              })
            }
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">History window (months)</Label>
          <Input
            type="number"
            min={1}
            max={24}
            value={monthsBack}
            onChange={(e) => setMonthsBack(Math.max(1, Number(e.target.value) || 6))}
          />
        </div>
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-4">
          <Switch
            id="forbid-shortfall"
            checked={thresholds.forbidNewShortfalls}
            onCheckedChange={(v) =>
              setThresholds({ ...thresholds, forbidNewShortfalls: v })
            }
          />
          <Label htmlFor="forbid-shortfall" className="text-xs">
            Reject slots that would tip a day into shortfall if the owner
            were locked here.
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3 w-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent>
              Heuristic: counts occurrences where the owner was free but
              another consultant covered, AND that day had very thin
              consultant capacity overall.
            </TooltipContent>
          </Tooltip>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setThresholds(DEFAULT_THRESHOLDS)}
          >
            Reset to defaults
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DepartmentSummaryCard({ summary }: { summary: DepartmentSummary }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Department summary</CardTitle>
        <CardDescription>
          {summary.totalSlots} recurring list slot(s) detected between{" "}
          {summary.windowStart} and {summary.windowEnd}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Feasible"
          value={summary.feasible}
          tone="emerald"
          icon={CheckCircle2}
        />
        <Stat
          label="Borderline"
          value={summary.borderline}
          tone="amber"
          icon={AlertTriangle}
        />
        <Stat
          label="Not feasible"
          value={summary.notFeasible}
          tone="red"
          icon={AlertTriangle}
        />
        <Stat
          label="Extra consultant WTE needed"
          value={summary.estimatedExtraWte.toFixed(1)}
          tone={summary.estimatedExtraWte > 0 ? "red" : "emerald"}
          icon={Users}
          help="Rough estimate: each unfilled regular slot ≈ 0.1 WTE per session/week. Add 1 WTE per ~10 missing weekly sessions."
        />
      </CardContent>
    </Card>
  );
}

function SlotsTable({ slots }: { slots: ListSlotFeasibility[] }) {
  if (slots.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No recurring lists matched the minimum-occurrence filter.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Per-list verdict</CardTitle>
        <CardDescription>
          Sorted with the least-feasible slots at the top.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Slot</th>
              <th className="px-2 py-1 text-left font-medium">Surgeon</th>
              <th className="px-2 py-1 text-left font-medium">Proposed owner</th>
              <th className="px-2 py-1 text-center font-medium">Owner %</th>
              <th className="px-2 py-1 text-left font-medium">Deputy</th>
              <th className="px-2 py-1 text-center font-medium">+Deputy %</th>
              <th className="px-2 py-1 text-center font-medium">n</th>
              <th className="px-2 py-1 text-left font-medium">Verdict</th>
              <th className="px-2 py-1 text-left font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => (
              <tr key={s.key} className="border-t align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span className="font-medium">{DOW_LABEL[s.dow]}</span>{" "}
                  <span className="uppercase text-muted-foreground">{s.session}</span>
                  <div className="text-[10px] text-muted-foreground">{s.theatreName}</div>
                </td>
                <td className="px-2 py-1.5">{s.surgeon}</td>
                <td className="px-2 py-1.5">
                  {s.ownerName ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-2 py-1.5 text-center font-mono">{s.ownerPresentPct}%</td>
                <td className="px-2 py-1.5">
                  {s.deputyName ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-2 py-1.5 text-center font-mono">{s.ownerOrDeputyPct}%</td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">{s.occurrences}</td>
                <td className="px-2 py-1.5">
                  <VerdictBadge verdict={s.verdict} />
                </td>
                <td className="px-2 py-1.5 text-muted-foreground max-w-[24rem]">
                  {s.reasons.length === 0 ? (
                    <span className="text-emerald-700">All thresholds met.</span>
                  ) : (
                    <ul className="list-disc pl-4 space-y-0.5">
                      {s.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {(s.ownerUnavailable > 0 || s.ownerFreeButReplaced > 0) && (
                    <div className="mt-1 text-[10px]">
                      {s.ownerUnavailable > 0 && (
                        <span>Owner unavailable: {s.ownerUnavailable}. </span>
                      )}
                      {s.ownerFreeButReplaced > 0 && (
                        <span>Free but replaced: {s.ownerFreeButReplaced}.</span>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}


function VerdictBadge({ verdict }: { verdict: Verdict }) {
  if (verdict === "feasible") {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
        Feasible
      </Badge>
    );
  }
  if (verdict === "borderline") {
    return (
      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
        Borderline
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-100 text-red-700 hover:bg-red-100">
      Not feasible
    </Badge>
  );
}

function Stat({
  label,
  value,
  tone,
  icon: Icon,
  help,
}: {
  label: string;
  value: number | string;
  tone: "emerald" | "amber" | "red";
  icon: typeof Users;
  help?: string;
}) {
  const toneClass =
    tone === "red"
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
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            {label}
            {help && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground/60" />
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-[18rem]">{help}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
