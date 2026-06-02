import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
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
  type ConsultantPattern,
  type DepartmentSummary,
  type FeasibilityThresholds,
  type ListSlotFeasibility,
  type Verdict,
} from "@/lib/audit/list-feasibility";
import {
  validateConsultantPatterns,
  type SampleClassification,
} from "@/lib/audit/list-feasibility-validation";
import {
  diagnoseValidationReport,
  type DiagnosedReport,
  type DiagnosedConsultant,
  type DiagnosedCell,
  type Diagnosis,
  type Remediation,
} from "@/lib/audit/list-feasibility-diagnosis";



export const Route = createFileRoute("/_authenticated/robustness/list-feasibility")({
  component: ListFeasibilityPage,
});

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

function DepartmentSummaryCard({ summary }: { summary: DepartmentSummary }) {
  const linkagePct =
    summary.theatreAssignmentsTotal > 0
      ? Math.round(
          (summary.theatreAssignmentsLinked / summary.theatreAssignmentsTotal) * 100,
        )
      : 100;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Department summary</CardTitle>
        <CardDescription>
          {summary.totalSlots} recurring list slot(s) detected between{" "}
          {summary.windowStart} and {summary.windowEnd}.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
        <Stat
          label="Extra WTE needed (after SAS)"
          value={summary.estimatedExtraWteWithSas.toFixed(1)}
          tone={summary.estimatedExtraWteWithSas > 0 ? "red" : "emerald"}
          icon={Users}
          help={`Subtracts current SAS list-delivery capacity: ${summary.activeSasCount} active SAS doctor(s) delivering ~${summary.sasListSessionsPerWeek.toFixed(1)} list half-days/week ≈ ${summary.sasWteOffset.toFixed(1)} consultant-WTE of cover.`}
        />
      </CardContent>
      {linkagePct < 90 && (
        <CardContent className="pt-0">
          <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>Data-quality caveat:</strong> only {linkagePct}% of theatre
            rota assignments in this window (
            {summary.theatreAssignmentsLinked.toLocaleString()} of{" "}
            {summary.theatreAssignmentsTotal.toLocaleString()}) are linked to a
            specific theatre list. Owner/deputy coverage percentages are
            computed on that linked subset. Unlinked theatre work is still used
            to recognise that a consultant was busy on some other list (so they
            aren't mis-classified as "free but replaced"), but coverage % may
            be understated where CLWRota didn't attach a list ID.
          </div>
        </CardContent>
      )}
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
              <th className="px-2 py-1 text-left font-medium">Feasible candidates</th>
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
                <td className="px-2 py-1.5 max-w-[18rem]">
                  {s.candidateOwners.length === 0 ? (
                    <span className="text-muted-foreground text-[11px]">
                      No consultant regularly works this half-day.
                    </span>
                  ) : (
                    <ul className="space-y-0.5">
                      {s.candidateOwners.slice(0, 5).map((c) => (
                        <li key={c.id} className="text-[11px] leading-tight">
                          <span className={cn(c.isCurrentOwner && "font-medium")}>
                            {c.name}
                          </span>{" "}
                          <span className="text-muted-foreground font-mono">
                            {c.workingPct}%
                          </span>
                          {c.isCurrentOwner && (
                            <span className="ml-1 text-[10px] text-emerald-700">owner</span>
                          )}
                          {c.isCurrentDeputy && !c.isCurrentOwner && (
                            <span className="ml-1 text-[10px] text-amber-700">deputy</span>
                          )}
                        </li>
                      ))}
                      {s.candidateOwners.length > 5 && (
                        <li className="text-[10px] text-muted-foreground">
                          +{s.candidateOwners.length - 5} more
                        </li>
                      )}
                    </ul>
                  )}
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


function AssumptionsCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Modelling assumptions</CardTitle>
        <CardDescription>
          How the feasibility and headcount numbers are derived, so you can audit the results.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <h4 className="font-medium mb-1">Data window</h4>
          <p className="text-muted-foreground">
            The model looks at CLWRota actuals between the start and end dates shown above.
            Weekend sessions (Saturday and Sunday) are excluded. Only AM and PM sessions are analysed.
          </p>
        </div>
        <div>
          <h4 className="font-medium mb-1">What counts as a recurring list</h4>
          <p className="text-muted-foreground">
            A list is treated as a recurring "slot" when it shares the same day-of-week, session (AM/PM), theatre and surgeon, and appears at least as many times as the minimum-recurrence threshold you set.
            Surgeon names are normalised (titles and extra spaces stripped) so minor spelling variations do not fragment the count.
          </p>
        </div>
        <div>
          <h4 className="font-medium mb-1">Owner and deputy identification</h4>
          <p className="text-muted-foreground">
            The consultant who has covered a slot most often is nominated as the <em>owner</em>. The second-most-frequent consultant is nominated as the <em>deputy</em>. Only consultants with an active profile and grade "consultant" are considered; SAS doctors and trainees are not counted as owners or deputies.
          </p>
        </div>
        <div>
          <h4 className="font-medium mb-1">How coverage percentages are counted</h4>
          <p className="text-muted-foreground">
            <strong>Owner present %</strong> — sessions where the owner was the named theatre consultant on that list, divided by total occurrences of the slot.<br />
            <strong>Owner or deputy %</strong> — sessions where <em>either</em> the owner <em>or</em> the deputy was the named theatre consultant, divided by total occurrences.
          </p>
        </div>
        <div>
          <h4 className="font-medium mb-1">Why the owner might be absent</h4>
          <p className="text-muted-foreground">
            When the owner did not cover a session, the model distinguishes two cases:
          </p>
          <ul className="list-disc pl-5 text-muted-foreground space-y-1 mt-1">
            <li><strong>Unavailable</strong> — the owner had a non-theatre duty_type recorded for that half-day (e.g. on-call, SPA, admin, leave).</li>
            <li><strong>Free but replaced</strong> — the owner had no rota record at all for that half-day, or was on a different theatre list, so another consultant covered instead. This is treated as the most flexible kind of absence.</li>
          </ul>
        </div>
        <div>
          <h4 className="font-medium mb-1">Shortfall heuristic</h4>
          <p className="text-muted-foreground">
            When "Reject slots that would tip a day into shortfall" is enabled, the model counts how many times the owner was "free but replaced" on a day when more than 70% of all active consultants already had some duty record. On those days, locking the owner to this list would remove a spare body and is flagged as a potential shortfall.
          </p>
        </div>
        <div>
          <h4 className="font-medium mb-1">Extra consultant WTE needed — how it's calculated</h4>
          <ul className="list-disc pl-5 text-muted-foreground space-y-1 mt-1">
            <li>For each regular list slot, the model picks an <strong>owner</strong> (most frequent consultant) and a <strong>deputy</strong> (second-most). Only active consultant-grade staff are eligible.</li>
            <li>Two coverage percentages are computed across the window: <strong>owner %</strong> and <strong>owner-or-deputy %</strong>.</li>
            <li>Each percentage is compared to its threshold (defaults 80% / 95%) and classified as <em>above</em>, <em>near</em> (within 10 pts), or <em>below</em>.</li>
            <li>A per-slot <strong>headcount gap</strong> is then assigned:
              <ul className="list-[circle] pl-5 mt-1">
                <li><code>+1</code> if the owner % is <em>below</em> threshold.</li>
                <li><code>+1</code> more if the owner-or-deputy % is also <em>below</em> threshold (so a slot can contribute 0, 1, or 2).</li>
                <li><code>0</code> for feasible or borderline slots.</li>
              </ul>
            </li>
            <li>Each unit of headcount gap is converted to WTE using <strong>0.1 WTE per weekly session</strong> (1 list half-day per week ≈ 1 PA, and 10 PAs ≈ 1 consultant WTE). This rate is configurable in the thresholds panel.</li>
            <li>The slot-level gaps are summed across the department and rounded to one decimal place. Emergency / CEPOD lists are excluded from this calculation.</li>
            <li>This is a deliberately rough order-of-magnitude figure, not a precise workforce-planning number — it answers "roughly how many more consultants would close the regular-list coverage gap?".</li>
          </ul>
        </div>
        <div>
          <h4 className="font-medium mb-1">Extra WTE needed after SAS doctors are factored in</h4>
          <ul className="list-disc pl-5 text-muted-foreground space-y-1 mt-1">
            <li>SAS doctors are not nominated as owners or deputies, but they do deliver theatre lists and so add real capacity to the elective pool.</li>
            <li>The model counts every <code>duty_type = "theatre"</code> AM/PM rota assignment for active SAS doctors within the analysis window.</li>
            <li>That total is divided by the number of weeks in the window to give <strong>SAS list half-days per week</strong>.</li>
            <li>It is then multiplied by the same <strong>0.1 WTE per weekly session</strong> rate to give a <strong>SAS consultant-WTE-equivalent offset</strong>.</li>
            <li>The adjusted figure is <code>max(0, extra consultant WTE − SAS offset)</code>, again rounded to one decimal place.</li>
            <li>The hover tooltip on the "Extra WTE needed (after SAS)" tile shows the underlying numbers (SAS headcount, half-days/week, WTE offset) for transparency.</li>
            <li>Caveat: this assumes the SAS list activity observed in the window continues at the same rate. It does not assume SAS doctors take on additional sessions, nor that they become the named owner of any list.</li>
          </ul>
        </div>
        <div>
          <h4 className="font-medium mb-1">Verdict thresholds</h4>
          <p className="text-muted-foreground">
            <strong>Feasible</strong> — owner and owner+deputy both meet or exceed their target percentages, and no shortfall flag is raised.<br />
            <strong>Borderline</strong> — neither percentage is more than 10 points below its target, and no shortfall flag is raised.<br />
            <strong>Not feasible</strong> — either percentage is more than 10 points below target, or a shortfall is flagged.
          </p>
        </div>
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

function WorkingPatternsCard({
  patterns,
  regularMinPct,
}: {
  patterns: ConsultantPattern[];
  regularMinPct: number;
}) {
  if (patterns.length === 0) return null;
  const DAYS = [1, 2, 3, 4, 5];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Consultant working patterns</CardTitle>
        <CardDescription>
          For each consultant, the percentage of Mon–Fri half-days{" "}
          <strong>within their own tenure in the data window</strong> on which
          CLWRota recorded them as covering a theatre list (clinical activity).
          Each consultant's denominator is scoped to the first and last date
          they appear in the rota inside the window, so recent joiners and
          leavers are not artificially diluted. Weeks containing on-call are
          still included in the denominator. Cells highlighted in green are
          at or above the regular-working threshold ({regularMinPct}%).
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Consultant</th>
              <th className="px-2 py-1 text-left font-medium whitespace-nowrap">Tenure in window</th>
              {DAYS.map((d) => (
                <th key={d} className="px-1 py-1 text-center font-medium" colSpan={2}>
                  {DOW_LABEL[d]}
                </th>
              ))}
              <th className="px-2 py-1 text-center font-medium">Reg /wk</th>
            </tr>
            <tr className="text-[10px]">
              <th />
              <th />
              {DAYS.flatMap((d) => [
                <th key={`${d}-am`} className="px-1 py-0.5 text-center font-normal">AM</th>,
                <th key={`${d}-pm`} className="px-1 py-0.5 text-center font-normal">PM</th>,
              ])}

              <th />
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-2 py-1 whitespace-nowrap">{p.name}</td>
                <td className="px-2 py-1 whitespace-nowrap text-[11px] text-muted-foreground">
                  {p.tenureStart && p.tenureEnd ? (
                    <>
                      {p.tenureStart} → {p.tenureEnd}
                      <span className="ml-1 text-muted-foreground/70">
                        ({p.tenureWeekdays} wd)
                      </span>
                    </>
                  ) : (
                    <span className="italic">no data</span>
                  )}
                </td>
                {p.cells.map((c) => (
                  <td
                    key={`${c.dow}-${c.session}`}
                    className={cn(
                      "px-1 py-1 text-center font-mono text-[11px]",
                      c.regularDayOff
                        ? "bg-muted/40 text-muted-foreground italic"
                        : c.regular
                          ? "bg-emerald-100 text-emerald-800"
                          : c.workingPct >= regularMinPct - 15
                            ? "bg-amber-50 text-amber-700"
                            : "text-muted-foreground",
                    )}
                    title={
                      c.regularDayOff
                        ? "Regular non-working day — excluded from working-pattern denominator"
                        : `Clinical activity ${c.workingOccurrences}/${c.totalOccurrences} weekdays in tenure (on-call on ${c.oncallOccurrences})`
                    }
                  >
                    {c.regularDayOff ? "off" : `${c.workingPct}%`}
                  </td>
                ))}
                <td className="px-2 py-1 text-center font-medium">
                  {p.regularSessionsPerWeek}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// =============== Validation report ===============

function ValidationCard({
  monthsBack,
  thresholds,
}: {
  monthsBack: number;
  thresholds: FeasibilityThresholds;
}) {
  const [enabled, setEnabled] = useState(false);
  const [sampleCap, setSampleCap] = useState(10);
  const [mismatchThreshold, setMismatchThreshold] = useState(15);
  const [onlyMismatches, setOnlyMismatches] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [monthsBackOverride, setMonthsBackOverride] = useState<number | null>(null);
  const [verification, setVerification] = useState<{
    at: string;
    tokenCount: number;
    tokensSample: string[];
    feasible: number;
    borderline: number;
    notFeasible: number;
    monthsBack: number;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const effectiveMonthsBack = monthsBackOverride ?? monthsBack;
  const queryClient = useQueryClient();

  // Explicit post-remediation verification: re-read the updated tokens from
  // the DB and re-run computeListFeasibility with them, so we can confirm
  // the recomputed model numbers BEFORE the validation report re-renders.
  const runVerification = async (forMonthsBack: number) => {
    setVerifying(true);
    try {
      const { data: rows, error } = await supabase
        .from("validation_custom_non_working_labels")
        .select("token")
        .order("token", { ascending: true });
      if (error) throw new Error(error.message);
      const tokens = (rows ?? [])
        .map((r) => (r as { token: string }).token)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      const model = await computeListFeasibility({
        monthsBack: forMonthsBack,
        thresholds,
        extraNonWorkingTokens: tokens,
      });
      setVerification({
        at: new Date().toISOString(),
        tokenCount: tokens.length,
        tokensSample: tokens.slice(0, 8),
        feasible: model.summary.feasible,
        borderline: model.summary.borderline,
        notFeasible: model.summary.notFeasible,
        monthsBack: forMonthsBack,
      });
    } finally {
      setVerifying(false);
    }
  };

  const queryKey = [
    "list-feasibility-validation",
    effectiveMonthsBack,
    sampleCap,
    mismatchThreshold,
    JSON.stringify(thresholds),
  ] as const;

  const { data, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      const raw = await validateConsultantPatterns({
        monthsBack: effectiveMonthsBack,
        thresholds,
        sampleCap,
        mismatchThresholdPct: mismatchThreshold,
      });
      return diagnoseValidationReport(raw);
    },
    enabled,
  });

  const run = () => {
    if (enabled) {
      void refetch();
    } else {
      setEnabled(true);
    }
  };

  // ---- Apply remediation -> auto re-run validation ----
  const applyMutation = useMutation({
    mutationFn: async (remediation: Remediation) => {
      switch (remediation.kind) {
        case "extend-non-working-labels": {
          const tokens = ((remediation.payload?.tokens as string[]) ?? [])
            .map((t) => t.trim())
            .filter(Boolean);
          if (tokens.length === 0) throw new Error("No tokens to add");
          const rows = tokens.map((token) => ({
            token,
            source: "auto-remediation:list-feasibility",
          }));
          const { error } = await supabase
            .from("validation_custom_non_working_labels")
            .upsert(rows, { onConflict: "token", ignoreDuplicates: true });
          if (error) throw new Error(error.message);
          return {
            message: `Added ${tokens.length} label${tokens.length === 1 ? "" : "s"} to the non-working list.`,
          };
        }
        case "widen-validation-window": {
          const next = Math.min(24, effectiveMonthsBack + 3);
          if (next === effectiveMonthsBack) {
            throw new Error("Validation window is already at the maximum (24 months).");
          }
          setMonthsBackOverride(next);
          return { message: `Widened validation window to ${next} months.` };
        }
        default:
          throw new Error("This remediation has no in-app apply action.");
      }
    },
    onSuccess: async (result) => {
      toast.success(result.message, {
        description: "Verifying updated tokens and re-running validation…",
      });
      // Make sure the next run reflects newly inserted DB rows.
      await queryClient.invalidateQueries({ queryKey: ["list-feasibility-validation"] });
      // Explicit verification step: re-read tokens from DB and recompute the
      // model before re-rendering the validation report.
      try {
        await runVerification(effectiveMonthsBack);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Verification failed: ${err.message}`
            : "Verification failed",
        );
      }
      await refetch();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not apply remediation");
    },
  });

  const isApplicable = (kind: Remediation["kind"]) =>
    kind === "extend-non-working-labels" || kind === "widen-validation-window";

  // ---- Apply ALL eligible remediations in the current report ----
  const eligibleRemediations: Remediation[] = data
    ? data.consultants.flatMap((c) =>
        c.cells.flatMap((cell) =>
          cell.diagnoses
            .map((d) => d.remediation)
            .filter((r) => isApplicable(r.kind)),
        ),
      )
    : [];

  const aggregateTokens = Array.from(
    new Set(
      eligibleRemediations
        .filter((r) => r.kind === "extend-non-working-labels")
        .flatMap((r) => ((r.payload?.tokens as string[]) ?? []).map((t) => t.trim()))
        .filter(Boolean),
    ),
  );
  const wantsWiden = eligibleRemediations.some(
    (r) => r.kind === "widen-validation-window",
  );
  const canWiden = wantsWiden && effectiveMonthsBack < 24;
  const totalEligibleFixes = aggregateTokens.length + (canWiden ? 1 : 0);

  const applyAllMutation = useMutation({
    mutationFn: async () => {
      const steps: string[] = [];
      if (aggregateTokens.length > 0) {
        const rows = aggregateTokens.map((token) => ({
          token,
          source: "auto-remediation:list-feasibility:apply-all",
        }));
        const { error } = await supabase
          .from("validation_custom_non_working_labels")
          .upsert(rows, { onConflict: "token", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
        steps.push(
          `Added ${aggregateTokens.length} label${aggregateTokens.length === 1 ? "" : "s"} to the non-working list`,
        );
      }
      if (canWiden) {
        const next = Math.min(24, effectiveMonthsBack + 3);
        setMonthsBackOverride(next);
        steps.push(`Widened validation window to ${next} months`);
      }
      if (steps.length === 0) {
        throw new Error("No eligible remediations to apply.");
      }
      return { message: steps.join("; ") + "." };
    },
    onSuccess: async (result) => {
      toast.success("Applied all eligible fixes", {
        description: `${result.message} Verifying updated tokens and re-running validation…`,
      });
      await queryClient.invalidateQueries({ queryKey: ["list-feasibility-validation"] });
      // Explicit verification step: re-read tokens from DB and recompute the
      // model before re-rendering the validation report. Use the post-apply
      // months value (state may not have flushed yet).
      const nextMonths = canWiden
        ? Math.min(24, effectiveMonthsBack + 3)
        : effectiveMonthsBack;
      try {
        await runVerification(nextMonths);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Verification failed: ${err.message}`
            : "Verification failed",
        );
      }
      await refetch();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not apply fixes");
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Working-pattern validation</CardTitle>
        <CardDescription>
          One-click sanity check: for each consultant × (day-of-week,
          session) cell, this pulls a sample of actual rota_assignments
          rows from the same window and recomputes a sampled working %
          independently of the model. Cells whose sampled % differs from
          the model by more than the mismatch threshold are flagged, and
          each flagged cell shows an auto-investigation diagnosis with a
          one-click apply button where the fix can be made in-app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label className="text-xs">Sample size per cell</Label>
            <Input
              type="number"
              className="w-24"
              min={3}
              max={50}
              value={sampleCap}
              onChange={(e) =>
                setSampleCap(Math.max(3, Number(e.target.value) || 10))
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Mismatch threshold (% pts)</Label>
            <Input
              type="number"
              className="w-24"
              min={5}
              max={50}
              step={5}
              value={mismatchThreshold}
              onChange={(e) =>
                setMismatchThreshold(Math.max(5, Number(e.target.value) || 15))
              }
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Validation window (months)</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                className="w-24"
                min={1}
                max={24}
                value={effectiveMonthsBack}
                onChange={(e) =>
                  setMonthsBackOverride(
                    Math.min(24, Math.max(1, Number(e.target.value) || monthsBack)),
                  )
                }
              />
              {monthsBackOverride !== null && monthsBackOverride !== monthsBack && (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline"
                  onClick={() => setMonthsBackOverride(null)}
                >
                  reset
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="only-mismatches"
              checked={onlyMismatches}
              onCheckedChange={setOnlyMismatches}
            />
            <Label htmlFor="only-mismatches" className="text-xs">
              Only show consultants with mismatches
            </Label>
          </div>
          <Button size="sm" onClick={run} disabled={isFetching}>
            {isFetching
              ? "Validating…"
              : enabled
                ? "Re-run validation"
                : "Run validation"}
          </Button>
          {enabled && data && totalEligibleFixes > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => applyAllMutation.mutate()}
              disabled={
                applyAllMutation.isPending || applyMutation.isPending || isFetching
              }
            >
              {applyAllMutation.isPending
                ? "Applying all fixes…"
                : `Apply all fixes & re-run (${totalEligibleFixes})`}
            </Button>
          )}
        </div>

        {(verifying || verification) && (
          <div className="rounded-md border border-sky-300/60 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-200">
            {verifying ? (
              <span>
                <strong>Verifying…</strong> re-reading non-working labels from
                the database and recomputing the feasibility model before
                refreshing the validation report.
              </span>
            ) : verification ? (
              <div className="space-y-1">
                <div>
                  <strong>Verification complete</strong> — recomputed model
                  with{" "}
                  <span className="font-mono">{verification.tokenCount}</span>{" "}
                  non-working label token(s) over a{" "}
                  <span className="font-mono">{verification.monthsBack}</span>
                  -month window at{" "}
                  {new Date(verification.at).toLocaleTimeString()}.
                </div>
                <div className="text-[11px]">
                  Recomputed list verdicts: feasible{" "}
                  <span className="font-mono">{verification.feasible}</span>,
                  borderline{" "}
                  <span className="font-mono">{verification.borderline}</span>,
                  not feasible{" "}
                  <span className="font-mono">{verification.notFeasible}</span>.
                  {verification.tokensSample.length > 0 && (
                    <>
                      {" "}Tokens in effect:{" "}
                      <span className="font-mono">
                        {verification.tokensSample.join(", ")}
                        {verification.tokenCount > verification.tokensSample.length
                          ? ` … (+${verification.tokenCount - verification.tokensSample.length} more)`
                          : ""}
                      </span>
                      .
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}


        {!enabled ? (
          <p className="text-xs text-muted-foreground">
            Validation hasn't been run yet. Press <strong>Run validation</strong> to
            independently re-derive consultant working patterns from raw
            CLWRota records.
          </p>
        ) : isFetching && !data ? (
          <p className="text-sm text-muted-foreground">Sampling raw rota records…</p>
        ) : !data ? null : (
          <ValidationResults
            report={data}
            onlyMismatches={onlyMismatches}
            expanded={expanded}
            setExpanded={setExpanded}
            onApply={(r) => applyMutation.mutate(r)}
            isApplying={applyMutation.isPending}
            isApplicable={isApplicable}
          />
        )}
      </CardContent>
    </Card>

  );
}

interface RemediationActions {
  onApply: (r: Remediation) => void;
  isApplying: boolean;
  isApplicable: (kind: Remediation["kind"]) => boolean;
}

function ValidationResults({
  report,
  onlyMismatches,
  expanded,
  setExpanded,
  onApply,
  isApplying,
  isApplicable,
}: {
  report: DiagnosedReport;
  onlyMismatches: boolean;
  expanded: string | null;
  setExpanded: (k: string | null) => void;
} & RemediationActions) {
  const consultants = onlyMismatches
    ? report.consultants.filter((c) => c.mismatchCount > 0)
    : report.consultants;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-4 text-xs">
        <SummaryPill
          label="Consultants checked"
          value={report.consultants.length}
        />
        <SummaryPill
          label="Cells checked"
          value={report.totalCells}
        />
        <SummaryPill
          label="Cells flagged"
          value={report.cellsWithMismatch}
          tone={report.cellsWithMismatch > 0 ? "red" : "emerald"}
        />
        <SummaryPill
          label="Consultants flagged"
          value={report.consultantsWithMismatch}
          tone={report.consultantsWithMismatch > 0 ? "red" : "emerald"}
        />
      </div>

      {report.causeTally.length > 0 && (
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <div className="text-xs font-medium">
            Auto-investigation: most common causes
          </div>
          <ul className="text-xs space-y-1">
            {report.causeTally.map((c) => (
              <li key={c.code} className="flex items-center gap-2">
                <Badge variant="secondary" className="tabular-nums">
                  {c.count}
                </Badge>
                <span>{c.summary}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Expand any flagged consultant below to see per-cell diagnoses and
            recommended fixes.
          </p>
        </div>
      )}

      {consultants.length === 0 ? (
        <p className="text-xs text-emerald-700">
          No mismatches detected at the current threshold (±{report.mismatchThresholdPct}{" "}
          percentage points). All sampled cells agree with the model.
        </p>
      ) : (
        <div className="space-y-2">
          {consultants.map((c) => (
            <ValidationConsultantRow
              key={c.id}
              consultant={c}
              expanded={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
              onApply={onApply}
              isApplying={isApplying}
              isApplicable={isApplicable}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ValidationConsultantRow({
  consultant,
  expanded,
  onToggle,
  onApply,
  isApplying,
  isApplicable,
}: {
  consultant: DiagnosedConsultant;
  expanded: boolean;
  onToggle: () => void;
} & RemediationActions) {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/40"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-sm">{consultant.name}</span>
          {consultant.mismatchCount > 0 ? (
            <Badge className="bg-red-100 text-red-700 hover:bg-red-100">
              {consultant.mismatchCount} mismatch
              {consultant.mismatchCount === 1 ? "" : "es"}
            </Badge>
          ) : (
            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
              Agrees with model
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">
            max Δ {consultant.maxAbsDelta} pts
          </span>
          {consultant.topDiagnosis && (
            <span className="text-[11px] text-muted-foreground italic truncate max-w-[40ch]">
              · {consultant.topDiagnosis.summary}
            </span>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {consultant.tenureStart && consultant.tenureEnd
            ? `${consultant.tenureStart} → ${consultant.tenureEnd}`
            : "no tenure data"}
        </span>
      </button>
      {expanded && (
        <div className="border-t bg-muted/20 p-3 space-y-3">
          <ValidationCellTable
            cells={consultant.cells}
            onApply={onApply}
            isApplying={isApplying}
            isApplicable={isApplicable}
          />
        </div>
      )}
    </div>
  );
}

function ValidationCellTable({
  cells,
  onApply,
  isApplying,
  isApplicable,
}: { cells: DiagnosedCell[] } & RemediationActions) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Cell</th>
            <th className="px-2 py-1 text-center font-medium">Model %</th>
            <th className="px-2 py-1 text-center font-medium">Sampled %</th>
            <th className="px-2 py-1 text-center font-medium">Δ</th>
            <th className="px-2 py-1 text-center font-medium">n</th>
            <th className="px-2 py-1 text-center font-medium">Clin</th>
            <th className="px-2 py-1 text-center font-medium">Off-lbl</th>
            <th className="px-2 py-1 text-center font-medium">Other</th>
            <th className="px-2 py-1 text-center font-medium">None</th>
            <th className="px-2 py-1 text-left font-medium">Sampled dates</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <Fragment key={`${cell.dow}-${cell.session}`}>
              <tr
                className={cn(
                  "border-t align-top",
                  cell.mismatch && "bg-red-50 dark:bg-red-950/20",
                )}
              >
                <td className="px-2 py-1.5 whitespace-nowrap font-medium">
                  {DOW_LABEL[cell.dow]}{" "}
                  <span className="uppercase text-muted-foreground">
                    {cell.session}
                  </span>
                  {cell.modelRegularDayOff && (
                    <span className="ml-1 text-[10px] italic text-muted-foreground">
                      (off)
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center font-mono">
                  {cell.modelPct}%
                </td>
                <td className="px-2 py-1.5 text-center font-mono">
                  {cell.sampleSize === 0 ? "—" : `${cell.sampledPct}%`}
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 text-center font-mono",
                    cell.mismatch && "text-red-700 font-semibold",
                  )}
                >
                  {cell.sampleSize === 0 ? "—" : `${cell.delta > 0 ? "+" : ""}${cell.delta}`}
                </td>
                <td className="px-2 py-1.5 text-center text-muted-foreground">
                  {cell.sampleSize}/{cell.tenureDates}
                </td>
                <td className="px-2 py-1.5 text-center">{cell.clinical}</td>
                <td className="px-2 py-1.5 text-center">{cell.offDayLabel}</td>
                <td className="px-2 py-1.5 text-center">{cell.otherDuty}</td>
                <td className="px-2 py-1.5 text-center">{cell.noRecord}</td>
                <td className="px-2 py-1.5">
                  <ul className="space-y-0.5">
                    {cell.samples.map((s) => (
                      <li key={s.date} className="text-[10px] leading-tight">
                        <span className="font-mono">{s.date}</span>{" "}
                        <ClassificationBadge classification={s.classification} />
                        {s.dutyType && (
                          <span className="ml-1 text-muted-foreground">
                            {s.dutyType}
                            {s.roleOnList ? `/${s.roleOnList}` : ""}
                          </span>
                        )}
                        {s.notes && (
                          <span className="ml-1 text-muted-foreground italic">
                            "{s.notes.slice(0, 60)}
                            {s.notes.length > 60 ? "…" : ""}"
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
              {cell.diagnoses.length > 0 && (
                <tr className="border-t-0 bg-amber-50/50 dark:bg-amber-950/10">
                  <td colSpan={10} className="px-2 pb-2">
                    <DiagnosisList
                      diagnoses={cell.diagnoses}
                      onApply={onApply}
                      isApplying={isApplying}
                      isApplicable={isApplicable}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosisList({
  diagnoses,
  onApply,
  isApplying,
  isApplicable,
}: { diagnoses: Diagnosis[] } & RemediationActions) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Auto-investigation
      </div>
      <ul className="space-y-1.5">
        {diagnoses.map((d, i) => (
          <li
            key={`${d.code}-${i}`}
            className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] dark:border-amber-900 dark:bg-amber-950/30"
          >
            <div className="flex items-start gap-2">
              <Badge
                className={cn(
                  "shrink-0 text-[9px] uppercase",
                  d.severity === "error" && "bg-red-100 text-red-800",
                  d.severity === "warn" && "bg-amber-100 text-amber-800",
                  d.severity === "info" && "bg-slate-100 text-slate-700",
                )}
              >
                {d.severity}
              </Badge>
              <div className="space-y-0.5 flex-1">
                <div className="font-medium">{d.summary}</div>
                {d.evidence.length > 0 && (
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {d.evidence.map((e, j) => (
                      <li key={j}>{e}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <span className="text-muted-foreground">
                    → {d.remediation.summary}
                  </span>
                  {isApplicable(d.remediation.kind) && (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-[10px]"
                      disabled={isApplying}
                      onClick={() => onApply(d.remediation)}
                    >
                      {isApplying ? "Applying…" : "Apply fix & re-run"}
                    </Button>
                  )}
                  {d.remediation.href && (
                    <Link
                      to={d.remediation.href}
                      className="text-primary underline underline-offset-2"
                    >
                      Open
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}




function ClassificationBadge({
  classification,
}: {
  classification: SampleClassification;
}) {
  const map: Record<SampleClassification, { label: string; cls: string }> = {
    clinical: { label: "clin", cls: "bg-emerald-100 text-emerald-800" },
    off_day_label: { label: "off-lbl", cls: "bg-slate-200 text-slate-700" },
    other_duty: { label: "other", cls: "bg-amber-100 text-amber-800" },
    no_record: { label: "none", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[classification];
  return (
    <span
      className={cn(
        "inline-block rounded px-1 text-[9px] font-medium uppercase tracking-wide",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "red";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        tone === "red" && "border-red-300 bg-red-50 text-red-900",
        tone === "emerald" && "border-emerald-300 bg-emerald-50 text-emerald-900",
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

