/**
 * Optimistic leave-status flow.
 *
 * A leave-row status change (cancel from any state, or a coordinator
 * decision that flips a `pending` row to `approved` / `rejected`) must
 * trigger an *immediate* wellbeing recalculation on every mounted
 * dashboard, without waiting for the server round-trip or the 10-minute
 * refetch interval. `computeWellbeing` reads:
 *
 *   - `status` — drives the leave counter that surfaces on both the
 *     personal `/wellbeing` card and the admin retention row.
 *   - `decided_at` — the day-bucketed timestamp used to place the row
 *     inside the rolling 90-day window.
 *
 * Both flows (cancel + decide) share the same 5-step recipe:
 *
 *   1. Patch the local row-array snapshots (page-level `useState`) so
 *      the UI reflects the new status immediately.
 *   2. Patch every cached wellbeing query (`["my-wellbeing", ...]` and
 *      `["admin-wellbeing"]`) so their `useMemo(computeWellbeing, ...)`
 *      picks up the new row without a network fetch.
 *   3. Fire the Supabase UPDATE with the caller-specified patch.
 *   4. On success, call `invalidateWellbeing(qc, reason, { ids })` to
 *      reconcile every wellbeing query with server truth on the next
 *      tick.
 *   5. On failure, roll back steps 1/2 and surface the error.
 *
 * The helper is pure w.r.t. React — it takes patcher callbacks — so
 * the whole flow can be unit-tested end-to-end without mounting any
 * route component.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { LeaveRow } from "@/features/leave/tabs/shared";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";

export interface SupabaseLike {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: string) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

type Patcher = (updater: (rows: LeaveRow[]) => LeaveRow[]) => void;

interface CachedWellbeingLeave {
  id?: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  decided_at?: string | null;
  half_day_start?: string | null;
  half_day_end?: string | null;
}
interface CachedWellbeingData {
  leave: CachedWellbeingLeave[];
  [key: string]: unknown;
}

/**
 * Terminal statuses `computeWellbeing` actually looks for. Kept as a
 * string union so callers can't accidentally push a `"pending"` back
 * through the optimistic path (which would silently reverse a
 * cancellation without touching the server row).
 */
export type LeaveStatusTerminal = "cancelled" | "approved" | "rejected";

export interface OptimisticUpdateLeaveStatusOptions {
  id: string;
  /** New row status — written to the cache AND to the Supabase update. */
  status: LeaveStatusTerminal;
  /**
   * Stable dotted label passed to `invalidateWellbeing` for the
   * dev-diagnostics trail, e.g. `"leave.cancel"`,
   * `"leave.decide:approved"`, `"leave.decide:rejected+reserve"`.
   */
  reason: string;
  /**
   * Extra columns to include in the Supabase UPDATE **and** in the
   * optimistic cache patch. Use for coordinator decisions that also
   * write `decided_by`, `decision_notes`, or `reserve_listed_at`. The
   * cache mirrors the same fields so `computeWellbeing` sees the same
   * shape as the eventual server row.
   */
  extraPatch?: Record<string, unknown>;
  supabase: SupabaseLike;
  qc: QueryClient;
  /**
   * Row-array patchers. Optional because the coordinator page owns
   * its rows via a `useQuery` cache rather than a local `useState`.
   */
  patchRows?: Patcher;
  patchMyLeave?: Patcher;
  /** Injectable clock — tests pin this so `decided_at` is deterministic. */
  now?: () => Date;
}

export type OptimisticUpdateLeaveStatusResult =
  | { ok: true }
  | { ok: false; error: Error };

export async function optimisticUpdateLeaveStatus(
  opts: OptimisticUpdateLeaveStatusOptions,
): Promise<OptimisticUpdateLeaveStatusResult> {
  const { id, status, reason, extraPatch, supabase, qc, patchRows, patchMyLeave } = opts;
  const now = (opts.now ?? (() => new Date()))();
  const decidedAt = now.toISOString();

  // Every terminal status transition stamps `decided_at` — the
  // wellbeing engine buckets on it and skips rows without one. Callers
  // can still override via `extraPatch` if they need to preserve an
  // existing timestamp.
  const rowPatch: Record<string, unknown> = {
    status,
    decided_at: decidedAt,
    ...(extraPatch ?? {}),
  };

  // -- 1/2. Optimistic patches (row arrays + wellbeing caches) ---------
  let rowsSnapshot: LeaveRow[] | null = null;
  let myLeaveSnapshot: LeaveRow[] | null = null;

  const applyRow = (r: LeaveRow): LeaveRow =>
    r.id === id ? { ...r, ...(rowPatch as Partial<LeaveRow>) } : r;

  if (patchRows) {
    patchRows((prev) => {
      rowsSnapshot = prev;
      return prev.map(applyRow);
    });
  }
  if (patchMyLeave) {
    patchMyLeave((prev) => {
      myLeaveSnapshot = prev;
      return prev.map(applyRow);
    });
  }

  // Snapshot each matching query by its EXACT key so rollback restores
  // the right cache entry even when the key includes extra segments
  // (e.g. `["my-wellbeing", staffId]`).
  const cacheSnapshots: Array<{ key: readonly unknown[]; prev: CachedWellbeingData | undefined }> = [];
  const cache = qc.getQueryCache();
  for (const keyPrefix of [["my-wellbeing"], ["admin-wellbeing"]]) {
    const matches = cache.findAll({ queryKey: keyPrefix });
    for (const q of matches) {
      cacheSnapshots.push({
        key: q.queryKey,
        prev: q.state.data as CachedWellbeingData | undefined,
      });
    }
    qc.setQueriesData<CachedWellbeingData>(
      { queryKey: keyPrefix },
      (old) => {
        if (!old || !Array.isArray(old.leave)) return old;
        return {
          ...old,
          leave: old.leave.map((l) =>
            l.id === id ? { ...l, ...rowPatch } : l,
          ),
        };
      },
    );
  }

  // -- 3. Server round-trip --------------------------------------------
  const { error } = await supabase
    .from("leave_requests")
    .update(rowPatch)
    .eq("id", id);

  if (error) {
    // -- 5. Roll back everything ---------------------------------------
    if (rowsSnapshot !== null && patchRows) patchRows(() => rowsSnapshot as LeaveRow[]);
    if (myLeaveSnapshot !== null && patchMyLeave)
      patchMyLeave(() => myLeaveSnapshot as LeaveRow[]);
    // Restore the exact prior cache values — including `undefined` if the
    // key wasn't in the cache before we patched it.
    for (const snap of cacheSnapshots) {
      qc.setQueryData(snap.key as unknown[], snap.prev);
    }
    return { ok: false, error: new Error(error.message) };
  }

  // -- 4. Reconcile with server truth ----------------------------------
  invalidateWellbeing(qc, reason, { ids: [id] });
  return { ok: true };
}

// ---------------------------------------------------------------------
// Backwards-compatible cancel wrapper.
// ---------------------------------------------------------------------

export interface OptimisticCancelOptions {
  id: string;
  supabase: SupabaseLike;
  qc: QueryClient;
  patchRows: Patcher;
  patchMyLeave: Patcher;
  now?: () => Date;
}

export type OptimisticCancelResult = OptimisticUpdateLeaveStatusResult;

export async function optimisticCancelLeave(
  opts: OptimisticCancelOptions,
): Promise<OptimisticCancelResult> {
  return optimisticUpdateLeaveStatus({
    id: opts.id,
    status: "cancelled",
    reason: "leave.cancel",
    supabase: opts.supabase,
    qc: opts.qc,
    patchRows: opts.patchRows,
    patchMyLeave: opts.patchMyLeave,
    now: opts.now,
  });
}
