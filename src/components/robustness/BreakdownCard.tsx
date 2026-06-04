import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ClipboardList, UserMinus, Coffee, Info, CheckCircle2, XCircle, Ban, GraduationCap } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HalfBreakdown, HalfDayCapacity, StaffStatusEntry, StaffStatusCategory,
} from "@/lib/audit/robustness";

type IconName = "check" | "coffee" | "info" | "list" | "ban" | "user-minus" | "x";

type MetricKey =
  | "headroom"
  | "spa"
  | "supervisedOnly"
  | "excluded";

const METRIC_META: Record<MetricKey, { label: string; chipClass: string; explainer: string }> = {
  headroom: {
    label: "→ headroom",
    chipClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
    explainer: "Solo-capable: counts directly toward the baseline headroom metric (free consultants + free ST6/7/8). SPA is NOT included here.",
  },
  spa: {
    label: "→ SPA (separate)",
    chipClass: "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40",
    explainer: "Consultants on SPA time. Tracked as a SEPARATE metric — never added into headroom. Pulling a consultant off SPA to cover a list is a disruption flag, not spare capacity.",
  },
  supervisedOnly: {
    label: "→ supervised only",
    chipClass: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
    explainer: "Pair with a consultant on a list. Tracked but NOT counted toward headroom (cannot solo-cover).",
  },
  excluded: {
    label: "→ excluded",
    chipClass: "bg-muted text-muted-foreground border-border",
    explainer: "Removed from the pool entirely — does not count toward any headroom metric.",
  },
};

const CATEGORY_META: Record<
  StaffStatusCategory,
  { label: string; tone: string; iconName: IconName; order: number; metric: MetricKey }
> = {
  free_consultant: { label: "Free consultants (solo-capable)", tone: "border-emerald-500/40 bg-emerald-500/5", iconName: "check", order: 1, metric: "headroom" },
  free_senior_trainee: { label: "Free senior trainees ST6–8 (solo-capable)", tone: "border-emerald-500/40 bg-emerald-500/5", iconName: "check", order: 2, metric: "headroom" },
  on_spa: { label: "Consultants on SPA (separate metric)", tone: "border-orange-500/40 bg-orange-500/5", iconName: "coffee", order: 3, metric: "spa" },
  free_junior_trainee: { label: "Free junior trainees (need supervision)", tone: "border-sky-500/30 bg-sky-500/5", iconName: "info", order: 4, metric: "supervisedOnly" },
  free_sas: { label: "Free SAS (pair with consultant)", tone: "border-sky-500/30 bg-sky-500/5", iconName: "info", order: 5, metric: "supervisedOnly" },
  on_clinical_list: { label: "Excluded — already covering a list", tone: "border-slate-500/30 bg-slate-500/5", iconName: "list", order: 6, metric: "excluded" },
  on_excluded_duty: { label: "Excluded — ICU / obstetrics / on-call / teaching / admin", tone: "border-blue-500/30 bg-blue-500/5", iconName: "ban", order: 7, metric: "excluded" },
  on_leave: { label: "Excluded — on approved leave", tone: "border-red-500/30 bg-red-500/5", iconName: "user-minus", order: 8, metric: "excluded" },
  ltft_off: { label: "Excluded — LTFT non-working day", tone: "border-muted bg-muted/30", iconName: "x", order: 9, metric: "excluded" },
};

function renderIcon(name: IconName) {
  switch (name) {
    case "check": return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    case "coffee": return <Coffee className="h-4 w-4 text-orange-600" />;
    case "info": return <Info className="h-4 w-4 text-sky-600" />;
    case "list": return <ClipboardList className="h-4 w-4 text-slate-500" />;
    case "ban": return <Ban className="h-4 w-4 text-blue-600" />;
    case "user-minus": return <UserMinus className="h-4 w-4 text-red-500" />;
    case "x": return <XCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function GradeBadge({ grade, trainingLevel }: { grade: string; trainingLevel: string | null }) {
  const label = grade === "trainee" && trainingLevel ? trainingLevel : grade;
  return <Badge variant="outline" className="text-[10px] capitalize">{label}</Badge>;
}

export function BreakdownCard({
  label, breakdown, h,
}: { label: string; breakdown: HalfBreakdown; h: HalfDayCapacity }) {
  const groups = new Map<StaffStatusCategory, StaffStatusEntry[]>();
  for (const e of breakdown.entries) {
    const arr = groups.get(e.category) ?? [];
    arr.push(e);
    groups.set(e.category, arr);
  }
  const orderedCats = (Object.keys(CATEGORY_META) as StaffStatusCategory[])
    .sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order)
    .filter((c) => (groups.get(c)?.length ?? 0) > 0);

  // Totals contributing to each metric, derived from HalfDayCapacity.
  // SPA is reported as its own metric — NOT folded into headroom anywhere.
  const metricTotals: Record<MetricKey, number> = {
    headroom: h.soloCapable, // free consultants + senior trainees (SPA excluded)
    spa: h.consultantsOnSpa, // standalone SPA metric
    supervisedOnly: h.juniorTraineesAvailable + h.sasAvailable,
    excluded: 0,
  };
  // Excluded = everyone in the breakdown not counted in the three pools above.
  const totalEntries = breakdown.entries.length;
  metricTotals.excluded =
    totalEntries - metricTotals.headroom - metricTotals.spa - metricTotals.supervisedOnly;

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{label}</CardTitle>
          <CardDescription>
            Every active staff member classified for this half-day, with the exact reason and which headroom metric they feed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Headroom summary chips */}
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <MetricChip metric="headroom" count={metricTotals.headroom} suffix={`= headroom ${h.headroom}`} />
            <MetricChip metric="spa" count={metricTotals.spa} suffix="(separate, not in headroom)" />
            <MetricChip metric="supervisedOnly" count={metricTotals.supervisedOnly} />
            <MetricChip metric="excluded" count={metricTotals.excluded} />
          </div>

          {orderedCats.length === 0 ? (
            <div className="text-sm text-muted-foreground">Nobody.</div>
          ) : (
            orderedCats.map((cat) => {
              const meta = CATEGORY_META[cat];
              const people = groups.get(cat) ?? [];
              const metric = METRIC_META[meta.metric];
              const metricTotal = metricTotals[meta.metric];
              return (
                <details
                  key={cat}
                  className={cn("rounded-md border p-2", meta.tone)}
                  open={cat.startsWith("free_") || cat === "on_spa"}
                >
                  <summary className="cursor-pointer text-sm font-medium flex items-center gap-2 select-none flex-wrap">
                    {renderIcon(meta.iconName)}
                    <span>{meta.label}</span>
                    <Badge variant="secondary" className="text-[10px]">{people.length}</Badge>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={cn("rounded border px-1.5 py-0.5 text-[10px] cursor-help", metric.chipClass)}>
                          {metric.label} ({people.length}/{metricTotal})
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <p className="max-w-[20rem] text-xs">{metric.explainer}</p>
                      </TooltipContent>
                    </Tooltip>
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {people.map((p) => {
                      const entryMetric = meta.metric;
                      const entryBorder =
                        entryMetric === "headroom"
                          ? "border-l-emerald-500"
                          : entryMetric === "spa"
                            ? "border-l-orange-500"
                            : entryMetric === "supervisedOnly"
                              ? "border-l-sky-500"
                              : "border-l-muted-foreground/40";
                      return (
                        <li
                          key={p.staffId}
                          className={cn(
                            "flex flex-col gap-1 rounded border border-l-[3px] bg-background/60 px-2 py-1",
                            entryBorder
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5">
                              <span className="font-medium text-sm">{p.staffName}</span>
                              <GradeBadge grade={p.grade} trainingLevel={p.trainingLevel} />
                            </span>
                            <span className="text-right text-muted-foreground">{p.reason}</span>
                          </div>
                          {p.trainingNote ? <TrainingNoteBadge note={p.trainingNote} /> : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function MetricChip({ metric, count, suffix }: { metric: MetricKey; count: number; suffix?: string }) {
  const m = METRIC_META[metric];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("rounded border px-1.5 py-0.5 cursor-help", m.chipClass)}>
          {m.label}: <strong>{count}</strong>{suffix ? ` ${suffix}` : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="max-w-[20rem] text-xs">{m.explainer}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function TrainingNoteBadge({
  note,
}: {
  note: NonNullable<StaffStatusEntry["trainingNote"]>;
}) {
  const toneClass =
    note.tone === "good"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
      : note.tone === "miss"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
        : "bg-muted text-muted-foreground border-border";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] cursor-help",
            toneClass
          )}
        >
          <GraduationCap className="h-3 w-3" />
          {note.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="max-w-[22rem] text-xs">{note.detail}</p>
      </TooltipContent>
    </Tooltip>
  );
}
