/**
 * Admin status page for CLWRota syncs.
 *
 * Shows three things at a glance:
 *   1. Sync state — last run, last fully-successful rota run (the
 *      "high water mark" incremental syncs use), and the configured
 *      sync windows (full + incremental).
 *   2. Recent metrics rows from `clwrota_sync_metrics`, grouped per
 *      step (staff / rota / leave), so admins can spot creeping
 *      failures or skipped rows.
 *   3. Recent cron-job runs from `cron.job_run_details` for every
 *      `clwrota%` scheduled job, so admins can confirm pg_cron is
 *      actually firing and see the postgres-side return code.
 *
 * Loaded via `getClwRotaSyncStatus` which itself enforces the admin
 * role and switches to `supabaseAdmin` after the role check so it
 * can read the locked-down cron helper.
 */
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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
import { Loader2, RefreshCw, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import {
  getClwRotaSyncStatus,
  type ClwRotaCronRow,
  type ClwRotaMetricRow,
} from "@/lib/clwrota-status.functions";

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function relativeFrom(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "";
  const diffMs = Date.now() - d;
  const sec = Math.round(diffMs / 1000);
  const abs = Math.abs(sec);
  if (abs < 60) return sec >= 0 ? `${sec}s ago` : `in ${-sec}s`;
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return min >= 0 ? `${min}m ago` : `in ${-min}m`;
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 48) return hr >= 0 ? `${hr}h ago` : `in ${-hr}h`;
  const day = Math.round(hr / 24);
  return day >= 0 ? `${day}d ago` : `in ${-day}d`;
}

function statusBadge(status: string | null | undefined) {
  const s = (status ?? "").toLowerCase();
  if (s === "succeeded" || s === "success" || s.includes("rota_success") || s === "ok") {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> {status ?? "ok"}
      </Badge>
    );
  }
  if (s === "failed" || s.includes("error") || s.includes("fail")) {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> {status ?? "failed"}
      </Badge>
    );
  }
  if (s.includes("warning") || s === "partial" || s.includes("partial")) {
    return (
      <Badge variant="outline" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> {status ?? "warning"}
      </Badge>
    );
  }
  return <Badge variant="outline">{status ?? "—"}</Badge>;
}

function groupCronByJob(cron: ClwRotaCronRow[]): Map<string, ClwRotaCronRow[]> {
  const out = new Map<string, ClwRotaCronRow[]>();
  for (const row of cron) {
    const list = out.get(row.jobname) ?? [];
    list.push(row);
    out.set(row.jobname, list);
  }
  return out;
}

function groupMetricsByKind(metrics: ClwRotaMetricRow[]): Map<string, ClwRotaMetricRow[]> {
  const out = new Map<string, ClwRotaMetricRow[]>();
  for (const m of metrics) {
    const list = out.get(m.sync_kind) ?? [];
    list.push(m);
    out.set(m.sync_kind, list);
  }
  return out;
}

export function ClwRotaStatusPage() {
  const fetchStatus = useServerFn(getClwRotaSyncStatus);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["clwrota-sync-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 60_000,
  });

  const cronByJob = useMemo<Map<string, ClwRotaCronRow[]>>(
    () => (data ? groupCronByJob(data.cron) : new Map()),
    [data],
  );
  const metricsByKind = useMemo<Map<string, ClwRotaMetricRow[]>>(
    () => (data ? groupMetricsByKind(data.metrics) : new Map()),
    [data],
  );

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading CLWRota sync status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn't load CLWRota sync status
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

  const state = data?.state ?? null;

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">CLWRota sync status</h1>
          <p className="text-sm text-muted-foreground">
            Live view of the latest sync outcomes and scheduled cron-job runs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Sync state ----------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Current sync state</CardTitle>
          <CardDescription>
            The `last_successful_rota_sync_at` timestamp is the high-water mark
            used by incremental rota syncs to compute their date window.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Last sync attempt</dt>
              <dd className="font-medium">{fmtDate(state?.last_sync_at)}</dd>
              <dd className="text-xs text-muted-foreground">{relativeFrom(state?.last_sync_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last successful rota sync</dt>
              <dd className="font-medium">
                {fmtDate(state?.last_successful_rota_sync_at)}
              </dd>
              <dd className="text-xs text-muted-foreground">
                {relativeFrom(state?.last_successful_rota_sync_at)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Last status</dt>
              <dd>{statusBadge(state?.last_status ?? null)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Rows pulled (last run)</dt>
              <dd className="font-medium">{state?.last_pulled_rows ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Full sync window</dt>
              <dd className="font-medium">
                {state?.sync_days_back ?? "—"}d back · {state?.sync_days_ahead ?? "—"}d ahead
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Incremental sync window</dt>
              <dd className="font-medium">
                {state?.incremental_days_back ?? "—"}d back ·{" "}
                {state?.incremental_days_ahead ?? "—"}d ahead
              </dd>
            </div>
          </dl>
          {state?.last_error ? (
            <div className="mt-4 rounded border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <div className="font-medium text-destructive">Last error / warning</div>
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-destructive/90">
                {state.last_error}
              </pre>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Recent metrics, per step -------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(["staff", "rota", "leave"] as const).map((kind) => {
          const rows = (metricsByKind.get(kind) ?? []).slice(0, 10);
          return (
            <Card key={kind}>
              <CardHeader className="pb-3">
                <CardTitle className="capitalize text-base">{kind} sync — recent runs</CardTitle>
                <CardDescription>
                  Latest entries from{" "}
                  <code className="text-xs">clwrota_sync_metrics</code>.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {rows.length === 0 ? (
                  <p className="px-6 pb-6 text-sm text-muted-foreground">
                    No runs recorded yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>OK</TableHead>
                        <TableHead className="text-right">Pulled</TableHead>
                        <TableHead className="text-right">Upserted</TableHead>
                        <TableHead className="text-right">Failed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap text-xs">
                            <div>{fmtDate(r.run_at)}</div>
                            <div className="text-muted-foreground">
                              {relativeFrom(r.run_at)}
                            </div>
                          </TableCell>
                          <TableCell>
                            {r.ok ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="ok" />
                            ) : (
                              <XCircle className="h-4 w-4 text-destructive" aria-label="failed" />
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.rows_pulled}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.rows_upserted}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {r.rows_failed + r.rows_skipped_validation}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Cron history -------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Scheduled cron jobs</CardTitle>
          <CardDescription>
            Latest invocations of each <code className="text-xs">clwrota%</code> pg_cron job.
            "Succeeded" here means postgres dispatched the HTTP call without erroring; the
            HTTP response body is recorded in the metrics table above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {[...cronByJob.entries()].map(([jobname, runs]) => {
            const first = runs[0];
            return (
              <div key={jobname}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                  <div>
                    <div className="font-medium">{jobname}</div>
                    <div className="text-xs text-muted-foreground">
                      schedule <code>{first?.schedule}</code>
                      {first && !first.active ? (
                        <span className="ml-2 text-destructive">(inactive)</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                {runs.every((r) => r.runid == null) ? (
                  <p className="text-sm text-muted-foreground">No runs yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Started</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs
                        .filter((r) => r.runid != null)
                        .slice(0, 6)
                        .map((r) => {
                          const dur =
                            r.start_time && r.end_time
                              ? `${Math.max(
                                  0,
                                  Math.round(
                                    (new Date(r.end_time).getTime() -
                                      new Date(r.start_time).getTime()) /
                                      1000,
                                  ),
                                )}s`
                              : "—";
                          return (
                            <TableRow key={r.runid ?? `${jobname}-na`}>
                              <TableCell className="whitespace-nowrap text-xs">
                                <div>{fmtDate(r.start_time)}</div>
                                <div className="text-muted-foreground">
                                  {relativeFrom(r.start_time)}
                                </div>
                              </TableCell>
                              <TableCell>{statusBadge(r.status)}</TableCell>
                              <TableCell className="text-xs tabular-nums">{dur}</TableCell>
                              <TableCell className="max-w-[420px]">
                                <div className="truncate text-xs text-muted-foreground" title={r.return_message ?? ""}>
                                  {r.return_message ?? "—"}
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                )}
              </div>
            );
          })}
          {cronByJob.size === 0 ? (
            <p className="text-sm text-muted-foreground">
              No CLWRota cron jobs are scheduled.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
