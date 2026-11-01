/**
 * Shared paginated fetch helper for audit queries.
 *
 * Why this exists
 * ---------------
 * Supabase / PostgREST silently caps a single `.select()` at 1000 rows, so
 * every multi-month audit query has to page. Two failure modes have bitten
 * us in prod:
 *
 * 1. **Non-deterministic ordering.** If the `ORDER BY` is not unique, two
 *    OFFSET windows can legitimately return the same row twice (or skip
 *    rows entirely) at the page boundary. The TCS 2016 audit hit this
 *    when ordering only by `session_date` — an AM session on the boundary
 *    date appeared on two pages and got counted as a 15h shift.
 *
 * 2. **Concurrent writes.** Even with a deterministic order, a row
 *    inserted between page N and page N+1 can shift the boundary by one,
 *    re-emitting the previous page's last row.
 *
 * This helper:
 *   - Asks callers to provide a `rowKey` so we can dedupe across pages.
 *     A `(staff_id, session_date, session)` tuple is usually right for
 *     rota_assignments; primary-key `id` is right for anything else.
 *   - Detects when a page boundary overlaps the previous page (same key
 *     appears as the last row of page N and the first row of page N+1) and
 *     logs a one-line console warning so we notice if the upstream order
 *     ever degrades.
 *   - Stops at a hard safety cap (default 100k rows) so a runaway query
 *     never hangs the browser tab.
 *
 * Callers MUST still apply a deterministic `ORDER BY` in the query they
 * build — ideally including a unique tiebreaker such as `id` — because
 * dedupe alone cannot recover rows that pagination *skipped*.
 */

import { drainPages } from "@/lib/paged-fetch-core";

const PAGE_SIZE = 1000;
const SAFETY_CAP = 100_000;

export interface PaginateOptions<T> {
  /**
   * Returns a stable string key per row used to dedupe across page
   * boundaries. If omitted, dedupe is disabled — only use this when the
   * query is ordered by a column you know to be unique (a primary key)
   * AND the table is not being written to concurrently.
   */
  rowKey?: (row: T) => string;
  /** Page size override. Default 1000 (matches Supabase's row cap). */
  pageSize?: number;
  /** Hard stop after this many accumulated rows. Default 100,000. */
  safetyCap?: number;
  /** Label used in warning logs to identify the query. */
  label?: string;
}

export async function fetchAllRowsPaged<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | unknown | null }>,
  opts: PaginateOptions<T> = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const safetyCap = opts.safetyCap ?? SAFETY_CAP;
  const label = opts.label ?? "audit query";
  // drainPages throws on any page error and on exceeding the cap (with a
  // one-row probe when the cap lands exactly on a full page).
  const raw = await drainPages<T>(build as never, { pageSize, maxRows: safetyCap, label });
  if (!opts.rowKey) return raw;
  const seen = new Set<string>();
  const out: T[] = [];
  let overlaps = 0;
  for (const row of raw) {
    const key = opts.rowKey(row);
    if (seen.has(key)) {
      overlaps++;
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  if (overlaps > 0) {
    console.warn(
      `[paginate ${label}] dropped ${overlaps} duplicate row(s) across page boundaries — the query order is not unique; add a tiebreaker column.`,
    );
  }
  return out;
}

/** Stable key for a rota_assignments row. */
export const rotaAssignmentKey = (r: {
  staff_id: string;
  session_date: string;
  session: string;
}): string => `${r.staff_id}|${r.session_date}|${r.session}`;

/** Stable key for any row that exposes a primary `id`. */
export const idKey = (r: { id: string }): string => r.id;
