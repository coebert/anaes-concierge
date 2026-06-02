import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatDateWithWeekdayGB } from "@/lib/utils";
import type { TraineeMetrics } from "@/lib/trainee-metrics";

type Props = {
  metrics: TraineeMetrics;
  startDate: string | null | undefined;
  rotationEndDate?: string | null | undefined;
  title?: string;
  subtitle?: string;
};

export function TraineeMetricsCard({ metrics, startDate, rotationEndDate, title = "Metrics", subtitle }: Props) {
  const {
    weeksAtSalisbury,
    weeksRemaining,
    daytimeLists,
    soloLists,
    soloDaytimePct,
    supervisedLists,
    onCallLists,
    onCallPct,
    totalAssignments,
    specialtyBreakdown,
    warnings,
  } = metrics;
  return (
    <Card>
      <CardHeader className="pb-2 p-4 sm:p-6 sm:pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0 sm:p-6 sm:pt-0">
        {warnings.length > 0 ? (
          <div className="space-y-1.5">
            {warnings.map((w) => (
              <div
                key={w.code}
                className={
                  w.level === "warn"
                    ? "rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-200 sm:px-3 sm:py-2"
                    : "rounded-md border border-muted bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground sm:px-3 sm:py-2"
                }
              >
                {w.level === "warn" ? "⚠ " : "ℹ "}
                {w.message}
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
          <Metric
            label="Time at Salisbury"
            value={weeksAtSalisbury === null ? "—" : `${weeksAtSalisbury} wk`}
            sub={
              startDate
                ? `since ${formatDateWithWeekdayGB(startDate)}`
                : "no start date set"
            }
          />
          <Metric
            label="Time left"
            value={weeksRemaining === null ? "—" : `${weeksRemaining} wk`}
            sub={
              rotationEndDate
                ? `until ${formatDateWithWeekdayGB(rotationEndDate)}`
                : "no rotation end date"
            }
          />
          <Metric label="Daytime lists" value={daytimeLists.toString()} sub="theatre AM/PM" />
          <Metric
            label="Solo daytime lists"
            value={soloDaytimePct === null ? "—" : `${soloDaytimePct}%`}
            sub={`${metrics.soloDaytimeLists} of ${daytimeLists}`}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
          <Metric label="Directly supervised" value={supervisedLists.toString()} />
          <Metric label="Solo lists (all)" value={soloLists.toString()} />
          <Metric label="On-call" value={onCallLists.toString()} sub={onCallPct !== null ? `${onCallPct}% of total` : "N/A"} />
          <Metric label="Total assignments" value={totalAssignments.toString()} />
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Lists by surgical specialty</div>
          {specialtyBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No clinical lists recorded.</p>
          ) : (
            <div className="space-y-2">
              {specialtyBreakdown.map((s) => (
                <div key={s.name}>
                  <div className="sm:hidden space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {s.count} · {s.percent}%
                      </span>
                    </div>
                    <Progress value={s.percent} className="h-2" />
                  </div>
                  <div className="hidden sm:flex items-center gap-3 text-sm">
                    <div className="w-40 truncate">{s.name}</div>
                    <div className="flex-1">
                      <Progress value={s.percent} className="h-2" />
                    </div>
                    <div className="w-24 text-right tabular-nums text-muted-foreground">
                      {s.count} · {s.percent}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-card p-2 sm:p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground sm:text-xs">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-muted-foreground sm:text-xs">{sub}</div> : null}
    </div>
  );
}
