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
export async function fetchAllPaged<T>(
  build: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    out.push(...page);
    if (page.length < pageSize) break;
    if (from > 500_000) break; // safety cap
  }
  return out;
}
