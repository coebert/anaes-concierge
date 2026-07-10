import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate every wellbeing-derived cache. Call after any mutation to
 * leave_requests, return_to_work_interviews, or exception_reports so the
 * admin and personal wellbeing dashboards reflect the change on the next
 * render without waiting for the 10-minute refetch interval or window focus.
 *
 * Optional `reason` is used for dev-mode diagnostics only — it lets the
 * console trail identify which mutation path triggered the invalidation
 * (e.g. "leave.cancel", "exception.withdraw", "exception.resolve",
 * "rtw.save"). Prefer stable dotted labels so log filters keep working.
 *
 * In dev (import.meta.env.DEV) each call emits one `console.debug` line
 * per invalidated key with the reason and a short timestamp. In prod the
 * logging is a no-op — the two invalidateQueries calls are unchanged.
 */
export function invalidateWellbeing(qc: QueryClient, reason?: string): void {
  logWellbeingInvalidation("admin-wellbeing", reason);
  logWellbeingInvalidation("my-wellbeing", reason);
  void qc.invalidateQueries({ queryKey: ["admin-wellbeing"] });
  void qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
}

function logWellbeingInvalidation(key: string, reason: string | undefined): void {
  // `import.meta.env.DEV` is statically replaced by Vite: `true` in dev,
  // `false` in prod, so the whole block tree-shakes out of prod bundles.
  if (!import.meta.env.DEV) return;
  const label = reason ?? "unspecified";
  // eslint-disable-next-line no-console
  console.debug(
    `[wellbeing] invalidate queryKey=["${key}"] reason=${label} at=${new Date().toISOString()}`,
  );
}
