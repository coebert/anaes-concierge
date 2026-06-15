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
