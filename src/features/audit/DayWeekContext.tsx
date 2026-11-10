import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { QueryErrorNotice } from "@/components/query-state-notice";
import { formatDateGB } from "@/lib/utils";
import { isoWeekStart } from "@/features/clwrota/week-status-core";
import { buildWeekStatusTimeline, loadWeekStatus } from "./rota-week-status";
import {
  buildImportCoverageTimeline,
  importWeekHelp,
  loadImportCoverage,
} from "./rota-sync-coverage";
import { ImportChip, WeekChip } from "./TheatrePressureCard";

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Recheck context for one day: the feed's week status and the week's import
 * coverage/freshness, shown as two separate facts (same sources as the
 * Robustness forecast). Missing tracking reads as not tracked, never OK.
 */
export function DayWeekContext({ date }: { date: string }) {
  const ws = isoWeekStart(date);
  const we = addDays(ws, 6);
  const statusQ = useQuery({
    queryKey: ["clwrota-week-status", ws, we],
    queryFn: () => loadWeekStatus(ws, we),
  });
  const importQ = useQuery({
    queryKey: ["clwrota-import-coverage", ws, we],
    queryFn: () => loadImportCoverage(ws, we),
  });
  const status = useMemo(
    () =>
      statusQ.data
        ? buildWeekStatusTimeline({
            rangeStart: ws,
            rangeEnd: we,
            rows: statusQ.data.rows,
            capture: statusQ.data.capture,
            now: new Date(),
          })
        : null,
    [statusQ.data, ws, we],
  );
  const imports = useMemo(
    () =>
      importQ.data
        ? buildImportCoverageTimeline({
            rangeStart: ws,
            rangeEnd: we,
            rows: importQ.data.rows,
            capture: importQ.data.capture,
            now: new Date(),
          })
        : null,
    [importQ.data, ws, we],
  );
  const w = status?.capture === "available" ? status.byWeek.get(ws) : undefined;
  const imp = imports?.capture === "available" ? (imports.byWeek.get(ws) ?? null) : undefined;
  return (
    <section
      aria-label="Rota week context"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-2 text-xs"
    >
      <span className="text-muted-foreground">Week of {formatDateGB(ws)}</span>
      {statusQ.error ? (
        <QueryErrorNotice
          error={statusQ.error}
          onRetry={() => void statusQ.refetch()}
          what="rota week status"
        />
      ) : status?.capture === "not_installed" ? (
        <span className="text-muted-foreground">Rota status not recorded yet</span>
      ) : status ? (
        <span className="flex items-center gap-1">
          Rota status <WeekChip status={w?.status ?? "not_observed"} />
          {w?.observedAt ? (
            <span className="text-muted-foreground">
              checked {formatDateGB(w.observedAt.slice(0, 10))}
            </span>
          ) : null}
        </span>
      ) : null}
      {importQ.error ? (
        <QueryErrorNotice
          error={importQ.error}
          onRetry={() => void importQ.refetch()}
          what="rota import coverage"
        />
      ) : imports?.capture === "not_installed" ? (
        <span className="text-muted-foreground">Import tracking not switched on yet</span>
      ) : imports ? (
        <span className="flex items-center gap-1" title={imp ? importWeekHelp(imp) : undefined}>
          Import <ImportChip entry={imp ?? null} />
          {imp?.lastKnownGoodAt ? (
            <span className="text-muted-foreground">
              good as of {formatDateGB(imp.lastKnownGoodAt.slice(0, 10))}
            </span>
          ) : null}
        </span>
      ) : null}
      <Link to="/robustness" className="ml-auto text-primary hover:underline">
        Recheck in the theatre pressure forecast
      </Link>
    </section>
  );
}
