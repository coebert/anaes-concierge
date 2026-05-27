import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatDateWithWeekdayGB } from "@/lib/utils";
import type { TraineeMetrics } from "@/lib/trainee-metrics";

type Props = {
  metrics: TraineeMetrics;
  startDate: string | null | undefined;
  title?: string;
  subtitle?: string;
};

export function TraineeMetricsCard({ metrics, startDate, title = "Metrics", subtitle }: Props) {
  const {
    weeksAtSalisbury,
    daytimeLists,
    soloLists,
    supervisedLists,
    onCallLists,
    totalAssignments,
    specialtyBreakdown,
  } = metrics;
  const onCallPct = totalAssignments > 0 ? Math.round((onCallLists / totalAssignments) * 1000) / 10 : 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label="Time at Salisbury"
            value={weeksAtSalisbury === null ? "—" : `${weeksAtSalisbury} wk`}
            sub={
              startDate
                ? `since ${formatDateWithWeekdayGB(startDate)}`
                : "no start date set"
            }
          />
          <Metric label="Daytime lists" value={daytimeLists.toString()} sub="theatre AM/PM" />
          <Metric label="Directly supervised" value={supervisedLists.toString()} />
          <Metric label="Solo lists" value={soloLists.toString()} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="On-call" value={onCallLists.toString()} sub={`${onCallPct}% of total`} />
          <Metric label="Total assignments" value={totalAssignments.toString()} />
          <Metric label="Clinical lists" value={metrics.totalClinical.toString()} />
          <Metric label="Non-clinical" value={(totalAssignments - metrics.totalClinical).toString()} />
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Lists by surgical specialty</div>
          {specialtyBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No clinical lists recorded.</p>
          ) : (
            <div className="space-y-2">
              {specialtyBreakdown.map((s) => (
                <div key={s.name} className="flex items-center gap-3 text-sm">
                  <div className="w-40 truncate">{s.name}</div>
                  <div className="flex-1">
                    <Progress value={s.percent} className="h-2" />
                  </div>
                  <div className="w-24 text-right tabular-nums text-muted-foreground">
                    {s.count} · {s.percent}%
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
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
