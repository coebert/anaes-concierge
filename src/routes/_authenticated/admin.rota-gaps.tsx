import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  computeRotaGaps, classifyRotaGaps, GAP_KIND_LABEL,
  type GapRange, type ClassifiedGapRange, type GapKind,
} from "@/lib/rota-gaps";
import { fetchAllRowsPaged, rotaAssignmentKey } from "@/lib/audit/paginate";
import { syncClwRotaRota } from "@/lib/clwrota.functions";
import { formatDateGB, todayISO } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import { AlertTriangle, CheckCircle2, CalendarX, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/rota-gaps")({
  component: RotaGapsPage,
});

type WindowChoice = "30" | "90" | "180" | "rotation";
const WINDOW_LABEL: Record<WindowChoice, string> = {
  "30": "Last 30 days",
  "90": "Last 90 days",
  "180": "Last 6 months",
  rotation: "Full rotation",
};

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * A single trainee's sync_missing span, tagged with the metrics needed to
 * prioritise it: how many working days are missing and which trainee it
 * belongs to (so merged spans can count distinct trainees covered).
 */
interface SpanInput {
  startISO: string;
  endISO: string;
  missingDays: number;
  traineeId: string;
}

export interface MergedSpan {
  startISO: string;
  endISO: string;
  /** Sum of missing weekdays across every trainee gap inside this span. */
  missingDays: number;
  /** Distinct trainees with at least one gap inside this span. */
  trainees: number;
}

/**
 * Merge overlapping or near-adjacent date ranges so a single targeted sync
 * can cover several trainees' sync_missing gaps in one request. We pad the
 * join distance by `bridgeDays` (default 7) because the upstream CLWRota
 * report is windowed and one slightly wider request is cheaper than many
 * narrow ones. Aggregated `missingDays` / `trainees` metrics drive the
 * prioritisation selector — the caller decides which merged span to sync
 * first when time or API limits apply.
 */
export function mergeRanges(spans: SpanInput[], bridgeDays = 7): MergedSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) =>
    a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0,
  );
  type Acc = MergedSpan & { traineeSet: Set<string> };
  const acc: Acc[] = [];
  for (const s of sorted) {
    const last = acc[acc.length - 1];
    if (last && s.startISO <= addDaysISO(last.endISO, bridgeDays)) {
      if (s.endISO > last.endISO) last.endISO = s.endISO;
      last.missingDays += s.missingDays;
      last.traineeSet.add(s.traineeId);
      last.trainees = last.traineeSet.size;
    } else {
      const set = new Set<string>([s.traineeId]);
      acc.push({
        startISO: s.startISO,
        endISO: s.endISO,
        missingDays: s.missingDays,
        trainees: 1,
        traineeSet: set,
      });
    }
  }
  return acc.map(({ traineeSet: _omit, ...m }) => m);
}

export type SyncPriority = "coverage" | "recency" | "trainees";

const PRIORITY_LABEL: Record<SyncPriority, string> = {
  coverage: "Most missing days first",
  recency: "Most recent gaps first",
  trainees: "Most trainees affected first",
};

export function prioritiseSpans(spans: MergedSpan[], priority: SyncPriority): MergedSpan[] {
  const sorted = [...spans];
  switch (priority) {
    case "coverage":
      sorted.sort((a, b) =>
        b.missingDays - a.missingDays ||
        (a.startISO < b.startISO ? 1 : a.startISO > b.startISO ? -1 : 0),
      );
      break;
    case "recency":
      sorted.sort((a, b) =>
        (a.endISO < b.endISO ? 1 : a.endISO > b.endISO ? -1 : 0) ||
        b.missingDays - a.missingDays,
      );
      break;
    case "trainees":
      sorted.sort((a, b) =>
        b.trainees - a.trainees ||
        b.missingDays - a.missingDays,
      );
      break;
  }
  return sorted;
}

type SyncResult = Awaited<ReturnType<typeof syncClwRotaRota>>;

/**
 * Snapshot of the rota-gaps query result used by the post-sync verification
 * step to count how many sync-missing weekdays exist inside a date span,
 * across every trainee whose rotation overlaps it.
 */
type GapSnapshot = {
  trainees: Array<{
    id: string;
    start_date: string | null;
    rotation_end_date: string | null;
    ltft_days_off: number[] | null;
  }>;
  datesByStaff: Map<string, Set<string>>;
  today: string;
};

const MS_DAY_LOCAL = 86_400_000;

function isoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Count working weekdays (excluding weekends and the trainee's LTFT off
 * days) in `[fromISO, toISO]` that lie inside the trainee's rotation
 * window and have no rota assignment. Used by the post-sync verification
 * step to compute `filled = before - after` per synced range.
 */
export function countSyncMissingInSpan(
  snap: GapSnapshot,
  fromISO: string,
  toISO: string,
): number {
  if (fromISO > toISO) return 0;
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  let missing = 0;
  for (const t of snap.trainees) {
    const offSet = new Set<number>([0, 6, ...((t.ltft_days_off ?? []) as number[])]);
    const rotStart = t.start_date ?? null;
    const rotEnd = t.rotation_end_date ?? snap.today;
    const dates = snap.datesByStaff.get(t.id) ?? new Set<string>();
    for (let dt = new Date(from); dt.getTime() <= to.getTime(); dt = new Date(dt.getTime() + MS_DAY_LOCAL)) {
      const iso = isoFromDate(dt);
      if (rotStart && iso < rotStart) continue;
      if (iso > rotEnd) continue;
      if (offSet.has(dt.getDay())) continue;
      if (dates.has(iso)) continue;
      missing += 1;
    }
  }
  return missing;
}

interface SyncProgress {
  running: boolean;
  current: number;
  total: number;
  perRange: Array<{
    from: string;
    to: string;
    ok: boolean;
    message?: string;
    upserted?: number;
    /** Sync-missing weekdays in this range before the sync ran. */
    gapsBefore?: number;
    /** Sync-missing weekdays in this range after the post-sync refetch. */
    gapsAfter?: number;
    /** `gapsBefore − gapsAfter`; negative values are clamped to 0. */
    gapsFilled?: number;
  }>;
  error?: string;
}

function RotaGapsPage() {
  const { hasRole, loading } = useAuth();
  const queryClient = useQueryClient();
  const syncRota = useServerFn(syncClwRotaRota);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("90");
  const [filter, setFilter] = useState("");
  const [hideClean, setHideClean] = useState(true);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [priority, setPriority] = useState<SyncPriority>("coverage");
  const [runLimit, setRunLimit] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["rota-gaps", windowChoice],
    queryFn: async () => {
      const today = todayISO();
      const since =
        windowChoice === "rotation"
          ? null
          : addDaysISO(today, -parseInt(windowChoice));

      const { data: trainees, error: e1 } = await supabase
        .from("profiles")
        .select("id, full_name, training_level, start_date, rotation_end_date, ltft_days_off")
        .eq("grade", "trainee")
        .eq("active", true)
        .order("full_name");
      if (e1) throw e1;

      const ids = (trainees ?? []).map((t) => t.id);
      if (!ids.length) return { trainees: [], datesByStaff: new Map<string, Set<string>>(), today };

      // Paginate via the shared helper: deterministic order + boundary
      // overlap detection + dedupe by (staff, date, session).
      const all = await fetchAllRowsPaged<{
        staff_id: string;
        session_date: string;
        session: string;
      }>(
        (from, to) => {
          let q = supabase
            .from("rota_assignments")
            .select("staff_id, session_date, session")
            .in("staff_id", ids)
            .order("session_date", { ascending: true })
            .order("staff_id", { ascending: true })
            .order("session", { ascending: true })
            .range(from, to);
          if (since) q = q.gte("session_date", since);
          return q;
        },
        { rowKey: rotaAssignmentKey, label: "rota-gaps.rota_assignments" },
      );


      const datesByStaff = new Map<string, Set<string>>();
      for (const r of all) {
        let set = datesByStaff.get(r.staff_id);
        if (!set) {
          set = new Set();
          datesByStaff.set(r.staff_id, set);
        }
        set.add(r.session_date);
      }
      return { trainees: trainees ?? [], datesByStaff, today, since };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const today = data.today;
    return data.trainees
      .map((t) => {
        const dates = data.datesByStaff.get(t.id) ?? new Set<string>();
        // Window = max(rotation start, lookback start) → min(rotation end, today)
        const lookbackStart = data.since ?? t.start_date ?? today;
        const startISO = [t.start_date ?? lookbackStart, lookbackStart]
          .sort()
          .reverse()[0]; // later of the two
        const endISO = [t.rotation_end_date ?? today, today].sort()[0]; // earlier of the two
        const ltft = (t.ltft_days_off ?? []) as number[];
        const report = computeRotaGaps(dates, startISO, endISO, ltft);
        // Classification uses the full audit window (lookback → today) so
        // pre-rotation and rotation-ended days appear as their own buckets
        // rather than being silently clipped.
        const auditStart = data.since ?? t.start_date ?? today;
        const classified = classifyRotaGaps(
          dates,
          auditStart,
          today,
          t.start_date ?? null,
          t.rotation_end_date ?? null,
          ltft,
        );
        return { trainee: t, report, classified };
      })
      .filter((r) => {
        if (filter) {
          const q = filter.toLowerCase();
          const match =
            r.trainee.full_name?.toLowerCase().includes(q) ||
            r.trainee.training_level?.toLowerCase().includes(q);
          if (!match) return false;
        }
        if (hideClean && r.report.totalMissingDays === 0) return false;
        return true;
      })
      .sort((a, b) => {
        const diff = b.report.totalMissingDays - a.report.totalMissingDays;
        if (diff !== 0) return diff;
        return compareBySurname(a.trainee.full_name, b.trainee.full_name);
      });
  }, [data, filter, hideClean]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!hasRole("admin")) return <Navigate to="/" />;

  const traineesWithGaps = rows.filter((r) => r.report.totalMissingDays > 0).length;
  const totalGapDays = rows.reduce((sum, r) => sum + r.report.totalMissingDays, 0);
  const totalRanges = rows.reduce((sum, r) => sum + r.report.ranges.length, 0);

  // Targeted sync covers only the date spans classified as `sync_missing`
  // across the currently filtered trainees. Pre/post-rotation and
  // LTFT/weekend days are excluded — re-fetching them won't add any rows.
  const syncTargets = useMemo(() => {
    const spans: SpanInput[] = [];
    for (const r of rows) {
      for (const range of r.classified.ranges) {
        if (range.kind === "sync_missing") {
          spans.push({
            startISO: range.startISO,
            endISO: range.endISO,
            missingDays: range.days,
            traineeId: r.trainee.id,
          });
        }
      }
    }
    return prioritiseSpans(mergeRanges(spans), priority);
  }, [rows, priority]);

  const syncableDays = useMemo(
    () => rows.reduce((sum, r) => sum + r.classified.counts.sync_missing, 0),
    [rows],
  );

  /**
   * Projected coverage gain for each prioritised range.
   *
   * `gainDays` is the range's own missing-day contribution; `cumulativeDays`
   * and `cumulativePct` show what running the top `i + 1` ranges would close
   * against the total `sync_missing` budget. The estimate is an upper bound
   * — CLWRota may still skip rows we can't match — so we label it
   * "projected".
   */
  const projection = useMemo(() => {
    let running = 0;
    return syncTargets.map((t) => {
      running += t.missingDays;
      return {
        gainDays: t.missingDays,
        gainPct: syncableDays === 0 ? 0 : t.missingDays / syncableDays,
        cumulativeDays: running,
        cumulativePct: syncableDays === 0 ? 0 : running / syncableDays,
      };
    });
  }, [syncTargets, syncableDays]);

  const effectiveLimit = runLimit ?? syncTargets.length;
  const plannedSlice = useMemo(
    () => syncTargets.slice(0, effectiveLimit),
    [syncTargets, effectiveLimit],
  );
  const plannedCoverage = projection[effectiveLimit - 1] ?? {
    cumulativeDays: 0,
    cumulativePct: 0,
  };

  async function runTargetedSync() {
    const targets = plannedSlice;
    if (targets.length === 0) return;
    setProgress({ running: true, current: 0, total: targets.length, perRange: [] });
    const perRange: SyncProgress["perRange"] = [];
    for (let i = 0; i < targets.length; i++) {
      const { startISO, endISO } = targets[i];
      setProgress({ running: true, current: i, total: targets.length, perRange: [...perRange] });
      try {
        const res: SyncResult = await syncRota({
          data: { from: startISO, to: endISO },
        });
        perRange.push({
          from: startISO,
          to: endISO,
          ok: res.ok !== false,
          message: res.message,
          upserted: res.assignmentsUpserted,
        });
      } catch (err) {
        perRange.push({
          from: startISO,
          to: endISO,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // Refresh the gap report after every range so the planned-coverage
      // projection, per-trainee gap list, and summary stats reflect the
      // rows just written. We await it so the next range's projection is
      // computed against the freshly reduced set of remaining gaps.
      await queryClient.invalidateQueries({ queryKey: ["rota-gaps"] });
    }
    setProgress({ running: false, current: targets.length, total: targets.length, perRange });
    await queryClient.invalidateQueries({ queryKey: ["rota-gaps"] });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rota gaps</h1>
          <p className="text-sm text-muted-foreground">
            Working weekdays inside each trainee's rotation where no rota assignment was synced.
            Contiguous gaps — including spans bridged by weekends or LTFT off days — are grouped into ranges.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-44">
            <label className="mb-1 block text-xs text-muted-foreground">Window</label>
            <Select value={windowChoice} onValueChange={(v) => setWindowChoice(v as WindowChoice)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(WINDOW_LABEL) as WindowChoice[]).map((k) => (
                  <SelectItem key={k} value={k}>{WINDOW_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          />
          <label className="flex items-center gap-1 pb-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hideClean}
              onChange={(e) => setHideClean(e.target.checked)}
            />
            Hide trainees with no gaps
          </label>
        </div>
      </header>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Scanning rotas…</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={AlertTriangle} tone="bad" label="Trainees with gaps" value={traineesWithGaps} />
            <Stat icon={CalendarX} tone="bad" label="Missing weekdays" value={totalGapDays} />
            <Stat icon={CalendarX} tone="muted" label="Distinct gap ranges" value={totalRanges} />
          </div>

          <Card>
            <CardContent className="flex flex-wrap items-end justify-between gap-3 p-4">
              <div className="text-sm">
                <div className="font-medium">Targeted CLWRota sync</div>
                <div className="text-xs text-muted-foreground">
                  {syncableDays > 0
                    ? `Will fetch ${syncTargets.length} merged range${syncTargets.length === 1 ? "" : "s"} covering ${syncableDays} missing weekday${syncableDays === 1 ? "" : "s"}. Ranges run in priority order — stop any time to keep the highest-impact fills.`
                    : "No sync-missing gaps in the current filter — nothing to fetch."}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="w-56">
                  <label className="mb-1 block text-xs text-muted-foreground">Priority</label>
                  <Select
                    value={priority}
                    onValueChange={(v) => {
                      setPriority(v as SyncPriority);
                      setRunLimit(null);
                    }}
                    disabled={progress?.running}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PRIORITY_LABEL) as SyncPriority[]).map((k) => (
                        <SelectItem key={k} value={k}>{PRIORITY_LABEL[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32">
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Run top
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={syncTargets.length || 1}
                    value={effectiveLimit}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!Number.isFinite(n)) setRunLimit(null);
                      else setRunLimit(Math.max(1, Math.min(syncTargets.length, n)));
                    }}
                    disabled={syncTargets.length === 0 || progress?.running}
                  />
                </div>
                <Button
                  onClick={runTargetedSync}
                  disabled={plannedSlice.length === 0 || progress?.running}
                  className="gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${progress?.running ? "animate-spin" : ""}`} />
                  {progress?.running
                    ? `Syncing ${progress.current + 1} / ${progress.total}…`
                    : `Sync top ${plannedSlice.length}`}
                </Button>
              </div>
            </CardContent>
            {syncTargets.length > 0 && (
              <CardContent className="border-t pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-muted-foreground">
                    Planned ranges (in run order)
                  </span>
                  <span className="text-muted-foreground">
                    Projected coverage of top {effectiveLimit}:{" "}
                    <span className="font-medium text-foreground">
                      {plannedCoverage.cumulativeDays} / {syncableDays} days
                      {" "}({Math.round(plannedCoverage.cumulativePct * 100)}%)
                    </span>
                  </span>
                </div>
                <ul className="divide-y rounded-md border text-sm">
                  {syncTargets.map((t, i) => {
                    const done = progress?.perRange.find(
                      (p) => p.from === t.startISO && p.to === t.endISO,
                    );
                    const active = progress?.running && progress.current === i;
                    const proj = projection[i];
                    const included = i < effectiveLimit;
                    return (
                      <li
                        key={`${t.startISO}-${t.endISO}`}
                        className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 ${included ? "" : "opacity-60"}`}
                      >
                        <span className="flex items-center gap-2">
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            #{i + 1}
                          </Badge>
                          <span className="font-mono text-xs">
                            {formatDateGB(t.startISO)} → {formatDateGB(t.endISO)}
                          </span>
                          {!included && (
                            <Badge variant="outline" className="px-1 py-0 text-[10px]">
                              skipped
                            </Badge>
                          )}
                        </span>
                        <span className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">
                            +{proj.gainDays} day{proj.gainDays === 1 ? "" : "s"}
                            {" "}({Math.round(proj.gainPct * 100)}%) · {t.trainees} trainee{t.trainees === 1 ? "" : "s"}
                          </span>
                          <Badge variant="outline" className="px-1 py-0 text-[10px]" title="Cumulative projected coverage if you run through this range">
                            cum {Math.round(proj.cumulativePct * 100)}%
                          </Badge>
                          {done ? (
                            done.ok ? (
                              <Badge className="bg-emerald-600 hover:bg-emerald-600">
                                {done.upserted ?? 0} upserted
                              </Badge>
                            ) : (
                              <Badge variant="destructive" title={done.message}>Failed</Badge>
                            )
                          ) : active ? (
                            <Badge variant="secondary">Running…</Badge>
                          ) : progress?.running && included ? (
                            <Badge variant="outline">Queued</Badge>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            )}
          </Card>



          {rows.length === 0 ? (
            <Card>
              <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                {hideClean
                  ? "No trainees with missing days in this window."
                  : "No trainees match the current filter."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map(({ trainee, report, classified }) => (
                <Card key={trainee.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">
                        <Link
                          to="/trainees/$staffId"
                          params={{ staffId: trainee.id }}
                          className="hover:underline"
                        >
                          {trainee.full_name || "—"}
                        </Link>
                        {trainee.training_level && (
                          <Badge variant="secondary" className="ml-2">{trainee.training_level}</Badge>
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-2 text-sm">
                        {report.totalMissingDays === 0 ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600">No gaps</Badge>
                        ) : (
                          <Badge variant="destructive">
                            {report.totalMissingDays} of {report.totalExpectedDays} weekdays missing
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Window {formatDateGB(report.windowStartISO)} → {formatDateGB(report.windowEndISO)}
                    </p>
                  </CardHeader>
                  {report.ranges.length > 0 && (
                    <CardContent>
                      <ul className="divide-y rounded-md border">
                        {report.ranges.map((r) => (
                          <GapRangeRow key={`${r.startISO}-${r.endISO}`} range={r} />
                        ))}
                      </ul>
                    </CardContent>
                  )}
                  <ClassifiedSection report={classified} />
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GapRangeRow({ range }: { range: GapRange }) {
  const single = range.startISO === range.endISO;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="font-mono">
        {single
          ? formatDateGB(range.startISO)
          : `${formatDateGB(range.startISO)} → ${formatDateGB(range.endISO)}`}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {range.missingDays} working day{range.missingDays === 1 ? "" : "s"}
        </span>
        {!single && (
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {range.spanDays}-day span
          </Badge>
        )}
      </span>
    </li>
  );
}

function Stat({
  icon: Icon, tone, label, value,
}: {
  icon: typeof CheckCircle2;
  tone: "ok" | "bad" | "muted";
  label: string;
  value: number;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
      : tone === "bad"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-md ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

const KIND_TONE: Record<GapKind, string> = {
  pre_rotation: "bg-muted text-muted-foreground",
  rotation_ended: "bg-muted text-muted-foreground",
  ltft_off: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sync_missing: "bg-destructive/10 text-destructive",
};

function ClassifiedSection({
  report,
}: {
  report: ReturnType<typeof classifyRotaGaps>;
}) {
  const total =
    report.counts.pre_rotation +
    report.counts.rotation_ended +
    report.counts.ltft_off +
    report.counts.sync_missing;
  if (total === 0) return null;
  return (
    <CardContent className="border-t pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">Classification:</span>
        {(Object.keys(GAP_KIND_LABEL) as GapKind[]).map((k) => (
          <Badge key={k} variant="outline" className={`gap-1 ${KIND_TONE[k]}`}>
            {GAP_KIND_LABEL[k]}: {report.counts[k]}
          </Badge>
        ))}
      </div>
      {report.ranges.length > 0 && (
        <ul className="divide-y rounded-md border">
          {report.ranges.map((r) => (
            <ClassifiedRangeRow key={`${r.kind}-${r.startISO}-${r.endISO}`} range={r} />
          ))}
        </ul>
      )}
    </CardContent>
  );
}

function ClassifiedRangeRow({ range }: { range: ClassifiedGapRange }) {
  const single = range.startISO === range.endISO;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <Badge variant="outline" className={`px-1 py-0 text-[10px] ${KIND_TONE[range.kind]}`}>
          {GAP_KIND_LABEL[range.kind]}
        </Badge>
        <span className="font-mono">
          {single
            ? formatDateGB(range.startISO)
            : `${formatDateGB(range.startISO)} → ${formatDateGB(range.endISO)}`}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {range.days} day{range.days === 1 ? "" : "s"}
      </span>
    </li>
  );
}
