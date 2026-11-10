import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { QueryErrorNotice } from "@/components/query-state-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth-context";
import { addDaysISO, formatDateGB } from "@/lib/utils";
import {
  buildWeekStatusTimeline,
  loadWeekStatus,
  WEEK_STATUS_LABEL,
} from "@/features/audit/rota-week-status";
import {
  buildImportCoverageTimeline,
  importWeekLabel,
  loadImportCoverage,
} from "@/features/audit/rota-sync-coverage";
import {
  buildSessionReconciliation,
  loadReconciliationInputs,
  VERDICT_LABEL,
  verdictHelp,
  type ListVerdict,
} from "@/features/clwrota/session-reconciliation";

export const Route = createFileRoute("/_authenticated/coordinator/unlinked-sessions")({
  head: () => ({
    meta: [
      { title: "Unplaced rota sessions — Salisbury Anaesthetics Rota" },
      {
        name: "description",
        content:
          "Theatre lists with nobody linked from CLWRota, beside the rota rows the import couldn't place on a list.",
      },
      { property: "og:title", content: "Unplaced rota sessions — Salisbury Anaesthetics Rota" },
      {
        property: "og:description",
        content: "Settle blank theatre lists against unplaced CLWRota rows for the same half-day.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: UnlinkedSessionsPage,
});

const WEEKS_VISIBLE = 12;

const HALF_LABEL: Record<string, string> = { am: "AM", pm: "PM", eve: "Evening", night: "Night" };
const DUTY_LABEL: Record<string, string> = {
  theatre: "Theatre",
  consultant_in_charge: "Consultant in charge",
  obstetrics: "Obstetrics",
  obstetrics_2nd: "Obstetrics (2nd)",
  icu_trainee: "ICU trainee",
  icu_ct2_plus: "ICU CT2+",
  icu_consultant_oncall: "ICU consultant on-call",
  general_consultant_oncall: "Consultant on-call",
  registrar_oncall: "Registrar on-call",
  sho_oncall: "SHO on-call",
  spa: "SPA",
  admin: "Admin",
  teaching: "Teaching",
  non_clinical: "Non-clinical",
  nhh_oncall: "NHH on-call",
  medical_examiner: "Medical examiner",
};
const ROLE_LABEL: Record<string, string> = {
  solo: "Solo",
  supervised: "Supervised",
  supervising: "Supervising",
  on_call: "On-call",
  non_clinical: "Non-clinical",
  teaching: "Teaching",
  admin_session: "Admin",
};
const dutyLabel = (d: string) => DUTY_LABEL[d] ?? d;
const VERDICT_VARIANT: Record<ListVerdict, "default" | "secondary" | "outline" | "destructive"> = {
  candidate_rows: "default",
  import_unconfirmed: "outline",
  nobody_in_feed: "secondary",
};

function UnlinkedSessionsPage() {
  const { isCoordinatorOrAdmin } = useAuth();
  const allowed = isCoordinatorOrAdmin();
  const [offsetWeeks, setOffsetWeeks] = useState(0);
  const [theatreFilter, setTheatreFilter] = useState("all");
  const [dutyFilter, setDutyFilter] = useState("theatre");

  const { rangeStart, rangeEnd } = useMemo(
    () => ({
      rangeStart: addDaysISO(offsetWeeks * 7),
      rangeEnd: addDaysISO(offsetWeeks * 7 + WEEKS_VISIBLE * 7 - 1),
    }),
    [offsetWeeks],
  );

  const inputsQ = useQuery({
    queryKey: ["session-reconciliation", rangeStart, rangeEnd],
    queryFn: () => loadReconciliationInputs(rangeStart, rangeEnd),
    enabled: allowed,
  });
  const weekQ = useQuery({
    queryKey: ["clwrota-week-status", rangeStart, rangeEnd],
    queryFn: () => loadWeekStatus(rangeStart, rangeEnd),
    enabled: allowed,
  });
  const importQ = useQuery({
    queryKey: ["clwrota-import-coverage", rangeStart, rangeEnd],
    queryFn: () => loadImportCoverage(rangeStart, rangeEnd),
    enabled: allowed,
  });

  const report = useMemo(() => {
    if (!inputsQ.data || !weekQ.data || !importQ.data) return null;
    const now = new Date();
    return buildSessionReconciliation({
      rangeStart,
      rangeEnd,
      lists: inputsQ.data.lists,
      linked: inputsQ.data.linked,
      unlinked: inputsQ.data.unlinked,
      weekStatus: buildWeekStatusTimeline({ rangeStart, rangeEnd, ...weekQ.data, now }),
      importCoverage: buildImportCoverageTimeline({ rangeStart, rangeEnd, ...importQ.data, now }),
    });
  }, [inputsQ.data, weekQ.data, importQ.data, rangeStart, rangeEnd]);

  const importByWeek = useMemo(() => {
    if (!importQ.data) return null;
    return buildImportCoverageTimeline({ rangeStart, rangeEnd, ...importQ.data, now: new Date() })
      .byWeek;
  }, [importQ.data, rangeStart, rangeEnd]);

  if (!allowed) {
    return (
      <div className="space-y-6">
        <PageHeader title="Unplaced rota sessions" />
        <p className="text-sm text-muted-foreground">
          This report is for admins and rota coordinators.
        </p>
      </div>
    );
  }

  const theatres = report ? [...new Set(report.emptyLists.map((e) => e.theatreName))].sort() : [];
  const emptyShown = report
    ? report.emptyLists.filter((e) => theatreFilter === "all" || e.theatreName === theatreFilter)
    : [];
  const rowsShown = report
    ? report.unlinkedRows.filter((r) => dutyFilter === "all" || r.dutyType === dutyFilter)
    : [];
  const staff = inputsQ.data?.staff;

  const firstError = inputsQ.error ?? weekQ.error ?? importQ.error;
  const retry = () => {
    if (inputsQ.isError) void inputsQ.refetch();
    if (weekQ.isError) void weekQ.refetch();
    if (importQ.isError) void importQ.refetch();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Unplaced rota sessions"
        description="Theatre lists with nobody linked from CLWRota, next to the CLWRota rows the import couldn't place on any list. Use it to settle blank lists — a row here is a lead to check, never an automatic match."
        actions={
          <Badge variant="secondary">
            {formatDateGB(rangeStart)} – {formatDateGB(rangeEnd)}
          </Badge>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOffsetWeeks((o) => o - WEEKS_VISIBLE)}
        >
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden /> Previous {WEEKS_VISIBLE} weeks
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOffsetWeeks(0)}
          disabled={offsetWeeks === 0}
        >
          From today
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOffsetWeeks((o) => o + WEEKS_VISIBLE)}
        >
          Next {WEEKS_VISIBLE} weeks <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
        </Button>
      </div>

      <Card>
        <CardContent className="flex gap-2 pt-6 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            The CLWRota feed lists people, not sessions. A list with nobody in the feed could be
            cancelled, not scheduled or uncovered — this screen can't tell those apart. Settle it in
            CLWRota (for example its Uncovered sessions report). Notes and list titles aren't shown
            here.
          </p>
        </CardContent>
      </Card>

      {firstError ? (
        <QueryErrorNotice error={firstError} onRetry={retry} what="the session report" />
      ) : !report ? (
        <PageLoading label="Loading sessions…" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Active lists" value={report.totals.activeLists} />
            <Stat label="Lists with nobody linked" value={report.totals.emptyLists} />
            <Stat label="Unplaced theatre rows" value={report.totals.unlinkedTheatreRows} />
            <Stat label="All unplaced CLWRota rows" value={report.totals.unlinkedRows} />
          </div>
          {report.totals.listsWithManualRowsOnly > 0 || report.totals.inactiveListsSkipped > 0 ? (
            <p className="text-xs text-muted-foreground">
              {report.totals.listsWithManualRowsOnly} list(s) have only manually added staff and
              aren't counted as empty. {report.totals.inactiveListsSkipped} list(s) in inactive
              theatres were left out.
            </p>
          ) : null}

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Lists with nobody linked</CardTitle>
                <CardDescription>
                  AM and PM lists in active theatres with no CLWRota or manual staff attached.
                </CardDescription>
              </div>
              <Select value={theatreFilter} onValueChange={setTheatreFilter}>
                <SelectTrigger className="w-48" aria-label="Filter by theatre">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All theatres</SelectItem>
                  {theatres.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {emptyShown.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every active list in this window has someone linked.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-3 font-medium">Date</th>
                        <th className="py-2 pr-3 font-medium">Half</th>
                        <th className="py-2 pr-3 font-medium">Theatre</th>
                        <th className="py-2 pr-3 font-medium">Week status</th>
                        <th className="py-2 pr-3 font-medium">Import</th>
                        <th className="py-2 pr-3 font-medium">Unplaced rows this half</th>
                        <th className="py-2 pr-3 font-medium">Where it stands</th>
                      </tr>
                    </thead>
                    <tbody>
                      {emptyShown.map((e) => {
                        const imp = importByWeek?.get(e.weekStart);
                        return (
                          <tr key={e.key} className="border-b align-top last:border-0">
                            <td className="py-2 pr-3 whitespace-nowrap">
                              <Link
                                to="/robustness/day/$date"
                                params={{ date: e.date }}
                                className="text-primary underline-offset-2 hover:underline"
                              >
                                {formatDateGB(e.date)}
                              </Link>
                            </td>
                            <td className="py-2 pr-3">{HALF_LABEL[e.half]}</td>
                            <td className="py-2 pr-3">{e.theatreName}</td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                              {e.weekStatus ? WEEK_STATUS_LABEL[e.weekStatus] : "—"}
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                              {imp ? importWeekLabel(imp) : "Not tracked"}
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                              {e.sameHalfTheatreRows} theatre
                              {e.sameHalfOtherRows ? ` · ${e.sameHalfOtherRows} other` : ""}
                            </td>
                            <td className="py-2 pr-3">
                              <Badge variant={VERDICT_VARIANT[e.verdict]}>
                                {VERDICT_LABEL[e.verdict]}
                              </Badge>
                              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                                {verdictHelp(e)}
                              </p>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>CLWRota rows not placed on a list</CardTitle>
                <CardDescription>
                  Imported rows with no theatre list. On-call, admin and ward work is normally here;
                  theatre rows are the ones worth checking.
                </CardDescription>
              </div>
              <Select value={dutyFilter} onValueChange={setDutyFilter}>
                <SelectTrigger className="w-56" aria-label="Filter by duty">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All duties ({report.totals.unlinkedRows})</SelectItem>
                  {report.unlinkedByDuty.map((d) => (
                    <SelectItem key={d.dutyType} value={d.dutyType}>
                      {dutyLabel(d.dutyType)} ({d.count})
                    </SelectItem>
                  ))}
                  {report.unlinkedByDuty.some((d) => d.dutyType === "theatre") ? null : (
                    <SelectItem value="theatre">Theatre (0)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {rowsShown.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No unplaced rows of this kind in this window.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-3 font-medium">Date</th>
                        <th className="py-2 pr-3 font-medium">Half</th>
                        <th className="py-2 pr-3 font-medium">Staff</th>
                        <th className="py-2 pr-3 font-medium">Grade</th>
                        <th className="py-2 pr-3 font-medium">Duty</th>
                        <th className="py-2 pr-3 font-medium">Role</th>
                        <th className="py-2 pr-3 font-medium">Week status</th>
                        <th className="py-2 pr-3 font-medium">Blank lists this half</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rowsShown.map((r) => {
                        const p = staff?.get(r.staffId);
                        return (
                          <tr key={r.id} className="border-b last:border-0">
                            <td className="py-2 pr-3 whitespace-nowrap">{formatDateGB(r.date)}</td>
                            <td className="py-2 pr-3">{HALF_LABEL[r.half] ?? r.half}</td>
                            <td className="py-2 pr-3">{p?.name ?? "Not visible to you"}</td>
                            <td className="py-2 pr-3 capitalize">{p?.grade ?? "—"}</td>
                            <td className="py-2 pr-3">{dutyLabel(r.dutyType)}</td>
                            <td className="py-2 pr-3">{ROLE_LABEL[r.role] ?? r.role}</td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                              {r.weekStatus ? WEEK_STATUS_LABEL[r.weekStatus] : "—"}
                            </td>
                            <td className="py-2 pr-3">
                              {r.emptyListsSameHalf ? (
                                <Badge variant="default">{r.emptyListsSameHalf}</Badge>
                              ) : (
                                "0"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
