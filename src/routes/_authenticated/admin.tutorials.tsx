import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listTutorialAuditSessions,
  type TutorialAuditSession,
} from "@/features/clwrota/tutorial-audit.functions";
import {
  backfillTutorialDetection,
  type TutorialBackfillResult,
} from "@/features/clwrota/tutorial-backfill.functions";
import {
  acknowledgeTutorialAuditAlert,
  getTutorialAuditStatus,
} from "@/features/clwrota/tutorial-audit-alerts.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatDateWithWeekdayGB, parseDateLocal, toISODateLocal } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/tutorials")({
  component: TutorialsAuditPage,
  head: () => ({
    meta: [
      { title: "Tutorials audit — Anaesthetics Concierge" },
      {
        name: "description",
        content:
          "Audit consultant and SAS tutorial sessions delivered in the department, identified from CLWRota.",
      },
      { property: "og:title", content: "Tutorials audit" },
      {
        property: "og:description",
        content:
          "See which staff delivered tutorial sessions, on which dates, and drill into individual sessions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Grade = "consultant" | "sas" | "trainee" | null;

function tutorialDisplayLabel(row: Pick<TutorialAuditSession, "duty_type" | "notes" | "role_on_list" | "extra_type">): string {
  if (row.notes?.trim()) return row.notes.trim();
  if (row.extra_type?.trim()) return row.extra_type.trim();
  if (row.duty_type === "teaching") return "CLWRota teaching session";
  return row.role_on_list || "—";
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toISODateLocal(d);
}

function TutorialsAuditPage() {
  const [rangeDays, setRangeDays] = useState<number>(365);
  const [gradeFilter, setGradeFilter] = useState<"all" | "consultant" | "sas">(
    "all",
  );
  const [search, setSearch] = useState("");

  const startIso = useMemo(() => isoDaysAgo(rangeDays), [rangeDays]);
  const endIso = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return toISODateLocal(d);
  }, []);
  const lookupTutorials = useServerFn(listTutorialAuditSessions);
  const runBackfill = useServerFn(backfillTutorialDetection);
  const queryClient = useQueryClient();
  const [lastBackfill, setLastBackfill] = useState<TutorialBackfillResult | null>(null);

  const { data: rows, isLoading, error } = useQuery({
    queryKey: ["tutorials", startIso, endIso],
    queryFn: () => lookupTutorials({ data: { startIso, endIso } }),
  });

  const backfillMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      runBackfill({ data: { startIso, endIso, dryRun } }),
    onSuccess: (res, dryRun) => {
      setLastBackfill(res);
      toast.success(
        dryRun
          ? `Preview: would promote ${res.promotedToTeaching}, rewrite ${res.notesUpdated} note(s).`
          : `Backfill complete: refreshed ${res.sourceRowsRefreshed} CLWRota row(s), promoted ${res.promotedToTeaching}, rewrote ${res.notesUpdated} note(s).`,
      );
      if (!dryRun) {
        queryClient.invalidateQueries({ queryKey: ["tutorials"] });
      }
    },
    onError: (err) =>
      toast.error(
        `Backfill failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      ),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (gradeFilter !== "all" && r.staffGrade !== gradeFilter) return false;
      if (!q) return true;
      const hay = `${r.staffName} ${tutorialDisplayLabel(r)} ${r.session_date}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, gradeFilter, search]);

  // Per-staff summary — count sessions delivered in the window.
  const perStaff = useMemo(() => {
    const m = new Map<string, { staff_id: string; name: string; grade: Grade; count: number }>();
    for (const r of filtered) {
      const key = r.staff_id;
      const entry =
        m.get(key) ??
        { staff_id: key, name: r.staffName, grade: r.staffGrade, count: 0 };
      entry.count += 1;
      m.set(key, entry);
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [filtered]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Tutorials audit</h1>
        <p className="text-muted-foreground text-sm">
          Tutorial, lecture and consultant / SAS teaching sessions identified from CLWRota.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Time window</label>
            <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v))}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="180">Last 6 months</SelectItem>
                <SelectItem value="365">Last 12 months</SelectItem>
                <SelectItem value="1095">Last 3 years</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Grade</label>
            <Select value={gradeFilter} onValueChange={(v) => setGradeFilter(v as typeof gradeFilter)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All grades</SelectItem>
                <SelectItem value="consultant">Consultants</SelectItem>
                <SelectItem value="sas">SAS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 flex-1 min-w-[200px]">
            <label className="text-xs text-muted-foreground">Search</label>
            <Input
              placeholder="Search by name or notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Re-run detection on synced data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Re-applies the current tutorial-detection rules to rota rows already
            in the database for this window. Consultant/SAS SPA or admin rows
            whose notes describe a tutorial are promoted to teaching and their
            note is prefixed with <code>Tutorial:</code>. Locally-edited rows
            and trainee attendee rows are left alone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={backfillMutation.isPending}
              onClick={() => backfillMutation.mutate(true)}
            >
              {backfillMutation.isPending && backfillMutation.variables === true
                ? "Previewing…"
                : "Preview changes"}
            </Button>
            <Button
              disabled={backfillMutation.isPending}
              onClick={() => backfillMutation.mutate(false)}
            >
              {backfillMutation.isPending && backfillMutation.variables === false
                ? "Backfilling…"
                : "Run backfill"}
            </Button>
          </div>
          {lastBackfill && (
            <div className="text-xs text-muted-foreground space-y-1 border-t pt-2">
              <div>
                Window {lastBackfill.windowStart} → {lastBackfill.windowEnd} ·
                scanned {lastBackfill.scanned} consultant/SAS row(s)
              </div>
              {!backfillMutation.variables && (
                <div>
                  CLWRota rows refreshed: <strong>{lastBackfill.sourceRowsRefreshed}</strong> ·
                  assignments inserted: {lastBackfill.sourceAssignmentsInserted} ·
                  assignments updated: {lastBackfill.sourceAssignmentsUpdated}
                </div>
              )}
              <div>
                Promoted to teaching: <strong>{lastBackfill.promotedToTeaching}</strong> ·
                notes rewritten: <strong>{lastBackfill.notesUpdated}</strong> ·
                skipped locally-modified: {lastBackfill.skippedLocallyModified} ·
                skipped attendees: {lastBackfill.skippedAttendee}
              </div>
              {lastBackfill.sample.length > 0 && (
                <details>
                  <summary className="cursor-pointer">
                    Sample of {lastBackfill.sample.length} affected row(s)
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                    {lastBackfill.sample.map((s) => (
                      <li key={s.id}>
                        {s.session_date} {s.session.toUpperCase()}: {s.fromDutyType}
                        {" → "}
                        {s.toDutyType}
                        {s.noteBefore !== s.noteAfter && (
                          <> · note: “{s.noteBefore ?? "—"}” → “{s.noteAfter ?? "—"}”</>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <WeeklyAuditStatusCard />





      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            Unable to load tutorial sessions: {error instanceof Error ? error.message : "Unknown error"}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            By staff member ({perStaff.length} staff · {filtered.length} sessions)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Staff</th>
                <th className="p-2">Grade</th>
                <th className="p-2 text-right">Sessions delivered</th>
              </tr>
            </thead>
            <tbody>
              {perStaff.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-muted-foreground">
                    {isLoading ? "Loading…" : "No tutorial sessions in this window."}
                  </td>
                </tr>
              )}
              {perStaff.map((p) => (
                <tr key={p.staff_id} className="border-t">
                  <td className="p-2 font-medium">{p.name}</td>
                  <td className="p-2 capitalize text-muted-foreground">{p.grade ?? "—"}</td>
                  <td className="p-2 text-right tabular-nums">{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Session log</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Date</th>
                <th className="p-2">Session</th>
                <th className="p-2">Staff</th>
                <th className="p-2">Grade</th>
                <th className="p-2">Label</th>
                <th className="p-2">Source</th>
                <th className="p-2">CLWRota record</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-muted-foreground">
                    {isLoading ? "Loading…" : "No sessions match the current filters."}
                  </td>
                </tr>
              )}
              {filtered.map((r) => {
                const d = parseDateLocal(r.session_date);
                return (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 whitespace-nowrap">{d ? formatDateWithWeekdayGB(d) : r.session_date}</td>
                    <td className="p-2 uppercase text-xs">{r.session}</td>
                    <td className="p-2 font-medium">{r.staffName}</td>
                    <td className="p-2 capitalize text-muted-foreground">{r.staffGrade}</td>
                    <td className="p-2">{tutorialDisplayLabel(r)}</td>
                    <td className="p-2">
                      <Badge variant={r.locally_modified ? "outline" : "secondary"}>
                        {r.locally_modified ? "Locally edited" : r.source}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function WeeklyAuditStatusCard() {
  const loadStatus = useServerFn(getTutorialAuditStatus);
  const ackAlert = useServerFn(acknowledgeTutorialAuditAlert);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["tutorial-audit-status"],
    queryFn: () => loadStatus({ data: undefined }),
    refetchInterval: 60_000,
  });

  const ack = useMutation({
    mutationFn: (id: string) => ackAlert({ data: { id } }),
    onSuccess: () => {
      toast.success("Alert acknowledged.");
      queryClient.invalidateQueries({ queryKey: ["tutorial-audit-status"] });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Could not acknowledge alert."),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Weekly automated backfill &amp; divergence alerts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          A scheduled job re-syncs CLWRota and re-runs tutorial detection across the
          next 12 months once a week, in bounded windows, then compares the audit
          against the CLWRota source. Any mismatch raises an alert here.
        </p>
        {isLoading && <div className="text-muted-foreground">Loading job status…</div>}
        {error && (
          <div className="text-destructive">
            Unable to load job status: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        )}
        {data && (
          <>
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant={data.paused ? "destructive" : data.enabled ? "secondary" : "outline"}>
                {data.paused ? "Paused" : data.enabled ? "Active" : "Disabled"}
              </Badge>
              {data.cursorStart && data.horizonEnd && (
                <Badge variant="outline">
                  Pass in progress · {data.cursorStart} → {data.horizonEnd}
                </Badge>
              )}
              {data.nextPassAt && !data.cursorStart && (
                <Badge variant="outline">
                  Next pass {new Date(data.nextPassAt).toLocaleString("en-GB")}
                </Badge>
              )}
              <Badge variant={data.openAlerts.length ? "destructive" : "secondary"}>
                {data.openAlerts.length} open alert{data.openAlerts.length === 1 ? "" : "s"}
              </Badge>
            </div>
            {data.pausedReason && (
              <div className="text-destructive text-xs">Paused: {data.pausedReason}</div>
            )}
            {data.lastError && !data.pausedReason && (
              <div className="text-xs text-muted-foreground">Last error: {data.lastError}</div>
            )}

            {data.openAlerts.length > 0 && (
              <div className="space-y-2 border-t pt-2">
                {data.openAlerts.map((a) => (
                  <div key={a.id} className="rounded border border-destructive/40 p-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">
                        {a.window_start} → {a.window_end}: CLWRota {a.source_count} vs audit{" "}
                        {a.audit_count}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={ack.isPending}
                        onClick={() => ack.mutate(a.id)}
                      >
                        Acknowledge
                      </Button>
                    </div>
                    {a.missingFromAudit.length > 0 && (
                      <ul className="text-xs list-disc pl-4">
                        {a.missingFromAudit.slice(0, 10).map((m, i) => (
                          <li key={`m-${i}`}>
                            Missing from audit: {m.staffName} · {m.session_date} {m.session.toUpperCase()}
                            {m.label ? ` · ${m.label}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {a.extraInAudit.length > 0 && (
                      <ul className="text-xs list-disc pl-4">
                        {a.extraInAudit.slice(0, 10).map((m, i) => (
                          <li key={`e-${i}`}>
                            Not in CLWRota: {m.staffName} · {m.session_date} {m.session.toUpperCase()}
                            {m.label ? ` · ${m.label}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}

            {data.recentRuns.length > 0 && (
              <details className="text-xs text-muted-foreground border-t pt-2">
                <summary className="cursor-pointer">Recent audited windows</summary>
                <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                  {data.recentRuns.map((r) => (
                    <li key={r.id}>
                      {r.window_start} → {r.window_end}: source {r.source_count} / audit{" "}
                      {r.audit_count}
                      {r.diverged ? " · diverged" : " · match"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
