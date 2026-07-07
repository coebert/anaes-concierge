/**
 * Admin dashboard: CLWRota sync reliability over time.
 *
 * Charts retry / fallback / success / failure counts from the
 * `clwrota_sync_metrics` table written at the end of every sync run.
 * Lets admins eyeball trends (rising retry rate, per-row fallback spikes,
 * row-failure creep) and confirm the recent backoff/retry changes are
 * actually helping.
 */
// route file is a thin shim — see admin.clwrota-metrics.tsx
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart as RLineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { listClwRotaSyncMetrics } from "@/features/clwrota/clwrota.functions";
import {
  isBackfillMetricRow,
  parseListClwRotaSyncMetricsResponse,
  type ClwRotaSyncMetricRow,
} from "@/lib/clwrota-metrics-types";
import { formatDateGB, formatDateTimeGB } from "@/lib/utils";




type MetricRow = ClwRotaSyncMetricRow;

const WINDOW_OPTIONS = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
] as const;

export function ClwRotaMetricsPage() {
  const [days, setDays] = useState<number>(30);
  const listFn = useServerFn(listClwRotaSyncMetrics);

  const query = useQuery({
    queryKey: ["clwrota-sync-metrics", days],
    queryFn: async () => {
      const raw = await listFn({ data: { days, sync_kind: "all" as const } });
      // Re-validate at the client boundary: every row must carry a strict
      // boolean `is_backfill` before any chart/table consumes it.
      return parseListClwRotaSyncMetricsResponse(raw);
    },
  });

  const rows: MetricRow[] = query.data?.rows ?? [];

  // Aggregate per run-day for the trend charts. We sum across all sync_kind
  // values per day; the table below still shows per-run rows.
  const perDay = useMemo(() => {
    const buckets = new Map<
      string,
      {
        date: string;
        runs: number;
        ok_runs: number;
        failed_runs: number;
        rows_upserted: number;
        rows_failed: number;
        rows_skipped: number;
        rows_deleted: number;
        non_working_cleaned: number;
        chunks_first_try: number;
        chunks_retried: number;
        chunks_fell_back: number;
        upsert_retries: number;
        per_row_failed: number;
        errors: number;
      }
    >();
    for (const r of rows) {
      const date = r.run_at.slice(0, 10);
      const b = buckets.get(date) ?? {
        date,
        runs: 0,
        ok_runs: 0,
        failed_runs: 0,
        rows_upserted: 0,
        rows_failed: 0,
        rows_skipped: 0,
        rows_deleted: 0,
        non_working_cleaned: 0,
        chunks_first_try: 0,
        chunks_retried: 0,
        chunks_fell_back: 0,
        upsert_retries: 0,
        per_row_failed: 0,
        errors: 0,
      };
      b.runs += 1;
      b.ok_runs += r.ok ? 1 : 0;
      b.failed_runs += r.ok ? 0 : 1;
      b.rows_upserted += r.rows_upserted;
      b.rows_failed += r.rows_failed;
      b.rows_skipped += r.rows_skipped_validation;
      b.rows_deleted += r.rows_deleted;
      b.non_working_cleaned += r.non_working_cleaned;
      b.chunks_first_try += r.chunks_succeeded_first_try;
      b.chunks_retried += r.chunks_succeeded_after_retry;
      b.chunks_fell_back += r.chunks_fell_back_to_per_row;
      b.upsert_retries += r.upsert_retries_total;
      b.per_row_failed += r.per_row_failed;
      b.errors += r.errors_count;
      buckets.set(date, b);
    }
    return Array.from(buckets.values()).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
  }, [rows]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.runs += 1;
        acc.ok += r.ok ? 1 : 0;
        acc.failed += r.ok ? 0 : 1;
        acc.upserted += r.rows_upserted;
        acc.failed_rows += r.rows_failed;
        acc.skipped += r.rows_skipped_validation;
        acc.deleted += r.rows_deleted;
        acc.cleaned += r.non_working_cleaned;
        acc.retries += r.upsert_retries_total;
        acc.fallbacks += r.chunks_fell_back_to_per_row;
        return acc;
      },
      {
        runs: 0,
        ok: 0,
        failed: 0,
        upserted: 0,
        failed_rows: 0,
        skipped: 0,
        deleted: 0,
        cleaned: 0,
        retries: 0,
        fallbacks: 0,
      },
    );
  }, [rows]);

  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">CLWRota sync metrics</h1>
          <p className="text-sm text-muted-foreground">
            Reliability of CLWRota syncs over time: retries, fallbacks, succeeded, skipped, failed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {WINDOW_OPTIONS.map((opt) => (
            <Button
              key={opt.days}
              size="sm"
              variant={days === opt.days ? "default" : "outline"}
              onClick={() => setDays(opt.days)}
            >
              {opt.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </header>

      {query.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading metrics…
        </div>
      ) : query.isError ? (
        <Card
          data-testid="clwrota-metrics-error"
          className="border-destructive/50"
        >
          <CardHeader>
            <CardTitle className="text-destructive">
              Couldn't load sync metrics
            </CardTitle>
            <CardDescription>
              The metrics response failed validation, so rows are not being
              rendered to avoid showing unclassified data.
              {query.error instanceof Error ? ` (${query.error.message})` : null}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sync runs in the last {days} days</CardTitle>
            <CardDescription>
              Metrics will appear here automatically after the next CLWRota sync.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5 lg:grid-cols-9">
            <Stat label="Runs" value={totals.runs} />
            <Stat label="OK" value={totals.ok} tone="success" />
            <Stat label="Failed runs" value={totals.failed} tone={totals.failed > 0 ? "danger" : undefined} />
            <Stat label="Upserted" value={totals.upserted} tone="success" />
            <Stat label="Deleted" value={totals.deleted} tone="info" />
            <Stat label="Non-working cleaned" value={totals.cleaned} tone="info" />
            <Stat label="Skipped" value={totals.skipped} tone="info" />
            <Stat label="Failed rows" value={totals.failed_rows} tone="danger" />
            <Stat label="Write retries" value={totals.retries} tone="info" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Rows over time</CardTitle>
              <CardDescription>
                Upserted, deleted, non-working cleaned, skipped (validation), and failed (write) per run day.
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <RLineChart data={perDay} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => formatDateGB(d)} fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={(d: string) => formatDateGB(d)}
                    contentStyle={{ background: "hsl(var(--background))", borderColor: "hsl(var(--border))" }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="rows_upserted" stroke="#10b981" name="Upserted" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="non_working_cleaned" stroke="#0ea5e9" name="Non-working cleaned" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="rows_deleted" stroke="#a855f7" name="Deleted (total)" dot={false} strokeWidth={2} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="rows_skipped" stroke="#3b82f6" name="Skipped" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="rows_failed" stroke="#ef4444" name="Failed" dot={false} strokeWidth={2} />
                </RLineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Run outcome per day</CardTitle>
              <CardDescription>
                Stacked bar of ok vs. failed runs. A spike in red indicates the historical safeguard or another error tripped.
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perDay} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => formatDateGB(d)} fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={(d: string) => formatDateGB(d)}
                    contentStyle={{ background: "hsl(var(--background))", borderColor: "hsl(var(--border))" }}
                  />
                  <Legend />
                  <Bar dataKey="ok_runs" stackId="r" fill="#10b981" name="ok" />
                  <Bar dataKey="failed_runs" stackId="r" fill="#ef4444" name="failed" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>


          <Card>
            <CardHeader>
              <CardTitle>Chunk outcomes per day</CardTitle>
              <CardDescription>
                First-try wins vs. retried vs. fell-back-to-per-row. Stacked bar = total chunks for that day.
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perDay} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => formatDateGB(d)} fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={(d: string) => formatDateGB(d)}
                    contentStyle={{ background: "hsl(var(--background))", borderColor: "hsl(var(--border))" }}
                  />
                  <Legend />
                  <Bar dataKey="chunks_first_try" stackId="c" fill="#10b981" name="First try" />
                  <Bar dataKey="chunks_retried" stackId="c" fill="#f59e0b" name="Retried (won)" />
                  <Bar dataKey="chunks_fell_back" stackId="c" fill="#ef4444" name="Fell back to per-row" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Write retries &amp; per-row failures per day</CardTitle>
              <CardDescription>
                Background pressure indicator: total upsert retries and rows that failed every retry.
              </CardDescription>
            </CardHeader>
            <CardContent className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <RLineChart data={perDay} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" tickFormatter={(d: string) => formatDateGB(d)} fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={(d: string) => formatDateGB(d)}
                    contentStyle={{ background: "hsl(var(--background))", borderColor: "hsl(var(--border))" }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="upsert_retries" stroke="#f59e0b" name="Write retries" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="per_row_failed" stroke="#ef4444" name="Per-row failed" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="errors" stroke="#7c3aed" name="Errors logged" dot={false} strokeWidth={2} />
                </RLineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>Newest first. Most recent {Math.min(rows.length, 50)} of {rows.length}.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Kind</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Pulled</th>
                    <th className="py-2 pr-3 text-right">Upserted</th>
                    <th className="py-2 pr-3 text-right">Skipped</th>
                    <th className="py-2 pr-3 text-right">Deleted</th>
                    <th className="py-2 pr-3 text-right">Cleaned</th>
                    <th className="py-2 pr-3 text-right">Failed</th>
                    <th className="py-2 pr-3 text-right">Retries</th>
                    <th className="py-2 pr-3 text-right">Fell back</th>
                    <th className="py-2 pr-3 text-right">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice().reverse().slice(0, 50).map((r) => {
                    const isBackfill = isBackfillMetricRow(r);
                    return (
                      <tr key={r.id} className={`border-t border-border ${isBackfill ? "bg-amber-50/40" : ""}`}>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          {new Date(r.run_at).toLocaleString("en-GB")}
                          {isBackfill && (
                            <Badge variant="outline" className="ml-2 text-warning border-amber-300 bg-amber-100">
                              Backfill
                            </Badge>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">{r.sync_kind}</td>
                        <td className="py-1.5 pr-3">
                          <Badge variant={r.ok ? "secondary" : "destructive"}>
                            {r.ok ? "ok" : "errors"}
                          </Badge>
                        </td>
                        <td className="py-1.5 pr-3 text-right">{r.rows_pulled}</td>
                        <td className="py-1.5 pr-3 text-right text-success">{r.rows_upserted}</td>
                        <td className="py-1.5 pr-3 text-right text-blue-600">{r.rows_skipped_validation}</td>
                        <td className="py-1.5 pr-3 text-right text-purple-600">{r.rows_deleted}</td>
                        <td className="py-1.5 pr-3 text-right text-sky-600">{r.non_working_cleaned}</td>
                        <td className="py-1.5 pr-3 text-right text-destructive">{r.rows_failed}</td>
                        <td className="py-1.5 pr-3 text-right">{r.upsert_retries_total}</td>
                        <td className="py-1.5 pr-3 text-right">{r.chunks_fell_back_to_per_row}</td>
                        <td className="py-1.5 pr-3 text-right text-muted-foreground">
                          {r.duration_ms == null ? "—" : `${(r.duration_ms / 1000).toFixed(1)}s`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "info" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-destructive"
        : tone === "info"
          ? "text-blue-600"
          : "text-foreground";
  return (
    <div className="rounded border border-border bg-muted/30 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${toneClass}`}>{value.toLocaleString()}</div>
    </div>
  );
}
