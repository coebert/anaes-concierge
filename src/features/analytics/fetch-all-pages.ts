import { drainPages } from "@/lib/paged-fetch-core";

/**
 * The database API returns at most 1000 rows per request, silently dropping
 * the rest. Audit totals must never be truncated, so page through everything.
 *
 * Returns `complete: false` with an error instead of a silently-truncated
 * list when a page fails or the row cap is exceeded.
 */
export async function fetchAllPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
  maxRows = 100_000,
): Promise<{ data: T[]; error: { message: string; code?: string } | null; complete: boolean }> {
  try {
    const data = await drainPages<T>(page, { pageSize, maxRows, label: "analytics" });
    return { data, error: null, complete: true };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return {
      data: [],
      error: { message: err.message ?? String(e), code: err.code },
      complete: false,
    };
  }
}
