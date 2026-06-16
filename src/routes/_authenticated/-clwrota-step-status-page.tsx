/**
 * Per-step CLWRota sync status page.
 *
 * Surfaces, for each of staff / rota / leave:
 *   - The most recent `clwrota_sync_metrics` row (when it ran, whether it
 *     succeeded, row counts, and any notes/errors).
 *   - The shared rate-limiter row from `clwrota_sync_rate_limit`: when the
 *     last attempt was fired, the configured minimum interval, and when
 *     the next attempt will be allowed.
 *
 * Also shows the latest runs of the consolidated `clwrota-sync-hourly-all`
 * cron job, with each step decoded as "fired" / "skipped" so admins can see
 * the rate-limiter decisions over time.
 */
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Ban,
  CircleHelp,
  Play,
} from "lucide-react";
import {
  getClwRotaStepStatus,
  runClwRotaStepRateLimited,
  type RunStepResult,
  type SyncStep,
} from "@/lib/clwrota-step-status.functions";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function relativeFrom(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const sec = Math.round((Date.now() - d) / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return sec >= 0 ? `${sec}s ago` : `in ${-sec}s`;
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return min >= 0 ? `${min}m ago` : `in ${-min}m`;
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 48) return hr >= 0 ? `${hr}h ago` : `in ${-hr}h`;
  const day = Math.round(hr / 24);
  return day >= 0 ? `${day}d ago` : `in ${-day}d`;
}

function fmtInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round((min / 60) * 10) / 10;
  return `${hr} h`;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function decisionBadge(d: "fired" | "skipped" | "unknown") {
  if (d === "fired") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Zap className="h-3 w-3" /> fired
      </Badge>
    );
  }
  if (d === "skipped") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <Ban className="h-3 w-3" /> skipped
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <CircleHelp className="h-3 w-3" /> —
    </Badge>
  );
}

export function ClwRotaStepStatusPage() {
  const fetchStatus = useServerFn(getClwRotaStepStatus);
  const runStep = useServerFn(runClwRotaStepRateLimited);
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["clwrota-step-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 60_000,
  });

  const runMutation = useMutation<RunStepResult, Error, SyncStep>({
    mutationFn: (step) => runStep({ data: { step } }),
    onSuccess: (result) => {
      if (result.fired) {
        toast.success(
          `${result.step} sync dispatched (request #${result.requestId}).`,
        );
      } else {
        toast.info(
          `${result.step} sync skipped — rate-limiter says it ran too recently (or another run is in flight).`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["clwrota-step-status"] });
    },
    onError: (err) => {
      toast.error(`Could not run sync: ${err.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading CLWRota step status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn't load CLWRota step status
            </CardTitle>
            <CardDescription>{(error as Error).message}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const steps = data?.steps ?? [];
  const runs = data?.rateLimiterRuns ?? [];

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">CLWRota step status</h1>
          <p className="text-sm text-muted-foreground">
            Last run, success state, and rate-limiter decisions for each
            sync step.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Per-step cards ------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {steps.map(({ step, latest, rateLimit }) => {
          const next = rateLimit?.next_allowed_at;
          const nextMs = next ? new Date(next).getTime() - Date.now() : null;
          const ready = nextMs == null || nextMs <= 0;
          return (
            <Card key={step}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="capitalize text-base">
                    {step} sync
                  </CardTitle>
                  {latest ? (
                    latest.ok ? (
                      <Badge variant="secondary" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> ok
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="gap-1">
                        <XCircle className="h-3 w-3" /> failed
                      </Badge>
                    )
                  ) : (
                    <Badge variant="outline">no runs</Badge>
                  )}
                </div>
                <CardDescription>
                  {latest
                    ? `Last ran ${relativeFrom(latest.run_at)}`
                    : "No sync has been recorded yet."}
                </CardDescription>
                <div className="pt-2">
                  <Button
                    size="sm"
                    variant={ready ? "default" : "outline"}
                    onClick={() => runMutation.mutate(step)}
                    disabled={
                      runMutation.isPending && runMutation.variables === step
                    }
                    title={
                      ready
                        ? `Run ${step} sync now`
                        : `Rate-limiter will likely skip this — next allowed ${
                            next ? relativeFrom(next) : "soon"
                          }`
                    }
                  >
                    {runMutation.isPending && runMutation.variables === step ? (
                      <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3 mr-2" />
                    )}
                    Run {step} sync
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Last run</dt>
                    <dd className="font-medium">{fmtDate(latest?.run_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Duration</dt>
                    <dd className="font-medium tabular-nums">
                      {fmtDuration(latest?.duration_ms ?? null)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Pulled</dt>
                    <dd className="font-medium tabular-nums">
                      {latest?.rows_pulled ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Upserted</dt>
                    <dd className="font-medium tabular-nums">
                      {latest?.rows_upserted ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Failed</dt>
                    <dd
                      className={`font-medium tabular-nums ${
                        latest && latest.rows_failed > 0
                          ? "text-destructive"
                          : ""
                      }`}
                    >
                      {latest?.rows_failed ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Skipped (validation)
                    </dt>
                    <dd className="font-medium tabular-nums">
                      {latest?.rows_skipped_validation ?? "—"}
                    </dd>
                  </div>
                </dl>

                {latest?.notes ? (
                  <div className="rounded border border-border bg-muted/30 p-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      Notes
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-xs">
                      {latest.notes}
                    </pre>
                  </div>
                ) : null}

                {latest && !latest.ok ? (
                  <div className="rounded border border-destructive/40 bg-destructive/5 p-2">
                    <div className="text-xs font-medium text-destructive">
                      Last run failed
                      {latest.errors_count > 0
                        ? ` — ${latest.errors_count} error${
                            latest.errors_count === 1 ? "" : "s"
                          }`
                        : ""}
                    </div>
                  </div>
                ) : null}

                {/* Rate-limiter sub-card */}
                <div className="rounded border border-border p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    <Clock className="h-3 w-3" /> Rate-limiter
                  </div>
                  {rateLimit ? (
                    <dl className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">
                          Minimum interval
                        </dt>
                        <dd className="font-medium">
                          {fmtInterval(rateLimit.min_interval_seconds)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Last attempt</dt>
                        <dd className="font-medium">
                          {rateLimit.last_attempt_at
                            ? relativeFrom(rateLimit.last_attempt_at)
                            : "never"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Next allowed</dt>
                        <dd
                          className={`font-medium ${
                            ready ? "text-emerald-600" : ""
                          }`}
                        >
                          {ready
                            ? "now"
                            : next
                              ? relativeFrom(next).replace("ago", "ago (overdue)").startsWith("in ")
                                ? relativeFrom(next)
                                : `in ${Math.max(1, Math.round((nextMs ?? 0) / 60000))}m`
                              : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          Last request id
                        </dt>
                        <dd className="font-medium tabular-nums">
                          {rateLimit.last_request_id ?? "—"}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No rate-limiter row found for this step.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Rate-limiter decision history --------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Rate-limiter decisions</CardTitle>
          <CardDescription>
            Recent runs of <code className="text-xs">clwrota-sync-hourly-all</code>.
            Each row shows which steps the shared rate-limiter fired and which
            it skipped (interval not yet elapsed, or another sync in flight).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No consolidated rate-limited runs recorded yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                  {(["staff", "rota", "leave"] as SyncStep[]).map((s) => (
                    <TableHead key={s} className="capitalize">
                      {s}
                    </TableHead>
                  ))}
                  <TableHead>Return message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.runid ?? `${r.start_time}`}>
                    <TableCell className="whitespace-nowrap text-xs">
                      <div>{fmtDate(r.start_time)}</div>
                      <div className="text-muted-foreground">
                        {relativeFrom(r.start_time)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          (r.status ?? "").toLowerCase() === "succeeded"
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {r.status ?? "—"}
                      </Badge>
                    </TableCell>
                    {(["staff", "rota", "leave"] as SyncStep[]).map((s) => (
                      <TableCell key={s}>
                        {decisionBadge(r.decisions[s])}
                      </TableCell>
                    ))}
                    <TableCell className="max-w-[320px]">
                      <div
                        className="truncate text-xs text-muted-foreground"
                        title={r.return_message ?? ""}
                      >
                        {r.return_message ?? "—"}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
