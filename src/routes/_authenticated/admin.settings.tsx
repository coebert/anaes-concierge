import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, CheckCircle2, XCircle, RefreshCw, Plug } from "lucide-react";
import {
  getClwRotaSettings,
  saveClwRotaSettings,
  testClwRotaConnection,
  listReclassificationRuns,
  undoReclassificationRun,
  investigateAndFixTraineeSolo,
  backfillNonSagLabels,
} from "@/lib/clwrota.functions";
import {
  useSyncClwRotaStaff,
  useSyncClwRotaRota,
  useSyncClwRotaLeave,
} from "@/lib/clwrota-sync-hooks";
import { validateTraineeTheatreMatches } from "@/lib/trainee-theatre-validation.functions";


import { formatDateGB } from "@/lib/utils";
import { useNameSortDirection, setNameSortDirection } from "@/lib/name-sort";

export const Route = createFileRoute("/_authenticated/admin/settings")({
  component: SettingsPage,
});

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
      ? "text-emerald-600"
      : tone === "danger"
        ? "text-destructive"
        : tone === "info"
          ? "text-blue-600"
          : "text-foreground";
  return (
    <div className="rounded border border-border bg-muted/30 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function SettingsPage() {
  const qc = useQueryClient();
  const getSettings = useServerFn(getClwRotaSettings);
  const saveSettings = useServerFn(saveClwRotaSettings);
  const testConn = useServerFn(testClwRotaConnection);
  const syncStaff = useSyncClwRotaStaff();
  const syncRota = useSyncClwRotaRota();
  const syncLeave = useSyncClwRotaLeave();
  const backfillNonSag = useServerFn(backfillNonSagLabels);
  const validateMatches = useServerFn(validateTraineeTheatreMatches);

  const { data, isLoading } = useQuery({
    queryKey: ["clwrota-settings"],
    queryFn: () => getSettings(),
  });

  const [rotaUrl, setRotaUrl] = useState("");
  const [leaveUrl, setLeaveUrl] = useState("");
  const [staffUrl, setStaffUrl] = useState("");
  const [daysBack, setDaysBack] = useState("30");
  const [daysAhead, setDaysAhead] = useState("120");
  const [autoReclassifySolo, setAutoReclassifySolo] = useState(false);

  useEffect(() => {
    if (data?.settings) {
      setRotaUrl(data.settings.rota_report_url ?? "");
      setLeaveUrl(data.settings.leave_report_url ?? "");
      setStaffUrl(data.settings.staff_report_url ?? "");
      setDaysBack(String(data.settings.sync_days_back ?? 30));
      setDaysAhead(String(data.settings.sync_days_ahead ?? 120));
      setAutoReclassifySolo(Boolean((data.settings as { auto_reclassify_trainee_solo?: boolean }).auto_reclassify_trainee_solo));
    }
  }, [data?.settings]);

  const saveMut = useMutation({
    mutationFn: () =>
      saveSettings({
        data: {
          rota_report_url: rotaUrl.trim() || null,
          leave_report_url: leaveUrl.trim() || null,
          staff_report_url: staffUrl.trim() || null,
          sync_days_back: Number(daysBack) || 30,
          sync_days_ahead: Number(daysAhead) || 120,
          auto_reclassify_trainee_solo: autoReclassifySolo,
        },
      }),
    onSuccess: () => {
      toast.success("Settings saved");
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testMut = useMutation({
    mutationFn: () => testConn({}),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(`Connected (${res.status} in ${res.elapsedMs}ms)`);
      } else {
        toast.error(`Connection failed: ${res.status} ${res.statusText}`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Targeted auto-retry: when the post-sync audit flags mismatched trainees,
  // we re-run the rota sync (the step that establishes theatre_session_id
  // links) and re-validate, up to MAX_AUTO_RETRIES times. The retry path
  // bypasses the per-step auto-validate hook via `retryInFlight` so we don't
  // double-fire validation between the retry's sync and its own validate.
  const MAX_AUTO_RETRIES = 2;
  const retryInFlight = useRef(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retriedTrainees, setRetriedTrainees] = useState<string[]>([]);

  const validateMut = useMutation({
    mutationFn: () => validateMatches({ data: {} }),
    onSuccess: (res) => {
      const { mismatches, traineesWithTheatreRows, fullyMatched } = res;
      if (mismatches.length === 0) {
        const suffix =
          retryAttempt > 0
            ? ` after ${retryAttempt} targeted retry${retryAttempt === 1 ? "" : "s"}`
            : "";
        toast.success(
          `Trainee theatre audit: all ${traineesWithTheatreRows} trainee(s) with theatre rows are fully matched${suffix}.`,
        );
        retryInFlight.current = false;
        setRetryAttempt(0);
        setRetriedTrainees([]);
        return;
      }

      const noMatch = mismatches.filter((m) => m.reason === "no_matches").length;
      const highRatio = mismatches.length - noMatch;
      const summary =
        `${mismatches.length} of ${traineesWithTheatreRows} trainee(s) still have unmatched lists` +
        ` (${noMatch} with no matches, ${highRatio} with >50% unmatched, ${fullyMatched} fully matched).`;

      // Auto-retry: re-sync the rota window and re-validate, up to MAX_AUTO_RETRIES.
      if (retryAttempt < MAX_AUTO_RETRIES && rotaUrl.trim()) {
        const nextAttempt = retryAttempt + 1;
        setRetryAttempt(nextAttempt);
        setRetriedTrainees(
          mismatches.map((m) => m.full_name ?? m.staff_id),
        );
        retryInFlight.current = true;
        toast.message(
          `Trainee theatre audit: ${summary} Re-syncing rota (attempt ${nextAttempt}/${MAX_AUTO_RETRIES}) for ${mismatches.length} trainee(s)…`,
        );
        // Fire-and-forget; rotaMut.onSuccess short-circuits validation while
        // retryInFlight is true, then we kick a fresh validate ourselves.
        rotaMut
          .mutateAsync()
          .then(() => {
            setTimeout(() => validateMut.mutate(), 250);
          })
          .catch((err: unknown) => {
            retryInFlight.current = false;
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(
              `Targeted re-sync (attempt ${nextAttempt}/${MAX_AUTO_RETRIES}) failed: ${msg}`,
            );
          });
        return;
      }

      // Out of retries (or no rota URL configured).
      retryInFlight.current = false;
      const exhausted =
        retryAttempt >= MAX_AUTO_RETRIES
          ? ` after ${MAX_AUTO_RETRIES} targeted retries`
          : "";
      toast.warning(`Trainee theatre audit${exhausted}: ${summary}`);
    },
    onError: (e: Error) => {
      retryInFlight.current = false;
      toast.error(`Trainee theatre audit failed: ${e.message}`);
    },
  });

  const runValidationAfter = () => {
    // Skip the auto-validation that follows a retry's sync — the retry path
    // explicitly calls validateMut.mutate() once the rota write completes.
    if (retryInFlight.current) return;
    // Reset the retry counter at the start of a fresh user-initiated cycle so
    // a later audit can use its own 2 attempts.
    setRetryAttempt(0);
    setRetriedTrainees([]);
    setTimeout(() => validateMut.mutate(), 250);
  };

  const staffMut = useMutation({
    mutationFn: () => syncStaff(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
      void qc.invalidateQueries({ queryKey: ["staff"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      runValidationAfter();
      return res;
    },
  });

  const rotaMut = useMutation({
    mutationFn: () => syncRota(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
      void qc.invalidateQueries({ queryKey: ["rota"] });
      void qc.invalidateQueries({ queryKey: ["rota-assignments"] });
      void qc.invalidateQueries({ queryKey: ["theatre-sessions"] });
      runValidationAfter();
      return res;
    },
  });

  const leaveMut = useMutation({
    mutationFn: () => syncLeave(),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["clwrota-settings"] });
      void qc.invalidateQueries({ queryKey: ["leave-requests"] });
      void qc.invalidateQueries({ queryKey: ["leave"] });
      runValidationAfter();
      return res;
    },
  });

  const syncAllMut = useMutation({
    mutationFn: async () => {
      // Run each step independently so a single failure (e.g. a Cloudflare
      // CPU/timeout 502 on the heaviest dataset) doesn't abort the other
      // steps. Order is staff → rota → leave so rota assignments can match
      // freshly-synced people.
      const syncStartedAt = Date.now();
      const waitForStepStatus = async (name: "staff" | "rota" | "leave") => {
        const successStatus = `${name}_success`;
        const terminalPrefixes = [`${name}_partial`, `${name}_fetch_failed`, `${name}_no_rows`];
        for (let attempt = 0; attempt < 45; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const latest = await getSettings();
          const settings = latest.settings;
          const status = settings?.last_status ?? "";
          const updatedAt = settings?.last_sync_at ? Date.parse(settings.last_sync_at) : 0;
          if (updatedAt && updatedAt < syncStartedAt - 1000) continue;
          if (status === successStatus) {
            return { ok: true, message: "completed after the request timeout" };
          }
          if (terminalPrefixes.some((prefix) => status.startsWith(prefix))) {
            return {
              ok: false,
              message: settings?.last_error || status || "sync ended with errors",
            };
          }
        }
        return { ok: false, message: "timed out waiting for completion status" };
      };

      const runStep = async <T,>(
        name: "staff" | "rota" | "leave",
        urlValue: string,
        fn: () => Promise<T>,
      ): Promise<{ name: string; ok: boolean; message: string; data?: T }> => {
        if (!urlValue.trim()) {
          return { name, ok: true, message: "skipped (no URL configured)" };
        }
        try {
          const data = await fn();
          const msg =
            data && typeof data === "object" && "message" in data
              ? String((data as { message: unknown }).message)
              : "done";
          const ok =
            data && typeof data === "object" && "ok" in data
              ? Boolean((data as { ok: unknown }).ok)
              : true;
          return { name, ok, message: msg, data };
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          // Worker 502s come through as opaque "Load failed" / fetch errors;
          // surface a clearer hint.
          if (/load failed|fetch|502|504|timeout|cpu time|upstream/i.test(raw)) {
            const settled = await waitForStepStatus(name);
            return { name, ok: settled.ok, message: settled.message };
          }
          const friendly = /load failed|fetch|502|cpu time/i.test(raw)
            ? `${raw} — the upstream sync exceeded the worker time limit. Try syncing this dataset on its own.`
            : raw;
          return { name, ok: false, message: friendly };
        }
      };

      const staff = await runStep("staff", staffUrl, () => staffMut.mutateAsync());
      const rota = await runStep("rota", rotaUrl, () => rotaMut.mutateAsync());
      const leave = await runStep("leave", leaveUrl, () => leaveMut.mutateAsync());
      return [staff, rota, leave];
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      const summary = results
        .map((r) => `${r.name}: ${r.ok ? "✓" : "✗"} ${r.message}`)
        .join(" · ");
      if (failed.length === 0) {
        toast.success(`Sync complete — ${summary}`);
      } else if (failed.length === results.length) {
        toast.error(`Sync failed — ${summary}`);
      } else {
        toast.warning(`Partial sync — ${summary}`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // One-click backfill: re-scans the CLWRota rota feed and ticks the
  // Non-SAG checkbox on every theatre-grid session whose feed row carries
  // a "[Non-SAG]" tag. Sessions with an admin override are left alone.
  const backfillNonSagMut = useMutation({
    mutationFn: () => backfillNonSag({ data: {} }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      if (res.sessionsUpdated > 0) {
        toast.success(res.message);
      } else {
        toast.message(res.message);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });





  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const settings = data?.settings;
  const credsOk = data?.hasApiKey && data?.hasBaseUrl;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          CLWRota integration, curriculum targets, and email setup.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Plug className="h-4 w-4" /> CLWRota — pull sync
              </CardTitle>
              <CardDescription>
                Import rota, leave, and staff data from CLWRota into this app.
                Credentials are stored as backend secrets.
              </CardDescription>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                Historical data is preserved across syncs — only adds or updates
              </div>
            </div>
            <Badge variant={credsOk ? "default" : "destructive"}>
              {credsOk ? "Credentials set" : "Missing credentials"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">Base URL:</span>{" "}
              {data?.baseUrl ?? <em>not set</em>}
            </div>
            <div>
              <span className="font-medium text-foreground">API key:</span>{" "}
              {data?.hasApiKey ? "configured" : "not set"}
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              In CLWRota, generate a Central API report URL for each dataset
              and paste it below. Leave blank to skip a dataset.
            </p>

            <div className="space-y-2">
              <Label htmlFor="rota-url">Rota report URL</Label>
              <Input
                id="rota-url"
                placeholder="https://…/api/reports/rota.json?…"
                value={rotaUrl}
                onChange={(e) => setRotaUrl(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="leave-url">Leave report URL</Label>
              <Input
                id="leave-url"
                placeholder="https://…/api/reports/leave.json?…"
                value={leaveUrl}
                onChange={(e) => setLeaveUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="staff-url">Staff report URL</Label>
              <Input
                id="staff-url"
                placeholder="https://…/api/reports/staff.json?…"
                value={staffUrl}
                onChange={(e) => setStaffUrl(e.target.value)}
              />
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
              <div>
                <div className="text-sm font-medium">Rota sync date window</div>
                <p className="text-xs text-muted-foreground">
                  Narrows the rota fetch to a rolling window around today so the
                  upstream call completes within the gateway timeout. Historical
                  rows already synced are preserved.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="days-back">Days back</Label>
                  <Input
                    id="days-back"
                    type="number"
                    min={0}
                    max={3650}
                    value={daysBack}
                    onChange={(e) => setDaysBack(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="days-ahead">Days ahead</Label>
                  <Input
                    id="days-ahead"
                    type="number"
                    min={1}
                    max={3650}
                    value={daysAhead}
                    onChange={(e) => setDaysAhead(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <Label htmlFor="auto-reclassify-solo" className="text-sm font-medium">
                    Auto-reclassify trainee solo lists
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    During each rota sync, set any trainee marked "solo" on a
                    theatre session that also has a consultant rostered to
                    "supervised". Locally-modified rows are preserved.
                  </p>
                </div>
                <Switch
                  id="auto-reclassify-solo"
                  checked={autoReclassifySolo}
                  onCheckedChange={setAutoReclassifySolo}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                {saveMut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Save settings
              </Button>
              <Button
                variant="outline"
                onClick={() => testMut.mutate()}
                disabled={testMut.isPending || !credsOk}
              >
                {testMut.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Test connection
              </Button>
              <Button
                variant="default"
                onClick={() => syncAllMut.mutate()}
                disabled={
                  syncAllMut.isPending ||
                  !credsOk ||
                  (!staffUrl.trim() && !rotaUrl.trim() && !leaveUrl.trim())
                }
              >
                {syncAllMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                {syncAllMut.isPending
                  ? staffMut.isPending
                    ? "Syncing staff…"
                    : rotaMut.isPending
                      ? "Syncing rota…"
                      : leaveMut.isPending
                        ? "Syncing leave…"
                        : "Syncing…"
                  : "Sync all from CLWRota"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => backfillNonSagMut.mutate()}
                disabled={backfillNonSagMut.isPending || !credsOk || !rotaUrl.trim()}
                title="Re-scan the CLWRota rota feed and tick the Non-SAG checkbox on every theatre-grid session tagged as Non-SAG. Admin overrides are preserved."
              >
                {backfillNonSagMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                {backfillNonSagMut.isPending ? "Backfilling…" : "Backfill Non-SAG labels"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => validateMut.mutate()}
                disabled={validateMut.isPending}
                title="Re-check every active trainee for unmatched theatre rows in the current sync window."
              >
                {validateMut.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                )}
                {validateMut.isPending ? "Validating…" : "Validate trainee theatre matches"}
              </Button>
            </div>
          </div>

          {validateMut.data && (
            <div className="rounded-md border border-border p-3 text-xs space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-sm">
                  Post-sync trainee theatre audit
                </div>
                <div className="text-muted-foreground">
                  Window {validateMut.data.window.from} → {validateMut.data.window.to}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Trainees scanned" value={validateMut.data.traineesScanned} />
                <Stat
                  label="With theatre rows"
                  value={validateMut.data.traineesWithTheatreRows}
                />
                <Stat
                  label="Fully matched"
                  value={validateMut.data.fullyMatched}
                  tone="success"
                />
                <Stat
                  label="Mismatches"
                  value={validateMut.data.mismatches.length}
                  tone={validateMut.data.mismatches.length ? "danger" : "success"}
                />
              </div>
              {validateMut.data.mismatches.length === 0 ? (
                <div className="flex items-center gap-1.5 rounded bg-emerald-50 px-2 py-1 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  All trainees with theatre rows have at least one matched list
                  and an unmatched ratio below 50%.
                </div>
              ) : (
                <details className="rounded border border-border p-2" open>
                  <summary className="cursor-pointer font-medium">
                    Trainees with unmatched theatre rows ({validateMut.data.mismatches.length})
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr className="text-left">
                          <th className="py-1 pr-2">Trainee</th>
                          <th className="py-1 pr-2">Matched</th>
                          <th className="py-1 pr-2">Unmatched</th>
                          <th className="py-1 pr-2">Unmatched %</th>
                          <th className="py-1 pr-2">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validateMut.data.mismatches.map((m) => (
                          <tr key={m.staff_id} className="border-t border-border/50">
                            <td className="py-1 pr-2">{m.full_name ?? m.staff_id}</td>
                            <td className="py-1 pr-2">{m.matched}</td>
                            <td className="py-1 pr-2">{m.unmatched}</td>
                            <td className="py-1 pr-2">
                              {Math.round(m.unmatchedRatio * 100)}%
                            </td>
                            <td className="py-1 pr-2">
                              {m.reason === "no_matches"
                                ? "No matched lists"
                                : "High unmatched ratio"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}


          {backfillNonSagMut.data && (
            <div className="rounded-md border border-border p-3 text-xs space-y-2">
              <div className="font-medium text-sm">Last Non-SAG backfill</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Rows scanned" value={backfillNonSagMut.data.rowsScanned} />
                <Stat label="Rows tagged" value={backfillNonSagMut.data.rowsTagged} tone="info" />
                <Stat
                  label="Sessions updated"
                  value={backfillNonSagMut.data.sessionsUpdated}
                  tone="success"
                />
                <Stat
                  label="Kept (override)"
                  value={backfillNonSagMut.data.sessionsSkippedOverride}
                />
              </div>
              {backfillNonSagMut.data.unmatched.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Unmatched theatres ({backfillNonSagMut.data.unmatched.length})
                  </summary>
                  <div className="mt-2 text-muted-foreground">
                    {backfillNonSagMut.data.unmatched.join(", ")}
                  </div>
                </details>
              )}
            </div>
          )}



          {leaveMut.data && (
            <div className="rounded-md border border-border p-3 text-xs space-y-3">
              <div className="font-medium text-sm">Last leave sync results</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Rows pulled" value={leaveMut.data.total} />
                <Stat label="Upserted" value={leaveMut.data.upserted} tone="success" />
                <Stat
                  label="Skipped / errors"
                  value={leaveMut.data.skipped.length + leaveMut.data.errors.length}
                  tone={leaveMut.data.errors.length ? "danger" : undefined}
                />
              </div>

              {leaveMut.data.unmatchedStaff.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Unmatched staff ({leaveMut.data.unmatchedStaff.length})
                  </summary>
                  <div className="mt-2 break-all text-muted-foreground">
                    {leaveMut.data.unmatchedStaff.join(", ")}
                  </div>
                </details>
              )}

              {leaveMut.data.skipped.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Skipped rows ({leaveMut.data.skipped.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
                    {leaveMut.data.skipped.slice(0, 200).map((s, i) => (
                      <li key={i}>
                        {s.label} — <span className="italic">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {leaveMut.data.errors.length > 0 && (
                <details open className="rounded border border-destructive/40 p-2">
                  <summary className="cursor-pointer font-medium text-destructive">
                    Errors ({leaveMut.data.errors.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-destructive">
                    {leaveMut.data.errors.map((e, i) => (
                      <li key={i}>
                        <span className="font-medium">{e.label}</span> — {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {leaveMut.data.sampleKeys.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Detected CLWRota columns ({leaveMut.data.sampleKeys.length})
                  </summary>
                  <div className="mt-2 break-all text-muted-foreground">
                    {leaveMut.data.sampleKeys.join(", ")}
                  </div>
                </details>
              )}

              {leaveMut.data.rawPreview && leaveMut.data.total === 0 && (
                <div>
                  <div className="font-medium text-foreground">Response preview:</div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px]">
                    {leaveMut.data.rawPreview}
                  </pre>
                </div>
              )}
            </div>
          )}


          {rotaMut.data && (
            <div className="rounded-md border border-border p-3 text-xs space-y-3">
              <div className="font-medium text-sm">Last rota sync results</div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Rows pulled" value={rotaMut.data.total} />
                <Stat label="Assignments" value={rotaMut.data.assignmentsUpserted} tone="success" />
                <Stat label="New sessions" value={rotaMut.data.sessionsUpserted} tone="info" />
                <Stat
                  label="Skipped / errors"
                  value={rotaMut.data.skipped.length + rotaMut.data.errors.length}
                  tone={rotaMut.data.errors.length ? "danger" : undefined}
                />
              </div>

              {rotaMut.data.unmatchedStaff.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Unmatched staff ({rotaMut.data.unmatchedStaff.length})
                  </summary>
                  <div className="mt-2 break-all text-muted-foreground">
                    {rotaMut.data.unmatchedStaff.join(", ")}
                  </div>
                </details>
              )}

              {rotaMut.data.unmatchedTheatres.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Unmatched theatres ({rotaMut.data.unmatchedTheatres.length})
                  </summary>
                  <div className="mt-2 break-all text-muted-foreground">
                    {rotaMut.data.unmatchedTheatres.join(", ")}
                  </div>
                  <p className="mt-1 italic text-muted-foreground">
                    Add these in Admin → Theatres so future syncs can link them.
                  </p>
                </details>
              )}

              {rotaMut.data.skipped.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Skipped rows ({rotaMut.data.skipped.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
                    {rotaMut.data.skipped.slice(0, 200).map((s, i) => (
                      <li key={i}>
                        {s.label} — <span className="italic">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {rotaMut.data.errors.length > 0 && (
                <details open className="rounded border border-destructive/40 p-2">
                  <summary className="cursor-pointer font-medium text-destructive">
                    Errors ({rotaMut.data.errors.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-destructive">
                    {rotaMut.data.errors.map((e, i) => (
                      <li key={i}>
                        <span className="font-medium">{e.label}</span> — {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {rotaMut.data.sampleKeys.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Detected CLWRota columns ({rotaMut.data.sampleKeys.length})
                  </summary>
                  <div className="mt-2 break-all text-muted-foreground">
                    {rotaMut.data.sampleKeys.join(", ")}
                  </div>
                </details>
              )}

              {rotaMut.data.rawPreview && rotaMut.data.total === 0 && (
                <div>
                  <div className="font-medium text-foreground">Response preview:</div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px]">
                    {rotaMut.data.rawPreview}
                  </pre>
                </div>
              )}
            </div>
          )}


          {staffMut.data && (
            <div className="rounded-md border border-border p-3 text-xs space-y-3">
              <div className="font-medium text-sm">Last staff sync results</div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Stat label="Rows pulled" value={staffMut.data.total} />
                <Stat label="Added" value={staffMut.data.insertedCount} tone="success" />
                <Stat label="Updated" value={staffMut.data.updated} tone="info" />
                <Stat label="Unchanged" value={staffMut.data.unchangedCount} />
                <Stat
                  label="Skipped / errors"
                  value={staffMut.data.skipped.length + staffMut.data.errors.length}
                  tone={staffMut.data.errors.length ? "danger" : undefined}
                />
              </div>

              {staffMut.data.emailDiagnostics && (
                <details open className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Email matching diagnostics
                  </summary>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat
                      label="With email"
                      value={staffMut.data.emailDiagnostics.rowsWithEmail}
                      tone="success"
                    />
                    <Stat
                      label="Blank / missing"
                      value={staffMut.data.emailDiagnostics.rowsBlankEmail}
                      tone={
                        staffMut.data.emailDiagnostics.rowsBlankEmail
                          ? "danger"
                          : undefined
                      }
                    />
                    <Stat
                      label="Invalid format"
                      value={staffMut.data.emailDiagnostics.rowsInvalidEmail}
                      tone={
                        staffMut.data.emailDiagnostics.rowsInvalidEmail
                          ? "danger"
                          : undefined
                      }
                    />
                    <Stat
                      label="Duplicates in feed"
                      value={staffMut.data.emailDiagnostics.rowsDuplicateEmail}
                      tone={
                        staffMut.data.emailDiagnostics.rowsDuplicateEmail
                          ? "danger"
                          : undefined
                      }
                    />
                  </div>
                  <div className="mt-2 space-y-1 text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">
                        Email fields tried:
                      </span>{" "}
                      {staffMut.data.emailDiagnostics.emailFieldsTried.join(", ")}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">
                        Email fields detected in payload:
                      </span>{" "}
                      {staffMut.data.emailDiagnostics.detectedEmailFields.length
                        ? staffMut.data.emailDiagnostics.detectedEmailFields.join(", ")
                        : "none — staff report has no recognised email column"}
                    </div>
                  </div>
                </details>
              )}


              {staffMut.data.insertedList.length > 0 && (
                <details open className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium text-emerald-600">
                    Added profiles ({staffMut.data.insertedList.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
                    {staffMut.data.insertedList.map((p) => (
                      <li key={p.email}>
                        {p.name} <span className="opacity-70">&lt;{p.email}&gt;</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {staffMut.data.skipped.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Skipped rows ({staffMut.data.skipped.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
                    {staffMut.data.skipped.map((s, i) => (
                      <li key={`${s.label}-${i}`}>
                        {s.label} — <span className="italic">{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {staffMut.data.errors.length > 0 && (
                <details open className="rounded border border-destructive/40 p-2">
                  <summary className="cursor-pointer font-medium text-destructive">
                    Errors ({staffMut.data.errors.length})
                  </summary>
                  <ul className="mt-2 max-h-48 list-disc overflow-auto pl-5 text-destructive">
                    {staffMut.data.errors.map((e, i) => (
                      <li key={`${e.label}-${i}`}>
                        <span className="font-medium">{e.label}</span> — {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {staffMut.data.sampleKeys.length > 0 && (
                <details className="rounded border border-border p-2">
                  <summary className="cursor-pointer font-medium">
                    Detected CLWRota columns ({staffMut.data.sampleKeys.length})
                  </summary>
                  <div className="mt-2 break-all text-muted-foreground">
                    {staffMut.data.sampleKeys.join(", ")}
                  </div>
                </details>
              )}

              {staffMut.data.rawPreview && staffMut.data.total === 0 && (
                <div>
                  <div className="font-medium text-foreground">Response preview:</div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[10px]">
                    {staffMut.data.rawPreview}
                  </pre>
                </div>
              )}
            </div>
          )}

          {settings?.last_sync_at && (
            <div className="rounded-md border border-border p-3 text-sm">
              <div className="mb-1 flex items-center gap-2">
                {settings.last_status === "success" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
                <span className="font-medium">Last sync</span>
                <span className="text-muted-foreground">
                  {formatDateGB(settings.last_sync_at)} ·{" "}
                  {new Date(settings.last_sync_at).toLocaleTimeString("en-GB")}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Status: {settings.last_status ?? "—"} · Rows pulled:{" "}
                {settings.last_pulled_rows ?? 0}
              </div>
              {settings.last_error && (
                <div className="mt-2 text-xs text-destructive">
                  {settings.last_error}
                </div>
              )}
            </div>
          )}

        </CardContent>
      </Card>

      <NameSortPreferenceCard />

      <InvestigateSoloCard />

      <ReclassificationUndoCard />
    </div>
  );
}

export function InvestigateSoloCard() {
  const qc = useQueryClient();
  const investigate = useServerFn(investigateAndFixTraineeSolo);
  const [result, setResult] = useState<null | Awaited<
    ReturnType<typeof investigateAndFixTraineeSolo>
  >>(null);

  const previewMut = useMutation({
    mutationFn: () => investigate({ data: { apply: false } }),
    onSuccess: (res) => setResult(res),
    onError: (e: Error) => toast.error(e.message),
  });
  const applyMut = useMutation({
    mutationFn: () => investigate({ data: { apply: true } }),
    onSuccess: (res) => {
      setResult(res);
      toast.success(
        `Corrected ${res.applied} list(s)` +
          (res.sync_run_id ? ` · run ${res.sync_run_id.slice(0, 8)}` : ""),
      );
      void qc.invalidateQueries({ queryKey: ["reclassification-runs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const isPending = previewMut.isPending || applyMut.isPending;
  const autoCount = result?.counts.consultant_or_sas_on_session ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Investigate suspicious solo lists</CardTitle>
        <CardDescription>
          Re-evaluate every trainee "solo" rota row in the last 60 / next 60 days. Rows
          where a consultant or SAS doctor is on the same theatre session are corrected
          automatically; review-only categories (unmatched labels, off-day placeholders)
          are surfaced for manual cleanup. Locally-modified rows are never touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => previewMut.mutate()}
          >
            {previewMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Preview findings
          </Button>
          <Button
            size="sm"
            disabled={isPending || (result !== null && autoCount === 0)}
            onClick={() => {
              if (
                window.confirm(
                  `Auto-correct ${autoCount || "any"} trainee "solo" list(s) where a consultant/SAS is on the same theatre session?`,
                )
              ) {
                applyMut.mutate();
              }
            }}
          >
            {applyMut.isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Investigate &amp; fix now
          </Button>
        </div>

        {result ? (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Stat
                label="Auto-correctable (consultant/SAS on session)"
                value={result.counts.consultant_or_sas_on_session}
                tone={result.counts.consultant_or_sas_on_session > 0 ? "info" : undefined}
              />
              <Stat
                label="Review: unmatched theatre row"
                value={result.counts.unmatched_theatre_solo}
                tone={result.counts.unmatched_theatre_solo > 0 ? "danger" : undefined}
              />
              <Stat
                label="Review: non-training label"
                value={result.counts.non_training_label}
                tone={result.counts.non_training_label > 0 ? "danger" : undefined}
              />
            </div>
            {result.applied > 0 ? (
              <p className="text-xs text-emerald-600">
                {result.applied} list(s) reclassified solo → supervised in run{" "}
                {result.sync_run_id?.slice(0, 8)}.
              </p>
            ) : null}
            {result.sample.length > 0 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Sample findings ({result.sample.length})
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {result.sample.map((s) => (
                    <li key={s.assignment_id}>
                      <Badge variant="outline" className="mr-1">
                        {s.category}
                      </Badge>
                      {s.staff_name} · {s.session_date ?? "—"} · {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReclassificationUndoCard() {
  const qc = useQueryClient();

  const listRuns = useServerFn(listReclassificationRuns);
  const undoRun = useServerFn(undoReclassificationRun);
  const { data, isLoading } = useQuery({
    queryKey: ["reclassification-runs"],
    queryFn: () => listRuns(),
  });
  const undoMut = useMutation({
    mutationFn: (sync_run_id: string) => undoRun({ data: { sync_run_id } }),
    onSuccess: (res) => {
      toast.success(
        `Reverted ${res.reverted} list(s)` +
          (res.skipped ? ` · ${res.skipped} skipped (changed since)` : ""),
      );
      void qc.invalidateQueries({ queryKey: ["reclassification-runs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Auto-reclassification history</CardTitle>
        <CardDescription>
          Undo a previous run that automatically converted trainee "solo" lists to
          "supervised". Rows changed manually since the run are left alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading runs…
          </div>
        ) : !data || data.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No auto-reclassification runs recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {data.runs.map((r) => (
              <li key={r.sync_run_id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {formatDateGB(new Date(r.created_at))}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({new Date(r.created_at).toLocaleTimeString()})
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {r.count} list(s) · {r.from_role} → {r.to_role} · run {r.sync_run_id.slice(0, 8)}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={undoMut.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Revert ${r.count} list(s) from "${r.to_role}" back to "${r.from_role}"?`,
                      )
                    ) {
                      undoMut.mutate(r.sync_run_id);
                    }
                  }}
                >
                  {undoMut.isPending && undoMut.variables === r.sync_run_id ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NameSortPreferenceCard() {
  const qc = useQueryClient();
  const direction = useNameSortDirection();
  const isDescending = direction === "desc";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Display preferences</CardTitle>
        <CardDescription>
          Personal display options — stored on this device only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="staff-name-sort-toggle" className="text-sm font-medium">
              Sort staff name lists Z→A by surname
            </Label>
            <p className="text-xs text-muted-foreground">
              {isDescending
                ? "Lists currently show Zhang before Adams."
                : "Lists currently show Adams before Zhang. Toggle on to reverse."}
            </p>
          </div>
          <Switch
            id="staff-name-sort-toggle"
            checked={isDescending}
            onCheckedChange={(checked) => {
              setNameSortDirection(checked ? "desc" : "asc");
              // Refresh every query so queryFn sorts re-run with the new direction.
              void qc.invalidateQueries();
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
