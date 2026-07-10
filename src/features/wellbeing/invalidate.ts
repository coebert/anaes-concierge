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
export type InvalidateWellbeingOptions = {
  /**
   * Row IDs directly affected by the triggering mutation — the leave
   * request ID(s) for `leave.*` reasons, the exception report ID(s)
   * for `exception.*` reasons, the RTW interview ID(s) for `rtw.*`,
   * etc. Included verbatim in the dev-mode `console.debug` trail and
   * in the ring-buffer entry so the diagnostics panel can link a
   * cache refresh back to the row it came from. Prod: ignored.
   */
  ids?: readonly string[];
};

export function invalidateWellbeing(
  qc: QueryClient,
  reason?: string,
  opts?: InvalidateWellbeingOptions,
): void {
  const ids = opts?.ids ?? [];
  recordWellbeingInvalidation("admin-wellbeing", reason, ids);
  recordWellbeingInvalidation("my-wellbeing", reason, ids);
  void qc.invalidateQueries({ queryKey: ["admin-wellbeing"] });
  void qc.invalidateQueries({ queryKey: ["my-wellbeing"] });
}

export type WellbeingInvalidationEntry = {
  id: number;
  key: string;
  reason: string;
  /** Mutation-type prefix, e.g. "leave" for reason "leave.cancel". */
  mutationType: string;
  /** Row IDs affected by the mutation (may be empty). */
  ids: readonly string[];
  at: string;
};

const MAX_ENTRIES = 50;
let entries: WellbeingInvalidationEntry[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function formatIds(ids: readonly string[]): string {
  // Deterministic JSON-ish format so tests and log grep are stable.
  return `[${ids.map((id) => JSON.stringify(id)).join(",")}]`;
}

function mutationTypeOf(reason: string): string {
  // Everything before the first "." or ":" — "leave.cancel" -> "leave",
  // "exception.status:resolved" -> "exception", "unspecified" -> "unspecified".
  const cut = reason.search(/[.:]/);
  return cut === -1 ? reason : reason.slice(0, cut);
}

function recordWellbeingInvalidation(
  key: string,
  reason: string | undefined,
  ids: readonly string[],
): void {
  if (!import.meta.env.DEV) return;
  const label = reason ?? "unspecified";
  const mutationType = mutationTypeOf(label);
  const at = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.debug(
    `[wellbeing] invalidate queryKey=["${key}"] reason=${label} mutation=${mutationType} ids=${formatIds(ids)} at=${at}`,
  );
  // Replace the array reference so `useSyncExternalStore` (which
  // bails on Object.is-equal snapshots) actually re-renders.
  entries = [
    { id: nextId++, key, reason: label, mutationType, ids: [...ids], at },
    ...entries,
  ];
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
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
  entries = [];
  for (const l of listeners) l();
}
