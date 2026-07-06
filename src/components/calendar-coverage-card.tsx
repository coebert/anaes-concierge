import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { formatDateGB, todayISO } from "@/lib/utils";
import { checkCalendarStaffCoverage } from "@/features/calendar/calendar-coverage.functions";

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Admin dashboard card: runs the backend calendar-coverage check for the
 * chosen window and surfaces any dates the global calendar cannot render
 * a name for (missing profile, blank full_name, or an inactive assignee
 * that `listActiveStaffSafe` filters out).
 */
export function CalendarCoverageCard() {
  const [start, setStart] = useState<string>(() => todayISO());
  const [end, setEnd] = useState<string>(() => addDays(todayISO(), 27));

  const run = useServerFn(checkCalendarStaffCoverage);
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ["admin-calendar-coverage", start, end],
    queryFn: () => run({ data: { start, end } }),
    staleTime: 60_000,
  });

  const preview = useMemo(() => {
    if (!data) return null;
    const first = data.datesWithMissingNames.slice(0, 8);
    const noData = data.datesWithoutData.slice(0, 8);
    return { first, noData };
  }, [data]);

  const ok = data
    && data.unresolvedTotal === 0
    && data.inactiveTotal === 0
    && data.datesWithMissingNames.length === 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">Calendar name coverage check</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Verifies /calendar can resolve a staff name for every assignment
              in the visible range. Missing dates listed below.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <Label htmlFor="cov-start" className="mb-1 block text-xs text-muted-foreground">Start</Label>
              <Input id="cov-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-40" />
            </div>
            <div>
              <Label htmlFor="cov-end" className="mb-1 block text-xs text-muted-foreground">End</Label>
              <Input id="cov-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-40" />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={"mr-1 h-3.5 w-3.5" + (isFetching ? " animate-spin" : "")} />
              Recheck
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to run coverage check."}
          </p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Running check…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {ok ? (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  All {data.days.length} day(s) resolved names for every assignment.
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  {data.datesWithMissingNames.length} day(s) with missing names
                  {data.unresolvedTotal > 0 && ` · ${data.unresolvedTotal} unresolved staff id(s)`}
                  {data.inactiveTotal > 0 && ` · ${data.inactiveTotal} inactive assignee(s)`}
                </span>
              )}
              <Badge variant="outline" className="ml-auto">
                Active staff named: {data.activeStaffNamed}/{data.activeStaffTotal}
              </Badge>
              <Badge variant="outline">
                Dates without rota data: {data.datesWithoutData.length}
              </Badge>
            </div>

            {preview && preview.first.length > 0 && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Dates with unresolved / inactive staff
                </div>
                <ul className="divide-y rounded-md border text-sm">
                  {data.days
                    .filter((d) => d.unresolvedStaffIds.length > 0 || d.inactiveStaffIds.length > 0)
                    .slice(0, 20)
                    .map((d) => (
                      <li key={d.date} className="flex items-center justify-between px-3 py-2">
                        <span>{formatDateGB(d.date)}</span>
                        <span className="flex gap-2 text-xs">
                          {d.unresolvedStaffIds.length > 0 && (
                            <Badge variant="destructive">
                              {d.unresolvedStaffIds.length} unresolved
                            </Badge>
                          )}
                          {d.inactiveStaffIds.length > 0 && (
                            <Badge variant="secondary">
                              {d.inactiveStaffIds.length} inactive
                            </Badge>
                          )}
                        </span>
                      </li>
                    ))}
                </ul>
                {data.datesWithMissingNames.length > 20 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    +{data.datesWithMissingNames.length - 20} more day(s) omitted.
                  </p>
                )}
              </div>
            )}

            {preview && preview.noData.length > 0 && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Dates with no rota assignments
                </div>
                <p className="text-xs text-muted-foreground">
                  {preview.noData.map((d) => formatDateGB(d)).join(", ")}
                  {data.datesWithoutData.length > preview.noData.length && (
                    <> · +{data.datesWithoutData.length - preview.noData.length} more</>
                  )}
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
