import { PageHeader } from "@/components/page-header";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  computeRotaGaps, classifyRotaGaps,
} from "@/lib/rota-gaps";
import { fetchAllRowsPaged, rotaAssignmentKey } from "@/features/audit/paginate";
import {
  syncClwRotaRota,
  getClwRotaSettings,
  saveClwRotaSettings,
  testClwRotaConnection,
} from "@/features/clwrota/clwrota.functions";
import { formatDateGB, todayISO } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import { AlertTriangle, CheckCircle2, CalendarX, RefreshCw, Plug, ExternalLink } from "lucide-react";
import {
  WINDOW_LABEL,
  PRIORITY_LABEL,
  addDaysISO,
  mergeRanges,
  prioritiseSpans,
  countSyncMissingInSpan,
  countSyncMissingForTraineeInSpan,
  type WindowChoice,
  type SpanInput,
  type SyncPriority,
  type SyncProgress,
  type TraineeDiagnostic,
  type TraineeDiagnosticStatus,
  type GapSnapshot,
} from "@/features/admin-rota-gaps/helpers";
import {
  GapRangeRow,
  Stat,
  ClassifiedSection,
} from "@/features/admin-rota-gaps/components";

export const Route = createFileRoute("/_authenticated/admin/rota-gaps")({
  component: RotaGapsPage,
});

function RotaGapsPage() {
  const { hasRole, loading } = useAuth();
  const queryClient = useQueryClient();
  const syncRota = useServerFn(syncClwRotaRota);
  const fetchSettings = useServerFn(getClwRotaSettings);
  const saveSettings = useServerFn(saveClwRotaSettings);
  const testConn = useServerFn(testClwRotaConnection);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("90");
  const [filter, setFilter] = useState("");
  const [hideClean, setHideClean] = useState(true);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [priority, setPriority] = useState<SyncPriority>("coverage");
  const [runLimit, setRunLimit] = useState<number | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [rotaUrlDraft, setRotaUrlDraft] = useState("");

  const settingsQ = useQuery({
    queryKey: ["clwrota-settings"],
    queryFn: () => fetchSettings(),
  });
  const currentRotaUrl = settingsQ.data?.settings?.rota_report_url ?? "";
  const hasApiKey = settingsQ.data?.hasApiKey ?? false;
  const hasBaseUrl = settingsQ.data?.hasBaseUrl ?? false;

  // Keep the draft in sync with the loaded value but don't clobber an
  // in-progress edit.
  useEffect(() => {
    if (!sourceOpen) setRotaUrlDraft(currentRotaUrl);
  }, [currentRotaUrl, sourceOpen]);

  const saveSourceMut = useMutation({
    mutationFn: async () => {
      const next = rotaUrlDraft.trim();
      // Preserve every other CLWRota setting; only swap the rota URL.
      const s = settingsQ.data?.settings;
      await saveSettings({
        data: {
          rota_report_url: next || null,
          leave_report_url: s?.leave_report_url ?? null,
          staff_report_url: s?.staff_report_url ?? null,
          sync_days_back: s?.sync_days_back ?? 30,
          sync_days_ahead: s?.sync_days_ahead ?? 120,
          auto_reclassify_trainee_solo: Boolean(
            (s as { auto_reclassify_trainee_solo?: boolean } | null | undefined)?.auto_reclassify_trainee_solo,
          ),
        },
      });
    },
    onSuccess: () => {
      toast.success("CLWRota source updated");
      void queryClient.invalidateQueries({ queryKey: ["clwrota-settings"] });
    },
    onError: (e: Error) => toast.error(`Save failed: ${e.message}`),
  });

  const testConnMut = useMutation({
    mutationFn: () => testConn({}),
    onSuccess: (res) => {
      if (res.ok) toast.success(`Connected (${res.status} in ${res.elapsedMs}ms)`);
      else toast.error(`Connection failed: ${res.status} ${res.statusText || ""}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
        .select("id, full_name, grade, training_level, start_date, rotation_end_date, ltft_days_off")
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
      const { startISO, endISO, traineeIds } = targets[i];
      setProgress({ running: true, current: i, total: targets.length, perRange: [...perRange] });

      // Snapshot the gap state inside this range BEFORE the sync runs, so
      // we can compute a "gaps filled" delta once the post-sync refetch
      // lands. The current query cache already reflects every prior range
      // in this run because we await the invalidation below.
      const beforeSnap = queryClient.getQueryData<GapSnapshot>([
        "rota-gaps",
        windowChoice,
      ]);
      const gapsBefore = beforeSnap
        ? countSyncMissingInSpan(beforeSnap, startISO, endISO)
        : undefined;
      // Per-trainee gap counts BEFORE sync, for the per-range diagnostic
      // table built once the post-sync refetch lands below.
      const perTraineeBefore = new Map<string, number>();
      if (beforeSnap) {
        for (const tid of traineeIds) {
          perTraineeBefore.set(
            tid,
            countSyncMissingForTraineeInSpan(beforeSnap, tid, startISO, endISO),
          );
        }
      }

      let entry: SyncProgress["perRange"][number];
      let coverageByStaff = new Map<string, {
        datesCovered: number;
        insertedDates: number;
        existingDates: number;
        firstDate: string;
        lastDate: string;
      }>();
      try {
        const res: SyncResult = await syncRota({
          data: { from: startISO, to: endISO },
        });
        const cov = (res as SyncResult & { coverage?: {
          rowsInWindow: number;
          staffCoverage: Array<{ staffId: string; datesCovered: number; insertedDates: number; existingDates: number; firstDate: string; lastDate: string }>;
          skippedReasonCounts: Record<string, number>;
        } }).coverage;
        if (cov) {
          for (const sc of cov.staffCoverage) {
            coverageByStaff.set(sc.staffId, {
              datesCovered: sc.datesCovered,
              insertedDates: sc.insertedDates,
              existingDates: sc.existingDates,
              firstDate: sc.firstDate,
              lastDate: sc.lastDate,
            });
          }
        }
        const topSkipReasons = cov
          ? Object.entries(cov.skippedReasonCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([reason, count]) => ({ reason, count }))
          : [];
        entry = {
          from: startISO,
          to: endISO,
          ok: res.ok !== false,
          message: res.message,
          upserted: res.assignmentsUpserted,
          inserted: res.assignmentsInserted,
          updated: res.assignmentsUpdated,
          unmatchedStaffCount: res.unmatchedStaff?.length ?? 0,
          gapsBefore,
          rowsInWindow: cov?.rowsInWindow,
          staffCovered: cov?.staffCoverage.length,
          topSkipReasons,
        };
      } catch (err) {
        entry = {
          from: startISO,
          to: endISO,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          gapsBefore,
        };
      }

      // Refresh the gap report after every range so the planned-coverage
      // projection, per-staff gap list, and summary stats reflect the
      // rows just written. We mark the query stale AND explicitly refetch
      // so the next range — and the top-of-page statistics — are computed
      // against the freshly reduced set of remaining gaps. `refetchQueries`
      // resolves only after the query function has actually re-run, which
      // `invalidateQueries` alone does not guarantee in every scenario.
      await queryClient.invalidateQueries({ queryKey: ["rota-gaps"] });
      await queryClient.refetchQueries({
        queryKey: ["rota-gaps", windowChoice],
        type: "active",
      });
      const afterSnap = queryClient.getQueryData<GapSnapshot>([
        "rota-gaps",
        windowChoice,
      ]);
      if (afterSnap && gapsBefore != null) {
        const gapsAfter = countSyncMissingInSpan(afterSnap, startISO, endISO);
        entry.gapsAfter = gapsAfter;
        entry.gapsFilled = Math.max(0, gapsBefore - gapsAfter);
      }

      // Build per-trainee diagnostics: cross-reference gap deltas with
      // upstream coverage so admins can see exactly why each trainee was
      // (or wasn't) helped by this sync.
      if (afterSnap && beforeSnap) {
        const diag: TraineeDiagnostic[] = traineeIds.map((tid) => {
          const trainee = beforeSnap.trainees.find((x) => x.id === tid);
          const name = data?.trainees.find((x) => x.id === tid)?.full_name ?? tid;
          const before = perTraineeBefore.get(tid) ?? 0;
          const after = countSyncMissingForTraineeInSpan(afterSnap, tid, startISO, endISO);
          const filled = Math.max(0, before - after);
          const cov = coverageByStaff.get(tid);
          const upstreamDatesCovered = cov?.datesCovered ?? 0;
          const upstreamInsertedDates = cov?.insertedDates ?? 0;
          const upstreamExistingDates = cov?.existingDates ?? 0;
          let status: TraineeDiagnosticStatus;
          if (before === 0) status = "no_gap_in_range";
          else if (upstreamDatesCovered === 0) status = "no_upstream_coverage";
          else if (filled === 0) status = "covered_no_new_dates";
          else if (after === 0) status = "fully_filled";
          else status = "partially_filled";
          void trainee;
          return {
            traineeId: tid,
            name,
            gapsBefore: before,
            gapsAfter: after,
            gapsFilled: filled,
            upstreamDatesCovered,
            upstreamInsertedDates,
            upstreamExistingDates,
            firstUpstreamDate: cov?.firstDate ?? null,
            lastUpstreamDate: cov?.lastDate ?? null,
            status,
          };
        }).sort((a, b) => b.gapsBefore - a.gapsBefore);
        entry.traineeDiagnostics = diag;

        // Compact console summary so the troubleshooting trail is also
        // visible in browser devtools when the user copy-pastes a bug
        // report.
        const summary = diag.reduce<Record<TraineeDiagnosticStatus, number>>(
          (acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }),
          { fully_filled: 0, partially_filled: 0, no_upstream_coverage: 0, covered_no_new_dates: 0, no_gap_in_range: 0 },
        );
        console.info(
          `[rota-gaps] ${startISO}..${endISO}: filled ${entry.gapsFilled ?? 0}/${entry.gapsBefore ?? 0} day(s); trainees:`,
          summary,
        );
      }

      perRange.push(entry);
    }

    setProgress({ running: false, current: targets.length, total: targets.length, perRange });
    await queryClient.invalidateQueries({ queryKey: ["rota-gaps"] });
    await queryClient.refetchQueries({
      queryKey: ["rota-gaps", windowChoice],
      type: "active",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rota gaps"
        description="Working weekdays for every active staff member where no rota assignment was synced. Contiguous gaps — including spans bridged by weekends or LTFT off days — are grouped into ranges."
        actions={
          <>
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
              Hide staff with no gaps
            </label>
          </>
        }
      />

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Scanning rotas…</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={AlertTriangle} tone="bad" label="Staff with gaps" value={traineesWithGaps} />
            <Stat icon={CalendarX} tone="bad" label="Missing weekdays" value={totalGapDays} />
            <Stat icon={CalendarX} tone="muted" label="Distinct gap ranges" value={totalRanges} />
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Plug className="h-4 w-4" /> CLWRota source
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Swap the rota report URL or refresh the auth key when CLWRota returns
                  no rows for trainees that still appear as gaps. After saving, re-run
                  the targeted sync below to fill the newly-covered dates.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Badge variant={hasApiKey ? "default" : "destructive"}>
                  API key {hasApiKey ? "set" : "missing"}
                </Badge>
                <Badge variant={hasBaseUrl ? "default" : "destructive"}>
                  Base URL {hasBaseUrl ? "set" : "missing"}
                </Badge>
                <Badge variant={currentRotaUrl ? "default" : "destructive"}>
                  Rota URL {currentRotaUrl ? "set" : "missing"}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSourceOpen((v) => !v)}
                >
                  {sourceOpen ? "Hide" : "Edit"}
                </Button>
              </div>
            </CardHeader>
            {sourceOpen && (
              <CardContent className="space-y-3 border-t pt-3 text-sm">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Rota report URL (CLWRota Central API)
                  </label>
                  <Textarea
                    value={rotaUrlDraft}
                    onChange={(e) => setRotaUrlDraft(e.target.value)}
                    rows={4}
                    placeholder="https://sftcr.rotamap.net/central_api/query/assignments?…"
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Tip: copy the report URL from CLWRota's "Reports" page. Targeted
                    syncs replace the URL's <code>start_date</code> / <code>end_date</code>{" "}
                    per range, so the date params here are just defaults.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => saveSourceMut.mutate()}
                    disabled={
                      saveSourceMut.isPending ||
                      rotaUrlDraft.trim() === currentRotaUrl.trim()
                    }
                  >
                    {saveSourceMut.isPending ? "Saving…" : "Save URL"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRotaUrlDraft(currentRotaUrl);
                    }}
                    disabled={
                      saveSourceMut.isPending ||
                      rotaUrlDraft.trim() === currentRotaUrl.trim()
                    }
                  >
                    Revert
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testConnMut.mutate()}
                    disabled={testConnMut.isPending || !hasApiKey || !hasBaseUrl}
                  >
                    {testConnMut.isPending ? "Testing…" : "Test connection"}
                  </Button>
                  <Link
                    to="/admin/settings"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Manage API key & base URL <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  The CLWRota auth key (<code>CLWROTA_API_KEY</code>) and base URL
                  (<code>CLWROTA_BASE_URL</code>) are stored as backend secrets and
                  rotated from Settings → CLWRota.
                </p>
              </CardContent>
            )}
          </Card>

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
                  <span className="flex flex-wrap items-center gap-3 text-muted-foreground">
                    {progress && progress.perRange.length > 0 && (() => {
                      const verified = progress.perRange.filter(
                        (p) => p.ok && p.gapsBefore != null && p.gapsAfter != null,
                      );
                      if (verified.length === 0) return null;
                      const filled = verified.reduce((n, p) => n + (p.gapsFilled ?? 0), 0);
                      const before = verified.reduce((n, p) => n + (p.gapsBefore ?? 0), 0);
                      const tone = before === 0
                        ? "text-muted-foreground"
                        : filled === 0
                          ? "text-destructive"
                          : "text-emerald-700 dark:text-emerald-400";
                      return (
                        <span title="Sum of sync-missing weekdays closed across every completed range — measured by re-querying rota_assignments after each sync.">
                          Verified fill: <span className={`font-medium ${tone}`}>{filled} / {before} gaps</span>
                          {progress.running ? " (so far)" : ""}
                        </span>
                      );
                    })()}
                    <span>
                      Projected coverage of top {effectiveLimit}:{" "}
                      <span className="font-medium text-foreground">
                        {plannedCoverage.cumulativeDays} / {syncableDays} days
                        {" "}({Math.round(plannedCoverage.cumulativePct * 100)}%)
                      </span>
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
                        className={`flex flex-col gap-1 px-3 py-2 ${included ? "" : "opacity-60"}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
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
                            {" "}({Math.round(proj.gainPct * 100)}%) · {t.trainees} staff
                          </span>
                          <Badge variant="outline" className="px-1 py-0 text-[10px]" title="Cumulative projected coverage if you run through this range">
                            cum {Math.round(proj.cumulativePct * 100)}%
                          </Badge>
                          {done ? (
                            done.ok ? (
                              <>
                                <Badge
                                  className="bg-emerald-600 hover:bg-emerald-600"
                                  title={`Total rows touched by this sync call (inserted + updated). ${
                                    done.inserted != null ? `${done.inserted} new row(s), ${done.updated ?? 0} existing row(s) updated.` : ""
                                  }`}
                                >
                                  {done.upserted ?? 0} upserted
                                </Badge>
                                {done.inserted != null && (
                                  <Badge
                                    variant={done.inserted > 0 ? "default" : "outline"}
                                    title="Truly new rota_assignment rows created by this sync — these are what actually fill gaps. The remaining 'upserted' rows are existing rows that were merely refreshed."
                                  >
                                    {done.inserted} new
                                  </Badge>
                                )}
                                {done.rowsInWindow != null && (
                                  <Badge
                                    variant="outline"
                                    title={`Raw rows CLWRota returned for this date window. Compare with 'upserted' to see how many rows survived parsing/filtering. ${done.staffCovered ?? 0} distinct staff appeared in the feed.`}
                                  >
                                    {done.rowsInWindow} rows · {done.staffCovered ?? 0} staff
                                  </Badge>
                                )}
                                {done.gapsFilled != null && done.gapsBefore != null ? (
                                  done.gapsFilled > 0 ? (
                                    <Badge
                                      className="bg-emerald-600/80 hover:bg-emerald-600/80"
                                      title={`Sync-missing weekdays in this range: ${done.gapsBefore} before → ${done.gapsAfter} after`}
                                    >
                                      {done.gapsFilled} / {done.gapsBefore} gaps filled
                                    </Badge>
                                  ) : done.gapsBefore === 0 ? (
                                    <Badge
                                      variant="outline"
                                      title="No sync-missing weekdays in this range when the sync started"
                                    >
                                      no gaps to fill
                                    </Badge>
                                  ) : (
                                    <Badge
                                      variant="destructive"
                                      title={`Sync ran but ${done.gapsAfter} of ${done.gapsBefore} weekdays in this range are still missing. Expand for per-trainee reasons.`}
                                    >
                                      0 / {done.gapsBefore} gaps filled
                                    </Badge>
                                  )
                                ) : null}
                                {done.unmatchedStaffCount != null && done.unmatchedStaffCount > 0 && (
                                  <Badge
                                    variant="outline"
                                    title="CLWRota rows whose person.local_id / email / name didn't match any active profile. These rows are silently dropped. Fix by linking the missing profile's clwrota_external_id."
                                  >
                                    {done.unmatchedStaffCount} unmatched staff
                                  </Badge>
                                )}
                              </>
                            ) : (
                              <Badge variant="destructive" title={done.message}>Failed</Badge>
                            )
                          ) : active ? (
                            <Badge variant="secondary">Running…</Badge>
                          ) : progress?.running && included ? (
                            <Badge variant="outline">Queued</Badge>
                          ) : null}
                        </span>
                        </div>
                        {done?.traineeDiagnostics && done.traineeDiagnostics.length > 0 && (
                          <details className="mt-1 rounded-md border bg-muted/30 px-2 py-1 text-xs">
                            <summary className="cursor-pointer select-none text-muted-foreground">
                              Per-trainee diagnostics ({done.traineeDiagnostics.length})
                              {(() => {
                                const noCov = done.traineeDiagnostics!.filter((d) => d.status === "no_upstream_coverage").length;
                                const stale = done.traineeDiagnostics!.filter((d) => d.status === "covered_no_new_dates").length;
                                const partial = done.traineeDiagnostics!.filter((d) => d.status === "partially_filled").length;
                                const full = done.traineeDiagnostics!.filter((d) => d.status === "fully_filled").length;
                                const parts = [
                                  full ? `${full} fully` : null,
                                  partial ? `${partial} partial` : null,
                                  stale ? `${stale} stale-only` : null,
                                  noCov ? `${noCov} no-upstream` : null,
                                ].filter(Boolean);
                                return parts.length ? ` — ${parts.join(", ")}` : "";
                              })()}
                            </summary>
                            <table className="mt-2 w-full text-left">
                              <thead className="text-[10px] uppercase text-muted-foreground">
                                <tr>
                                  <th className="py-1 pr-2 font-normal">Trainee</th>
                                  <th className="py-1 pr-2 font-normal">Before</th>
                                  <th className="py-1 pr-2 font-normal">After</th>
                                  <th className="py-1 pr-2 font-normal">Filled</th>
                                  <th className="py-1 pr-2 font-normal" title="Distinct upstream session_dates returned for this trainee in the request window">Upstream dates</th>
                                  <th className="py-1 pr-2 font-normal" title="Of those upstream dates, how many were new rows vs. already-known existing rows">New / Existing</th>
                                  <th className="py-1 pr-2 font-normal">Upstream window</th>
                                  <th className="py-1 pr-2 font-normal">Why</th>
                                </tr>
                              </thead>
                              <tbody>
                                {done.traineeDiagnostics.map((d) => {
                                  const reason =
                                    d.status === "fully_filled"
                                      ? "All gaps closed."
                                      : d.status === "partially_filled"
                                      ? "Upstream covered some but not all gap dates in this range."
                                      : d.status === "covered_no_new_dates"
                                      ? "Upstream returned rows for this trainee, but every returned date was already on file — no new dates to add. Likely a duty-type / classification mismatch, or the gap dates fall outside what CLWRota holds for this trainee."
                                      : d.status === "no_upstream_coverage"
                                      ? "CLWRota returned NO rows for this trainee in this window — they may have rotated off the service, be on long-term leave, or their CLWRota record stops before this date range."
                                      : "No sync-missing weekdays in range.";
                                  const statusTone =
                                    d.status === "fully_filled"
                                      ? "text-emerald-700 dark:text-emerald-400"
                                      : d.status === "partially_filled"
                                      ? "text-amber-700 dark:text-amber-400"
                                      : d.status === "covered_no_new_dates"
                                      ? "text-amber-700 dark:text-amber-400"
                                      : d.status === "no_upstream_coverage"
                                      ? "text-red-700 dark:text-red-400"
                                      : "text-muted-foreground";
                                  return (
                                    <tr key={d.traineeId} className="border-t border-border/40">
                                      <td className="py-1 pr-2 font-medium">{d.name}</td>
                                      <td className="py-1 pr-2 tabular-nums">{d.gapsBefore}</td>
                                      <td className="py-1 pr-2 tabular-nums">{d.gapsAfter}</td>
                                      <td className="py-1 pr-2 tabular-nums">{d.gapsFilled}</td>
                                      <td className="py-1 pr-2 tabular-nums">{d.upstreamDatesCovered}</td>
                                      <td className="py-1 pr-2 tabular-nums">{d.upstreamInsertedDates} / {d.upstreamExistingDates}</td>
                                      <td className="py-1 pr-2 font-mono text-[10px]">
                                        {d.firstUpstreamDate ? `${d.firstUpstreamDate} → ${d.lastUpstreamDate}` : "—"}
                                      </td>
                                      <td className={`py-1 pr-2 ${statusTone}`}>{reason}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            {done.topSkipReasons && done.topSkipReasons.length > 0 && (
                              <div className="mt-2 text-[10px] text-muted-foreground">
                                Top skip reasons across all rows in this window:{" "}
                                {done.topSkipReasons.map((r, idx) => (
                                  <span key={r.reason}>
                                    {idx > 0 ? " · " : ""}
                                    <span className="font-mono">{r.reason}</span> ({r.count})
                                  </span>
                                ))}
                              </div>
                            )}
                          </details>
                        )}
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
                  ? "No staff with missing days in this window."
                  : "No staff match the current filter."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map(({ trainee, report, classified }) => (
                <Card key={trainee.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">
                        {trainee.grade === "trainee" ? (
                          <Link
                            to="/trainees/$staffId"
                            params={{ staffId: trainee.id }}
                            className="hover:underline"
                          >
                            {trainee.full_name || "—"}
                          </Link>
                        ) : (
                          <span>{trainee.full_name || "—"}</span>
                        )}
                        {trainee.grade && trainee.grade !== "trainee" && (
                          <Badge variant="outline" className="ml-2 capitalize">{trainee.grade}</Badge>
                        )}
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
