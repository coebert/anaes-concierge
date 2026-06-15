import { CheckCircle2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export type AuditCoverageStep = {
  /** Human-readable name of the query that was walked. */
  label: string;
  /** Number of `.in()` chunks issued (1 when the query took no ID list). */
  chunks: number;
  /** Total pages of rows fetched across all chunks. */
  pages: number;
  /** Total rows returned across all pages. */
  rows: number;
  /**
   * True when the final page of every chunk returned fewer rows than the
   * page size, proving PostgREST's 1000-row cap was not hit. False if any
   * chunk ended on a full page (which would mean the result set may have
   * been truncated).
   */
  complete: boolean;
};

export type AuditCoverage = {
  steps: AuditCoverageStep[];
};

export function AuditCoverageBadge({ coverage }: { coverage: AuditCoverage | null | undefined }) {
  if (!coverage) return null;
  const allComplete = coverage.steps.every((s) => s.complete);
  return (
    <Card
      className={
        allComplete
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5"
      }
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          {allComplete ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          )}
          Data coverage
          {allComplete ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15">
              COMPLETE
            </Badge>
          ) : (
            <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15">
              POSSIBLE TRUNCATION
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        <p className="text-muted-foreground">
          {allComplete
            ? "All paginated and chunked queries drained to a partial final page, so no rows were dropped by URL-length or 1000-row response limits."
            : "At least one query ended on a full page. The result set may be truncated — narrow the date range or report this."}
        </p>
        <ul className="text-xs text-muted-foreground space-y-0.5 pt-1">
          {coverage.steps.map((s) => (
            <li key={s.label} className="font-mono">
              {s.complete ? "✓" : "⚠"} {s.label}: {s.rows.toLocaleString()} row
              {s.rows === 1 ? "" : "s"} across {s.pages} page
              {s.pages === 1 ? "" : "s"}
              {s.chunks > 1 ? ` / ${s.chunks} chunks` : ""}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
