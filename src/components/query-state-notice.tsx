import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shown instead of an empty state when a fetch FAILED, so a failed load
 * is never presented as "no clinical workload". When older data is still
 * on screen (a refetch failed), `stale` shows a lighter warning.
 */
export function QueryErrorNotice({
  error,
  onRetry,
  what = "this information",
  stale = false,
}: {
  error: unknown;
  onRetry?: () => void;
  what?: string;
  stale?: boolean;
}) {
  const msg = error instanceof Error ? error.message : error ? String(error) : "";
  return (
    <div
      role="alert"
      className={
        stale
          ? "flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-foreground"
          : "flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
      }
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {stale
          ? `Couldn't refresh ${what} — showing the last loaded version.`
          : `Couldn't load ${what}. This does not mean there is nothing to show.`}
        {msg ? ` (${msg})` : ""}
      </span>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" className="h-7" onClick={onRetry}>
          <RefreshCw className="mr-1 h-3 w-3" aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}
