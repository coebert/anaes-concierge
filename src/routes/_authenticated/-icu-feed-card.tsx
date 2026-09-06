import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  acknowledgeIcuAuditAlert,
  getIcuFeedStatus,
  type IcuFeedStatus,
} from "@/features/analytics/icu-feed.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateWithWeekdayGB } from "@/lib/utils";

const SESSION_LABEL: Record<string, string> = {
  am: "AM",
  pm: "PM",
  eve: "Evening",
  night: "Night",
};

/**
 * The ICU rota feed: raw intensive-care sessions collected from CLWRota by the
 * daily background job, shown alongside how far that job has got.
 */
export function IcuFeedCard({ startIso, endIso }: { startIso: string; endIso: string }) {
  const statusFn = useServerFn(getIcuFeedStatus);
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["icu-feed", startIso, endIso],
    queryFn: () => statusFn({ data: { startIso, endIso } }) as Promise<IcuFeedStatus>,
  });

  const ackFn = useServerFn(acknowledgeIcuAuditAlert);
  const ack = useMutation({
    mutationFn: (id: string) => ackFn({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["icu-feed"] });
    },
  });

  return (
    <Card data-testid="icu-feed-card">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">ICU rota feed (built up daily)</CardTitle>
        {data ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{data.totalSessions} sessions stored</Badge>
            <Badge variant={data.enabled ? "outline" : "destructive"}>
              {data.enabled ? "Daily sync on" : "Daily sync off"}
            </Badge>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading the feed…</p> : null}
        {error ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Could not load the ICU feed."}
          </p>
        ) : null}

        {data ? (
          <>
            <p className="text-sm text-muted-foreground">
              The feed collects {data.sliceDays} day{data.sliceDays === 1 ? "" : "s"} at a time,
              covering {data.daysBack} days back to {data.daysAhead} days ahead.
              {data.cursor ? ` Next run continues from ${formatDateWithWeekdayGB(data.cursor)}.` : ""}
              {data.lastRunAt
                ? ` Last run ${new Date(data.lastRunAt).toLocaleString("en-GB")}.`
                : " It has not run yet."}
            </p>
            {data.lastError ? (
              <p className="text-sm text-destructive">Last error: {data.lastError}</p>
            ) : null}

            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Weekly re-check against CLWRota</h3>
                <Badge variant={data.weekly.paused || !data.weekly.enabled ? "destructive" : "outline"}>
                  {!data.weekly.enabled
                    ? "Switched off"
                    : data.weekly.paused
                      ? "Paused"
                      : "Running weekly"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Every week the whole year is re-downloaded from CLWRota, one window at a time, and
                re-checked against the audit.
                {data.weekly.cursor
                  ? ` This week's pass continues from ${formatDateWithWeekdayGB(data.weekly.cursor)}.`
                  : " The current pass is complete."}
                {data.weekly.nextPassAt
                  ? ` Next pass due ${new Date(data.weekly.nextPassAt).toLocaleDateString("en-GB")}.`
                  : ""}
              </p>
              {data.weekly.pausedReason ? (
                <p className="mt-1 text-sm text-destructive">{data.weekly.pausedReason}</p>
              ) : data.weekly.lastError ? (
                <p className="mt-1 text-sm text-destructive">Last error: {data.weekly.lastError}</p>
              ) : null}

              {data.alerts.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No count differences have been flagged.
                </p>
              ) : (
                <ul className="mt-2 space-y-1" data-testid="icu-audit-alerts">
                  {data.alerts.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1 text-sm"
                    >
                      <span className={a.acknowledgedAt ? "text-muted-foreground" : "text-amber-600"}>
                        {a.windowStart} → {a.windowEnd}: CLWRota {a.sourceCount} vs audit{" "}
                        {a.auditCount}
                      </span>
                      {a.acknowledgedAt ? (
                        <span className="text-xs text-muted-foreground">Seen</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={ack.isPending}
                          onClick={() => ack.mutate(a.id)}
                        >
                          Mark as seen
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {data.runs.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3">Window</th>
                      <th className="py-1 pr-3">CLWRota</th>
                      <th className="py-1 pr-3">Audit</th>
                      <th className="py-1 pr-3">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.slice(0, 8).map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="py-1 pr-3 whitespace-nowrap">
                          {r.windowStart} → {r.windowEnd}
                        </td>
                        <td className="py-1 pr-3">{r.sourceCount}</td>
                        <td className="py-1 pr-3">{r.auditCount}</td>
                        <td className="py-1 pr-3">
                          {!r.ok ? (
                            <span className="text-destructive">{r.error ?? "Failed"}</span>
                          ) : r.diverged ? (
                            <span className="text-amber-600">Counts differ</span>
                          ) : (
                            "Matched"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-medium">
                Raw ICU sessions in this date range ({data.sessions.length} shown)
              </h3>
              {data.sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No ICU sessions collected for this range yet — the daily job fills the window in
                  gradually.
                </p>
              ) : (
                <div className="max-h-96 overflow-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/60 text-left">
                      <tr>
                        <th className="px-2 py-1">Date</th>
                        <th className="px-2 py-1">Session</th>
                        <th className="px-2 py-1">Doctor</th>
                        <th className="px-2 py-1">Location</th>
                        <th className="px-2 py-1">Matched text</th>
                        <th className="px-2 py-1">PAs</th>
                        <th className="px-2 py-1">CLWRota ref</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map((s) => (
                        <tr key={s.id} className="border-t align-top">
                          <td className="px-2 py-1 whitespace-nowrap">
                            {formatDateWithWeekdayGB(s.sessionDate)}
                          </td>
                          <td className="px-2 py-1">{SESSION_LABEL[s.session] ?? s.session}</td>
                          <td className="px-2 py-1">{s.staffName}</td>
                          <td className="px-2 py-1">{s.placeName ?? "—"}</td>
                          <td className="px-2 py-1">{s.matchedValue ?? "—"}</td>
                          <td className="px-2 py-1">{s.paCredit ?? "—"}</td>
                          <td className="px-2 py-1 font-mono text-xs">
                            {s.clwrotaExternalId ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
