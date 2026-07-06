import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { IcuBlockBadge } from "@/components/trainees/IcuBlockBadge";
import { formatDateWithWeekdayGB } from "@/lib/utils";
import type { TraineeMetrics } from "@/features/trainees/trainee-metrics";


type Props = {
  metrics: TraineeMetrics;
  startDate: string | null | undefined;
  rotationEndDate?: string | null | undefined;
  icuBlockOnly?: boolean;
  title?: string;
  subtitle?: string;
};

export function TraineeMetricsCard({ metrics, startDate, rotationEndDate, icuBlockOnly = false, title = "Metrics", subtitle }: Props) {
  const {
    weeksAtSalisbury,
    weeksRemaining,
    daytimeLists,
    soloLists,
    soloDaytimePct,
    supervisedLists,
    onCallLists,
    onCallPct,
    icuLists,
    obstetricsLists,
    totalAssignments,
    specialtyBreakdown,
    warnings,
  } = metrics;
  const regionLabel = subtitle ? `${title} — ${subtitle}` : title;

  // Build a stable signature of the metrics that should trigger an announcement.
  const warningSig = warnings.map((w) => `${w.level}:${w.code}`).join("|");
  const specialtySig = specialtyBreakdown
    .map((s) => `${s.name}:${s.count}:${s.percent}`)
    .join("|");
  const announcement = useAnnouncement({
    warnings,
    warningSig,
    specialtyBreakdown,
    specialtySig,
    regionLabel,
  });

  return (
    <Card aria-label={regionLabel}>
      {/* Off-screen polite live region: announces post-mount changes only. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <CardHeader className="pb-2 p-4 sm:p-6 sm:pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>{title}</span>
          {icuBlockOnly ? <IcuBlockBadge /> : null}
        </CardTitle>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0 sm:p-6 sm:pt-0">
        {warnings.length > 0 ? (
          <ul
            className="space-y-1.5 list-none p-0"
            aria-label="Data quality warnings"
          >
            {warnings.map((w) => (
              <li
                key={w.code}
                className={
                  w.level === "warn"
                    ? "rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-sm text-amber-900 dark:text-amber-200 sm:px-3 sm:py-2"
                    : "rounded-md border border-muted bg-muted/40 px-2 py-1.5 text-sm text-muted-foreground sm:px-3 sm:py-2"
                }
              >
                <span aria-hidden="true">{w.level === "warn" ? "⚠ " : "ℹ "}</span>
                <span className="sr-only">{w.level === "warn" ? "Warning: " : "Info: "}</span>
                {w.message}
              </li>
            ))}
          </ul>
        ) : null}

        <dl className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
          <Metric
            label="Time at Salisbury"
            value={weeksAtSalisbury === null ? "—" : `${weeksAtSalisbury} wk`}
            valueAria={weeksAtSalisbury === null ? "no data" : `${weeksAtSalisbury} weeks`}
            sub={
              startDate
                ? `since ${formatDateWithWeekdayGB(startDate)}`
                : "no start date set"
            }
          />
          <Metric
            label="Time left"
            value={weeksRemaining === null ? "—" : `${weeksRemaining} wk`}
            valueAria={weeksRemaining === null ? "no data" : `${weeksRemaining} weeks`}
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
            valueAria={
              soloDaytimePct === null
                ? "no data"
                : `${soloDaytimePct} percent, ${metrics.soloDaytimeLists} of ${daytimeLists}`
            }
            sub={`${metrics.soloDaytimeLists} of ${daytimeLists}`}
          />
        </dl>
        <dl className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
          <Metric label="Directly supervised" value={supervisedLists.toString()} />
          <Metric label="Solo lists (all)" value={soloLists.toString()} />
          <Metric
            label="On-call"
            value={onCallLists.toString()}
            sub={onCallPct !== null ? `${onCallPct}% of total` : "N/A"}
          />
          <Metric label="Total assignments" value={totalAssignments.toString()} />
        </dl>
        <dl className="grid grid-cols-2 gap-2 sm:gap-3 sm:grid-cols-4">
          <Metric label="ICU shifts" value={icuLists.toString()} sub="whole-day shifts (AM+PM count as 1)" />
          <Metric label="Obstetrics shifts" value={obstetricsLists.toString()} sub="labour ward" />
        </dl>

        <section aria-labelledby={`specialty-heading-${title.replace(/\s+/g, "-")}`}>
          <h3
            id={`specialty-heading-${title.replace(/\s+/g, "-")}`}
            className="mb-2 text-sm font-medium"
          >
            Lists by surgical specialty
          </h3>
          {specialtyBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No clinical lists recorded.</p>
          ) : (
            <ul className="space-y-2 list-none p-0">
              {specialtyBreakdown.map((s) => (
                <li key={s.name}>
                  <div className="sm:hidden space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {s.count} · {s.percent}%
                      </span>
                    </div>
                    <Progress
                      value={s.percent}
                      className="h-2"
                      aria-label={`${s.name}: ${s.count} lists, ${s.percent} percent`}
                    />
                  </div>
                  <div className="hidden sm:flex items-center gap-3 text-sm">
                    <div className="w-40 truncate">{s.name}</div>
                    <div className="flex-1">
                      <Progress
                        value={s.percent}
                        className="h-2"
                        aria-label={`${s.name}: ${s.count} lists, ${s.percent} percent`}
                      />
                    </div>
                    <div className="w-24 text-right tabular-nums text-muted-foreground">
                      {s.count} · {s.percent}%
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  valueAria,
  sub,
}: {
  label: string;
  value: string;
  valueAria?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border bg-card p-2 sm:p-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl"
        aria-label={valueAria ?? `${label}: ${value}`}
      >
        {value}
      </dd>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/**
 * Computes a polite live-region message when warnings or specialty data
 * change after the initial mount. Returns "" on first render so screen
 * readers do not announce the card's initial state.
 */
function useAnnouncement({
  warnings,
  warningSig,
  specialtyBreakdown,
  specialtySig,
  regionLabel,
}: {
  warnings: TraineeMetrics["warnings"];
  warningSig: string;
  specialtyBreakdown: TraineeMetrics["specialtyBreakdown"];
  specialtySig: string;
  regionLabel: string;
}) {
  const mountedRef = useRef(false);
  const prevWarnSigRef = useRef(warningSig);
  const prevSpecSigRef = useRef(specialtySig);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevWarnSigRef.current = warningSig;
      prevSpecSigRef.current = specialtySig;
      return;
    }

    const parts: string[] = [];

    if (warningSig !== prevWarnSigRef.current) {
      const prevCodes = new Set(
        prevWarnSigRef.current.split("|").filter(Boolean),
      );
      const added = warnings.filter(
        (w) => !prevCodes.has(`${w.level}:${w.code}`),
      );
      if (added.length > 0) {
        parts.push(
          `${regionLabel}: ${added
            .map((w) => `${w.level === "warn" ? "Warning" : "Info"} — ${w.message}`)
            .join(". ")}.`,
        );
      } else if (warnings.length === 0) {
        parts.push(`${regionLabel}: all warnings cleared.`);
      }
      prevWarnSigRef.current = warningSig;
    }

    if (specialtySig !== prevSpecSigRef.current) {
      const total = specialtyBreakdown.reduce((sum, s) => sum + s.count, 0);
      const top = specialtyBreakdown[0];
      parts.push(
        top
          ? `Specialty breakdown updated: ${specialtyBreakdown.length} specialties, ${total} lists. Top: ${top.name} at ${top.percent} percent.`
          : `Specialty breakdown updated: no clinical lists recorded.`,
      );
      prevSpecSigRef.current = specialtySig;
    }

    if (parts.length > 0) {
      // Toggle to force re-announcement even if text is identical.
      setMessage("");
      const id = setTimeout(() => setMessage(parts.join(" ")), 50);
      return () => clearTimeout(id);
    }
  }, [warningSig, specialtySig, warnings, specialtyBreakdown, regionLabel]);

  return message;
}

