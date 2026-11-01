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

/**
 * Minimal client surface. The UPDATE must return the affected row so the
 * caller reconciles with the server's authoritative decision metadata (the
 * DB trigger stamps `decided_by`/`decided_at` for coordinator decisions and
 * forbids owners from touching them). Zero returned rows (RLS filtered the
 * update) is treated as a failure, never as success.
 */
export interface SupabaseLike {
  from: (table: string) => {
    update: (patch: Record<string, unknown>) => {
      eq: (
        col: string,
        val: string,
      ) => {
        select: (cols: string) => PromiseLike<{
          data: Array<Record<string, unknown>> | null;
          error: { message: string } | null;
        }>;
      };
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

export type LeaveStatusTerminal = "cancelled" | "approved" | "rejected";

/**
 * Columns the server owns. `decided_by`/`decided_at` are stamped by the
 * update trigger for coordinator decisions; owners may never change them.
 * Identity/import/encrypted columns are never client-writable.
 */
export const PROTECTED_LEAVE_FIELDS = [
  "id",
  "staff_id",
  "status",
  "decided_by",
  "decided_at",
  "created_at",
  "clwrota_external_id",
  "reason_enc",
  "decision_notes_enc",
  "conflict_notes_enc",
] as const;

/** Extra fields a coordinator decision may write alongside the status. */
const DECISION_EXTRA_FIELDS = new Set(["decision_notes", "reserve_listed_at"]);

/** Columns read back after the UPDATE to reconcile caches. */
export const LEAVE_RECONCILE_COLUMNS =
  "id,status,decided_at,decided_by,decision_notes,reserve_listed_at";

/**
 * Build the exact UPDATE body sent to the server.
 *  - cancel: `{ status: "cancelled" }` only — the owner guard rejects any
 *    change to decision metadata, and the original decision is preserved.
 *  - approve/reject: status plus allowlisted decision extras. Protected
 *    fields in `extraPatch` are dropped so they can never override the
 *    status or forge the actor/time.
 */
export function buildLeaveStatusPatch(
  status: LeaveStatusTerminal,
  extraPatch?: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (status !== "cancelled") {
    for (const [k, v] of Object.entries(extraPatch ?? {})) {
      if (DECISION_EXTRA_FIELDS.has(k)) patch[k] = v;
    }
  }
  patch.status = status;
  return patch;
}

export interface OptimisticUpdateLeaveStatusOptions {
  id: string;
  status: LeaveStatusTerminal;
  /** Stable dotted label passed to `invalidateWellbeing`. */
  reason: string;
  /** Decision extras (`decision_notes`, `reserve_listed_at`); others ignored. */
  extraPatch?: Record<string, unknown>;
  supabase: SupabaseLike;
  qc: QueryClient;
  patchRows?: Patcher;
  patchMyLeave?: Patcher;
  /** Retained for call-site compatibility; the client no longer invents timestamps. */
  now?: () => Date;
}

export type OptimisticUpdateLeaveStatusResult =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; error: Error };

export async function optimisticUpdateLeaveStatus(
  opts: OptimisticUpdateLeaveStatusOptions,
): Promise<OptimisticUpdateLeaveStatusResult> {
  const { id, status, reason, extraPatch, supabase, qc, patchRows, patchMyLeave } = opts;
  const rowPatch = buildLeaveStatusPatch(status, extraPatch);

  // -- 1/2. Optimistic patches: status (+ notes) only; no invented
  // authoritative metadata. The server row replaces it on success.
  let rowsSnapshot: LeaveRow[] | null = null;
  let myLeaveSnapshot: LeaveRow[] | null = null;
  const applyPatch =
    (patch: Record<string, unknown>) =>
    (r: LeaveRow): LeaveRow =>
      r.id === id ? { ...r, ...(patch as Partial<LeaveRow>) } : r;

  if (patchRows) {
    patchRows((prev) => {
      rowsSnapshot = prev;
      return prev.map(applyPatch(rowPatch));
    });
  }
  if (patchMyLeave) {
    patchMyLeave((prev) => {
      myLeaveSnapshot = prev;
      return prev.map(applyPatch(rowPatch));
    });
  }

  const cacheSnapshots: Array<{ key: readonly unknown[]; prev: CachedWellbeingData | undefined }> =
    [];
  const cache = qc.getQueryCache();
  const patchCaches = (patch: Record<string, unknown>) => {
    for (const keyPrefix of [["my-wellbeing"], ["admin-wellbeing"]]) {
      qc.setQueriesData<CachedWellbeingData>({ queryKey: keyPrefix }, (old) => {
        if (!old || !Array.isArray(old.leave)) return old;
        return {
          ...old,
          leave: old.leave.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        };
      });
    }
  };
  for (const keyPrefix of [["my-wellbeing"], ["admin-wellbeing"]]) {
    for (const q of cache.findAll({ queryKey: keyPrefix })) {
      cacheSnapshots.push({
        key: q.queryKey,
        prev: q.state.data as CachedWellbeingData | undefined,
      });
    }
  }
  patchCaches(rowPatch);

  const rollback = () => {
    if (rowsSnapshot !== null && patchRows) patchRows(() => rowsSnapshot as LeaveRow[]);
    if (myLeaveSnapshot !== null && patchMyLeave) patchMyLeave(() => myLeaveSnapshot as LeaveRow[]);
    for (const snap of cacheSnapshots) qc.setQueryData(snap.key as unknown[], snap.prev);
  };

  // -- 3. Server round-trip --------------------------------------------
  let data: Array<Record<string, unknown>> | null = null;
  let errMsg: string | null = null;
  try {
    const res = await supabase
      .from("leave_requests")
      .update(rowPatch)
      .eq("id", id)
      .select(LEAVE_RECONCILE_COLUMNS);
    data = res.data;
    if (res.error) errMsg = res.error.message;
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
  }
  const serverRow = data?.[0];
  if (errMsg || !serverRow || serverRow.status !== status) {
    rollback();
    return {
      ok: false,
      error: new Error(
        errMsg ?? "The leave request was not updated (no permission or it changed).",
      ),
    };
  }

  // -- 4. Reconcile with the server's authoritative row -----------------
  const authoritative: Record<string, unknown> = {};
  for (const k of LEAVE_RECONCILE_COLUMNS.split(",")) {
    if (k !== "id" && k in serverRow) authoritative[k] = serverRow[k];
  }
  if (patchRows) patchRows((prev) => prev.map(applyPatch(authoritative)));
  if (patchMyLeave) patchMyLeave((prev) => prev.map(applyPatch(authoritative)));
  patchCaches(authoritative);
  invalidateWellbeing(qc, reason, { ids: [id] });
  return { ok: true, row: serverRow };
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
