/**
 * Helpers for batching PostgREST `.in(...)` lookups.
 *
 * Supabase serialises `.in("id", ids)` into the request URL. When `ids`
 * grows to roughly 400+ UUIDs the URL exceeds the edge proxy's length limit
 * and the response is silently truncated or rejected, dropping rows from
 * the result set. The symptom is "Unknown specialty" or missing joins in
 * pages that aggregate IDs across many staff or many days.
 *
 * UUIDs are 36 chars + a comma → 200 IDs ≈ 7.4 KB, comfortably under the
 * limit. Use {@link chunkIds} to slice the input and run the queries in
 * parallel.
 */

export const SUPABASE_IN_CHUNK = 200;

export function chunkIds<T>(ids: readonly T[], size: number = SUPABASE_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}

/**
 * Fetch every row from a PostgREST query in fixed-size pages.
 *
 * Supabase's Data API caps a single response at `db-max-rows` (1000 by
 * default on hosted projects), even when the caller asks for a much larger
 * `.range(0, N)`. Callers that assumed a single wide `.range()` returned
 * every row silently got the first 1000 in effectively arbitrary order —
 * dropping recent leave/rota rows and making downstream metrics (e.g. the
 * wellbeing/attrition "days since last annual leave") wildly wrong.
 *
 * The builder must return the base PostgREST query with `.select`, filters
 * and a deterministic `.order(...)` already applied, but WITHOUT `.range()`
 * or `.limit()`. The pager attaches `.range()` in fixed windows and stops
 * when a page returns fewer rows than the window size.
 */
export type QueryBudget = {
  /** Human-readable name used in log/error messages. */
  label: string;
  /** Hard upper bound on the number of `.range()` requests attributed to this budget. */
  max: number;
  /** Live request count. Incremented by `fetchAllPaged` on every page request. */
  count: number;
  /** Optional per-source breakdown for diagnostics. */
  bySource: Record<string, number>;
};

export function createQueryBudget(label: string, max: number): QueryBudget {
  return { label, max, count: 0, bySource: {} };
}

/**
 * Emit an instrumentation log + enforce the hard cap. Call once after the
 * batch of paginated reads finishes. In test runs enforcement is skipped so
 * unit tests can inspect `budget.count` without tripping the guard.
 *
 * - In dev, exceeding the budget throws so regressions are caught in preview.
 * - In prod, exceeding the budget is a `console.error` (never crash the UI
 *   for a metric-driven read), so the log surfaces the regression while the
 *   page still renders.
 */
export function reportQueryBudget(budget: QueryBudget): void {
  const isTest =
    (typeof import.meta !== "undefined" && (import.meta as { env?: { MODE?: string } }).env?.MODE === "test") ||
    (typeof process !== "undefined" && process.env?.NODE_ENV === "test") ||
    (typeof process !== "undefined" && !!process.env?.VITEST);
  const isDev =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

  const summary = `[query-budget] ${budget.label}: ${budget.count}/${budget.max} requests ${JSON.stringify(budget.bySource)}`;
  if (!isTest) {
    // eslint-disable-next-line no-console
    console.info(summary);
  }
  if (budget.count > budget.max) {
    const msg = `Query budget exceeded for "${budget.label}": ${budget.count} > ${budget.max}. Breakdown: ${JSON.stringify(budget.bySource)}`;
    if (isTest) return;
    if (isDev) throw new Error(msg);
    // eslint-disable-next-line no-console
    console.error(msg);
  }
}

export async function fetchAllPaged<T>(
  build: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: unknown }>;
  },
  pageSizeOrOpts: number | { pageSize?: number; budget?: QueryBudget; source?: string } = 1000,
  maybeOpts?: { budget?: QueryBudget; source?: string },
): Promise<T[]> {
  const pageSize =
    typeof pageSizeOrOpts === "number"
      ? pageSizeOrOpts
      : pageSizeOrOpts.pageSize ?? 1000;
  const opts =
    typeof pageSizeOrOpts === "number" ? maybeOpts : pageSizeOrOpts;
  const budget = opts?.budget;
  const source = opts?.source ?? "unnamed";

  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    if (budget) {
      budget.count += 1;
      budget.bySource[source] = (budget.bySource[source] ?? 0) + 1;
    }
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) {
      const msg = (error as { message?: string }).message ?? String(error);
      throw new Error(msg);
    }
    const page = data ?? [];
    out.push(...page);
    if (page.length < pageSize) break;
    if (from > 500_000) break; // safety cap
  }
  return out;
}
