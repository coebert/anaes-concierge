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
 * per invalidated key with the reason and a short timestamp, and pushes an
 * entry into an in-memory ring buffer consumed by the dev diagnostics panel
 * (see `WellbeingInvalidationsPanel`). In prod both are no-ops.
 */
export function invalidateWellbeing(qc: QueryClient, reason?: string): void {
  recordWellbeingInvalidation("admin-wellbeing", reason);
  recordWellbeingInvalidation("my-wellbeing", reason);
  void qc.invalidateQueries({ queryKey: ["admin-wellbeing"] });
  void qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
}

export type WellbeingInvalidationEntry = {
  id: number;
  key: string;
  reason: string;
  at: string;
};

const MAX_ENTRIES = 50;
const entries: WellbeingInvalidationEntry[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function recordWellbeingInvalidation(key: string, reason: string | undefined): void {
  if (!import.meta.env.DEV) return;
  const label = reason ?? "unspecified";
  const at = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.debug(
    `[wellbeing] invalidate queryKey=["${key}"] reason=${label} at=${at}`,
  );
  entries.unshift({ id: nextId++, key, reason: label, at });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  for (const l of listeners) l();
}

/** Read-only snapshot of recent invalidations, newest first. */
export function getWellbeingInvalidations(): ReadonlyArray<WellbeingInvalidationEntry> {
  return entries;
}

/** Subscribe to invalidation buffer changes. Returns unsubscribe fn. */
export function subscribeWellbeingInvalidations(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear the buffer. */
export function clearWellbeingInvalidations(): void {
  entries.length = 0;
  for (const l of listeners) l();
}
