import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  compareIcuSessions,
  listIcuTraces,
  type IcuTraceRow,
  type IcuVerifyResult,
} from "@/features/analytics/icu-compare.functions";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateWithWeekdayGB, toISODateLocal } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/icu-dashboard")({
  component: IcuDashboardPage,
  head: () => ({
    meta: [
      { title: "ICU audit vs CLWRota — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "Compare the intensive care sessions recorded in the ICU audit against the live CLWRota source for any date range, per consultant and SAS doctor.",
      },
      { property: "og:title", content: "ICU audit vs CLWRota dashboard" },
      {
        property: "og:description",
        content:
          "Side-by-side intensive care session counts from the ICU audit and the live CLWRota report for a chosen date range.",
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

const DUTY_LABEL: Record<string, string> = {
  icu_consultant_oncall: "ICU consultant on-call",
  icu_ct2_plus: "ICU CT2+",
  icu_trainee: "ICU trainee",
};

function IcuDashboardPage() {
  const today = toISODateLocal(new Date());
  const [startIso, setStartIso] = useState(addDays(today, -90));
  const [endIso, setEndIso] = useState(today);
  const [range, setRange] = useState({ startIso: addDays(today, -90), endIso: today });

  const compareFn = useServerFn(compareIcuSessions);
  const compare = useMutation({
    mutationFn: (r: { startIso: string; endIso: string }) =>
      compareFn({ data: r }) as Promise<IcuVerifyResult>,
  });

  const invalidRange = startIso > endIso;
  const result = compare.data;

  const applyRange = (from: string, to: string) => {
    setStartIso(from);
    setEndIso(to);
    setRange({ startIso: from, endIso: to });
    compare.reset();
  };

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="icu-dashboard">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">ICU audit vs CLWRota</h1>
        <p className="text-sm text-muted-foreground">
          Intensive care sessions for consultant and SAS doctors, compared side by side against the
          live CLWRota report for the date range you choose (up to 120 days).
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
              data-testid="icu-dashboard-start"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">To</span>
            <Input
              type="date"
              value={endIso}
              onChange={(e) => setEndIso(e.target.value)}
              data-testid="icu-dashboard-end"
            />
          </label>
          <Button
            disabled={invalidRange}
            onClick={() => applyRange(startIso, endIso)}
            data-testid="icu-dashboard-apply"
          >
            Apply
          </Button>
          <div className="flex flex-wrap gap-2">
            {[
              { label: "Last 30 days", from: addDays(today, -30), to: today },
              { label: "Last 90 days", from: addDays(today, -90), to: today },
              { label: "Next 60 days", from: today, to: addDays(today, 60) },
            ].map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                onClick={() => applyRange(p.from, p.to)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {invalidRange && (
            <p className="text-sm text-destructive">
              The start date must be on or before the end date.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Audit vs CLWRota</CardTitle>
          <Button
            onClick={() => compare.mutate(range)}
            disabled={compare.isPending}
            data-testid="icu-dashboard-compare"
          >
            {compare.isPending ? "Comparing…" : "Compare with CLWRota"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {compare.isError && (
            <p className="text-sm text-destructive">{(compare.error as Error).message}</p>
          )}
          {!result && !compare.isPending && (
            <p className="text-sm text-muted-foreground">
              Run the comparison to fetch the live CLWRota report for {range.startIso} →{" "}
              {range.endIso} and check it against the ICU audit.
            </p>
          )}
          {result && (
            <div className="space-y-5" data-testid="icu-dashboard-comparison">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">CLWRota source</div>
                  <div className="text-2xl font-semibold" data-testid="icu-compare-source-count">
                    {result.sourceCount}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">ICU audit</div>
                  <div className="text-2xl font-semibold" data-testid="icu-compare-audit-count">
                    {result.auditCount}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs uppercase text-muted-foreground">Result</div>
                  <div className="pt-1">
                    {result.diverged ? (
                      <Badge variant="destructive">Diverged</Badge>
                    ) : (
                      <Badge variant="secondary">Exact match</Badge>
                    )}
                  </div>
                </div>
              </div>

              {result.byStaff.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="icu-dashboard-by-staff">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Doctor</th>
                        <th className="py-2 pr-3 text-right">CLWRota</th>
                        <th className="py-2 pr-3 text-right">Audit</th>
                        <th className="py-2 pr-3 text-right">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.byStaff.map((s) => (
                        <tr key={s.staffId} className="border-t">
                          <td className="py-2 pr-3">{s.staffName}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{s.sourceCount}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{s.auditCount}</td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${
                              s.diff === 0 ? "text-muted-foreground" : "font-medium text-destructive"
                            }`}
                          >
                            {s.diff > 0 ? `+${s.diff}` : s.diff}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result.diverged && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h2 className="mb-1 text-sm font-medium">
                      In CLWRota, missing from the audit ({result.missingFromAudit.length})
                    </h2>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {result.missingFromAudit.map((d) => (
                        <li key={d.key}>
                          {formatDateWithWeekdayGB(d.session_date)} ·{" "}
                          {SESSION_LABEL[d.session] ?? d.session} · {d.staffName}
                          {d.label ? ` — “${d.label}”` : ""}
                        </li>
                      ))}
                      {result.missingFromAudit.length === 0 && <li>None</li>}
                    </ul>
                  </div>
                  <div>
                    <h2 className="mb-1 text-sm font-medium">
                      In the audit, not in CLWRota ({result.extraInAudit.length})
                    </h2>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {result.extraInAudit.map((d) => (
                        <li key={d.key}>
                          {formatDateWithWeekdayGB(d.session_date)} ·{" "}
                          {SESSION_LABEL[d.session] ?? d.session} · {d.staffName} —{" "}
                          {DUTY_LABEL[d.dutyType] ?? d.dutyType}
                        </li>
                      ))}
                      {result.extraInAudit.length === 0 && <li>None</li>}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Source records (traceability)</CardTitle>
          <Button
            variant="outline"
            onClick={() => traces.mutate(range)}
            disabled={traces.isPending}
            data-testid="icu-traces-load"
          >
            {traces.isPending ? "Loading…" : "Show CLWRota source records"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {traces.isError && (
            <p className="text-sm text-destructive">{(traces.error as Error).message}</p>
          )}
          {!traces.data && !traces.isPending && (
            <p className="text-sm text-muted-foreground">
              Every intensive care session found in CLWRota is saved with the record it came from.
              Run the comparison first, then load the source records for {range.startIso} →{" "}
              {range.endIso}.
            </p>
          )}
          {traces.data && traces.data.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No saved source records for this range yet — run the comparison above first.
            </p>
          )}
          {traces.data && traces.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="icu-traces-table">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Session</th>
                    <th className="py-2 pr-3">Doctor</th>
                    <th className="py-2 pr-3">Matched on</th>
                    <th className="py-2 pr-3">CLWRota ref</th>
                    <th className="py-2 pr-3 text-right">PA</th>
                    <th className="py-2 pr-3">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.data.map((t) => (
                    <tr key={t.id} className="border-t align-top">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {formatDateWithWeekdayGB(t.sessionDate)}
                      </td>
                      <td className="py-2 pr-3">{SESSION_LABEL[t.session] ?? t.session}</td>
                      <td className="py-2 pr-3">{t.staffName}</td>
                      <td className="py-2 pr-3">
                        {t.matchedValue ? (
                          <>
                            <span className="text-muted-foreground">
                              {t.matchedField ?? "text"}:
                            </span>{" "}
                            {t.matchedValue}
                          </>
                        ) : (
                          (t.placeName ?? t.slotTitles ?? "—")
                        )}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {t.clwrotaExternalId ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t.paCredit ?? "—"}</td>
                      <td className="py-2 pr-3">
                        <details>
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            View
                          </summary>
                          <pre className="mt-1 max-w-md overflow-x-auto rounded bg-muted p-2 text-xs">
                            {t.sourceRow}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

