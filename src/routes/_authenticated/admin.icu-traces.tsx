import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listIcuTraces, type IcuTraceRow } from "@/features/analytics/icu-compare.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateWithWeekdayGB, toISODateLocal } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/icu-traces")({
  component: IcuTracesPage,
  head: () => ({
    meta: [
      { title: "ICU session traces — Anaesthetic Concierge" },
      {
        name: "description",
        content:
          "Every detected intensive care session listed with the original CLWRota record it was taken from, including the matched text, reference and PA value.",
      },
      { property: "og:title", content: "ICU session traces" },
      {
        property: "og:description",
        content:
          "Trace each intensive care session in the audit back to the CLWRota record that produced it.",
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

function IcuTracesPage() {
  const today = toISODateLocal(new Date());
  const [startIso, setStartIso] = useState(addDays(today, -90));
  const [endIso, setEndIso] = useState(today);
  const [search, setSearch] = useState("");
  const [staffFilter, setStaffFilter] = useState("all");
  const [range, setRange] = useState({ startIso: addDays(today, -90), endIso: today });

  const tracesFn = useServerFn(listIcuTraces);
  const traces = useMutation({
    mutationFn: (r: { startIso: string; endIso: string }) =>
      tracesFn({ data: r }) as Promise<IcuTraceRow[]>,
  });

  const invalidRange = startIso > endIso;
  const rows = useMemo(() => traces.data ?? [], [traces.data]);

  const staffOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.staffId, r.staffName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (staffFilter !== "all" && r.staffId !== staffFilter) return false;
      if (!q) return true;
      return [
        r.staffName,
        r.matchedValue,
        r.matchedField,
        r.placeName,
        r.slotTitles,
        r.roleLabel,
        r.personLabel,
        r.clwrotaExternalId,
        r.sourceRow,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [rows, search, staffFilter]);

  const totalPa = filtered.reduce((sum, r) => sum + (r.paCredit ?? 0), 0);

  const load = (from: string, to: string) => {
    setStartIso(from);
    setEndIso(to);
    setRange({ startIso: from, endIso: to });
    traces.mutate({ startIso: from, endIso: to });
  };

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="icu-traces-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">ICU session traces</h1>
        <p className="text-sm text-muted-foreground">
          Every intensive care session the audit has detected, shown with the CLWRota record it came
          from — the text that identified it, the reference, and the recorded PA value. Records are
          saved whenever the ICU comparison runs.
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
              data-testid="icu-traces-start"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">To</span>
            <Input
              type="date"
              value={endIso}
              onChange={(e) => setEndIso(e.target.value)}
              data-testid="icu-traces-end"
            />
          </label>
          <Button
            disabled={invalidRange || traces.isPending}
            onClick={() => load(startIso, endIso)}
            data-testid="icu-traces-load"
          >
            {traces.isPending ? "Loading…" : "Show sessions"}
          </Button>
          <div className="flex flex-wrap gap-2">
            {[
              { label: "Last 30 days", from: addDays(today, -30), to: today },
              { label: "Last 90 days", from: addDays(today, -90), to: today },
              { label: "Last 12 months", from: addDays(today, -365), to: today },
            ].map((p) => (
              <Button key={p.label} variant="outline" size="sm" onClick={() => load(p.from, p.to)}>
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
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">
            Detected sessions{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {range.startIso} → {range.endIso}
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search doctor, text or reference"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
              data-testid="icu-traces-search"
            />
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              data-testid="icu-traces-staff"
            >
              <option value="all">All doctors</option>
              {staffOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {traces.isError && (
            <p className="text-sm text-destructive">{(traces.error as Error).message}</p>
          )}
          {!traces.data && !traces.isPending && (
            <p className="text-sm text-muted-foreground">
              Choose a date range and select “Show sessions” to list the detected intensive care
              sessions and their source records.
            </p>
          )}
          {traces.data && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No saved sessions for this range yet. Run the comparison on the ICU audit vs CLWRota
              page for this range first — that is what saves the source records.
            </p>
          )}
          {rows.length > 0 && (
            <>
              <div className="flex flex-wrap gap-3 text-sm">
                <Badge variant="secondary" data-testid="icu-traces-count">
                  {filtered.length} sessions
                </Badge>
                <Badge variant="outline">{totalPa.toFixed(2)} PA recorded</Badge>
                <Badge variant="outline">{staffOptions.length} doctors</Badge>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="icu-traces-table">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Session</th>
                      <th className="py-2 pr-3">Doctor</th>
                      <th className="py-2 pr-3">Duty</th>
                      <th className="py-2 pr-3">Matched on</th>
                      <th className="py-2 pr-3">Location</th>
                      <th className="py-2 pr-3">CLWRota ref</th>
                      <th className="py-2 pr-3 text-right">PA</th>
                      <th className="py-2 pr-3">Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((t) => (
                      <tr key={t.id} className="border-t align-top">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatDateWithWeekdayGB(t.sessionDate)}
                        </td>
                        <td className="py-2 pr-3">{SESSION_LABEL[t.session] ?? t.session}</td>
                        <td className="py-2 pr-3">{t.staffName}</td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {t.dutyType ? (DUTY_LABEL[t.dutyType] ?? t.dutyType) : "—"}
                        </td>
                        <td className="py-2 pr-3">
                          {t.matchedValue ? (
                            <>
                              <span className="text-muted-foreground">
                                {t.matchedField ?? "text"}:
                              </span>{" "}
                              {t.matchedValue}
                            </>
                          ) : (
                            (t.slotTitles ?? "—")
                          )}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{t.placeName ?? "—"}</td>
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
                    {filtered.length === 0 && (
                      <tr>
                        <td className="py-3 text-muted-foreground" colSpan={9}>
                          No sessions match this search.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
