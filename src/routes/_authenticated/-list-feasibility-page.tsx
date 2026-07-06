import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ChevronLeft, Info, Users } from "lucide-react";
import {
  computeListFeasibility,
  DEFAULT_THRESHOLDS,
  type FeasibilityThresholds,
} from "@/features/audit/list-feasibility";
import {
  DepartmentSummaryCard,
  SlotsTable,
  AssumptionsCard,
} from "./-list-feasibility-summary";
import { WorkingPatternsCard } from "./-list-feasibility-working-patterns";
import { ValidationCard } from "./-list-feasibility-validation";

export function ListFeasibilityPage() {
  // "Applied" state — what the query actually runs against.
  const [appliedMonths, setAppliedMonths] = useState(6);
  const [appliedThresholds, setAppliedThresholds] =
    useState<FeasibilityThresholds>(DEFAULT_THRESHOLDS);

  // "Draft" state — what the controls show. Changes only take effect on Recalculate.
  const [draftMonths, setDraftMonths] = useState(6);
  const [draftThresholds, setDraftThresholds] =
    useState<FeasibilityThresholds>(DEFAULT_THRESHOLDS);

  const dirty =
    draftMonths !== appliedMonths ||
    JSON.stringify(draftThresholds) !== JSON.stringify(appliedThresholds);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["list-feasibility", appliedMonths, JSON.stringify(appliedThresholds)],
    queryFn: () =>
      computeListFeasibility({ monthsBack: appliedMonths, thresholds: appliedThresholds }),
  });

  const applyDraft = () => {
    setAppliedMonths(draftMonths);
    setAppliedThresholds(draftThresholds);
  };
  const resetDraft = () => {
    setDraftMonths(6);
    setDraftThresholds(DEFAULT_THRESHOLDS);
  };

  const summary = data?.summary;
  const slots = data?.slots ?? [];
  const consultantPatterns = data?.consultantPatterns ?? [];

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
            For every recurring surgical list in the last {appliedMonths} months,
            this model asks: <em>if we named one consultant as its regular
            owner, would current staffing, leave and on-call patterns
            actually let them be there?</em> Outputs a per-list verdict and
            an estimate of extra consultant WTE needed to make all the
            "not feasible" slots work.
          </p>
        </header>

        <ThresholdControls
          monthsBack={draftMonths}
          setMonthsBack={setDraftMonths}
          thresholds={draftThresholds}
          setThresholds={setDraftThresholds}
          dirty={dirty}
          isFetching={isFetching}
          onApply={applyDraft}
          onReset={resetDraft}
          onRerun={() => refetch()}
        />

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Modelling…</div>
        ) : !summary ? (
          <div className="text-sm text-muted-foreground">No data.</div>
        ) : (
          <>
            <DepartmentSummaryCard summary={summary} />
            <WorkingPatternsCard
              patterns={consultantPatterns}
              regularMinPct={summary.thresholds.regularWorkingMinPct}
            />
            <ValidationCard
              monthsBack={appliedMonths}
              thresholds={appliedThresholds}
            />
            <SlotsTable slots={slots} />
            <AssumptionsCard />
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
  dirty,
  isFetching,
  onApply,
  onReset,
  onRerun,
}: {
  monthsBack: number;
  setMonthsBack: (n: number) => void;
  thresholds: FeasibilityThresholds;
  setThresholds: (t: FeasibilityThresholds) => void;
  dirty: boolean;
  isFetching: boolean;
  onApply: () => void;
  onReset: () => void;
  onRerun: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Feasibility bar</CardTitle>
        <CardDescription>
          Tune the rules for what counts as a workable regular assignment,
          then press <strong>Recalculate</strong> to rerun the model.
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
        <div className="space-y-2">
          <Label className="text-xs flex items-center justify-between">
            "Thin day" busy ≥
            <span className="font-mono">{thresholds.shortfallDayBusyPct}%</span>
          </Label>
          <Slider
            min={40}
            max={95}
            step={5}
            value={[thresholds.shortfallDayBusyPct]}
            onValueChange={([v]) =>
              setThresholds({ ...thresholds, shortfallDayBusyPct: v })
            }
          />
          <p className="text-[10px] text-muted-foreground leading-tight">
            % of active consultants with any duty record above which a day
            counts as too thin to absorb a redeployment.
          </p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">WTE per failed weekly session</Label>
          <Input
            type="number"
            min={0.05}
            max={0.5}
            step={0.05}
            value={thresholds.wtePerWeeklySession}
            onChange={(e) =>
              setThresholds({
                ...thresholds,
                wtePerWeeklySession: Math.max(0.01, Number(e.target.value) || 0.1),
              })
            }
          />
          <p className="text-[10px] text-muted-foreground leading-tight">
            Conversion used in the extra-WTE estimate. Default 0.1 ≈ 1 PA
            per session ÷ 10 PAs per consultant.
          </p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs flex items-center justify-between">
            "Regular working" ≥
            <span className="font-mono">{thresholds.regularWorkingMinPct}%</span>
          </Label>
          <Slider
            min={20}
            max={90}
            step={5}
            value={[thresholds.regularWorkingMinPct]}
            onValueChange={([v]) =>
              setThresholds({ ...thresholds, regularWorkingMinPct: v })
            }
          />
          <p className="text-[10px] text-muted-foreground leading-tight">
            % of all weekdays (Mon–Fri) the consultant must be assigned to
            clinical activity on a given half-day before it counts as part of
            their regular pattern. On-call weeks are NOT excluded.
          </p>
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
              consultant capacity overall (per the "thin day" threshold).
            </TooltipContent>
          </Tooltip>
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <span className="text-[11px] text-amber-600">
                Unapplied changes
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={onReset}>
              Reset to defaults
            </Button>
            <Button
              size="sm"
              onClick={dirty ? onApply : onRerun}
              disabled={isFetching}
            >
              {isFetching ? "Modelling…" : dirty ? "Recalculate" : "Rerun"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
