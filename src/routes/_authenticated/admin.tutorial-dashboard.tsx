import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listTutorialAuditSessions,
  type TutorialAuditSession,
} from "@/features/clwrota/tutorial-audit.functions";
import {
  compareTutorialDeliveries,
  type TutorialCompareResult,
} from "@/features/clwrota/tutorial-compare.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateWithWeekdayGB, toISODateLocal } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/tutorial-dashboard")({
  component: TutorialDashboardPage,
  head: () => ({
    meta: [
      { title: "Tutorial deliveries dashboard — Anaesthetics Concierge" },
      {
        name: "description",
        content:
          "Tutorial deliveries by consultant and SAS staff with a side-by-side audit versus CLWRota count comparison for any date range.",
      },
      { property: "og:title", content: "Tutorial deliveries dashboard" },
      {
        property: "og:description",
        content:
          "Compare the tutorial sessions recorded in the audit against the live CLWRota source for a chosen date range.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISODateLocal(d);
}

const SESSION_LABEL: Record<string, string> = {
  am: "AM",
  pm: "PM",
  eve: "Evening",
  night: "Night",
};

function TutorialDashboardPage() {
  const today = toISODateLocal(new Date());
  const [startIso, setStartIso] = useState(addDays(today, -28));
  const [endIso, setEndIso] = useState(addDays(today, 28));
  const [range, setRange] = useState({ startIso: addDays(today, -28), endIso: addDays(today, 28) });

  const listFn = useServerFn(listTutorialAuditSessions);
  const compareFn = useServerFn(compareTutorialDeliveries);

  const sessionsQuery = useQuery({
    queryKey: ["tutorial-dashboard-sessions", range.startIso, range.endIso],
    queryFn: () => listFn({ data: range }) as Promise<TutorialAuditSession[]>,
  });

  const compare = useMutation({
    mutationFn: () => compareFn({ data: range }) as Promise<TutorialCompareResult>,
  });

  const sessions = sessionsQuery.data ?? [];
  const byStaff = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const s of sessions) {
      const cur = map.get(s.staff_id) ?? { name: s.staffName, count: 0 };
      cur.count += 1;
      map.set(s.staff_id, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [sessions]);

  const invalidRange = startIso > endIso;

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="tutorial-dashboard">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tutorial deliveries dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Tutorial sessions delivered by consultant and SAS staff, with a live side-by-side count
          comparison against the CLWRota source for the chosen date range.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Date range</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">From</span>
            <Input
              type="date"
              value={startIso}
              onChange={(e) => setStartIso(e.target.value)}
              data-testid="tutorial-dashboard-start"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">To</span>
            <Input
              type="date"
              value={endIso}
              onChange={(e) => setEndIso(e.target.value)}
              data-testid="tutorial-dashboard-end"
            />
          </label>
          <Button
            disabled={invalidRange}
            onClick={() => {
              setRange({ startIso, endIso });
              compare.reset();
            }}
            data-testid="tutorial-dashboard-apply"
          >
            Apply
          </Button>
          <div className="flex gap-2">
            {[
              { label: "Last 30 days", from: addDays(today, -30), to: today },
              { label: "Next 30 days", from: today, to: addDays(today, 30) },
              { label: "This quarter", from: addDays(today, -45), to: addDays(today, 45) },
            ].map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                onClick={() => {
                  setStartIso(p.from);
                  setEndIso(p.to);
                  setRange({ startIso: p.from, endIso: p.to });
                  compare.reset();
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {invalidRange && (
            <p className="text-sm text-destructive">The start date must be on or before the end date.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Audit vs CLWRota</CardTitle>
          <Button
            onClick={() => compare.mutate()}
            disabled={compare.isPending}
            data-testid="tutorial-dashboard-compare"
          >
            {compare.isPending ? "Comparing…" : "Compare with CLWRota"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {compare.isError && (
            <p className="text-sm text-destructive">{(compare.error as Error).message}</p>
          )}
          {!compare.data && !compare.isPending && (
            <p className="text-sm text-muted-foreground">
              Run the comparison to fetch the live CLWRota report for {range.startIso} → {range.endIso}
              and check it against the audit.
            </p>
          )}
          {compare.data && (
            <div className="space-y-4" data-testid="tutorial-dashboard-comparison">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">CLWRota source</div>
                  <div className="text-2xl font-semibold" data-testid="compare-source-count">
                    {compare.data.sourceCount}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Audit</div>
                  <div className="text-2xl font-semibold" data-testid="compare-audit-count">
                    {compare.data.auditCount}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Result</div>
                  <div className="pt-1">
                    {compare.data.diverged ? (
                      <Badge variant="destructive">Diverged</Badge>
                    ) : (
                      <Badge variant="secondary">Exact match</Badge>
                    )}
                  </div>
                </div>
              </div>

              {compare.data.diverged && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h3 className="mb-1 text-sm font-medium">
                      In CLWRota, missing from the audit ({compare.data.missingFromAudit.length})
                    </h3>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {compare.data.missingFromAudit.map((d) => (
                        <li key={d.key}>
                          {formatDateWithWeekdayGB(d.session_date)} ·{" "}
                          {SESSION_LABEL[d.session] ?? d.session} · {d.staffName}
                          {d.label ? ` — “${d.label}”` : ""}
                        </li>
                      ))}
                      {compare.data.missingFromAudit.length === 0 && <li>None</li>}
                    </ul>
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-medium">
                      In the audit, not in CLWRota ({compare.data.extraInAudit.length})
                    </h3>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {compare.data.extraInAudit.map((d) => (
                        <li key={d.key}>
                          {formatDateWithWeekdayGB(d.session_date)} ·{" "}
                          {SESSION_LABEL[d.session] ?? d.session} · {d.staffName}
                          {d.label ? ` — “${d.label}”` : ""}
                        </li>
                      ))}
                      {compare.data.extraInAudit.length === 0 && <li>None</li>}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Tutorial deliveries ({sessions.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sessionsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : sessionsQuery.isError ? (
              <p className="text-sm text-destructive">{(sessionsQuery.error as Error).message}</p>
            ) : sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tutorial deliveries recorded in this range.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="tutorial-dashboard-table">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Session</th>
                      <th className="py-2 pr-3">Delivered by</th>
                      <th className="py-2 pr-3">Grade</th>
                      <th className="py-2 pr-3">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id} className="border-t">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatDateWithWeekdayGB(s.session_date)}
                        </td>
                        <td className="py-2 pr-3">{SESSION_LABEL[s.session] ?? s.session}</td>
                        <td className="py-2 pr-3">{s.staffName}</td>
                        <td className="py-2 pr-3 uppercase text-xs">{s.staffGrade}</td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {s.sourceTrace?.place_name ?? s.notes ?? s.theatreName ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Deliveries per staff member</CardTitle>
          </CardHeader>
          <CardContent>
            {byStaff.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing to summarise yet.</p>
            ) : (
              <ul className="space-y-1 text-sm" data-testid="tutorial-dashboard-by-staff">
                {byStaff.map((s) => (
                  <li key={s.name} className="flex justify-between gap-3">
                    <span>{s.name}</span>
                    <span className="font-medium tabular-nums">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
