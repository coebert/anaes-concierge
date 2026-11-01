/**
 * Core of every "fetch all pages" helper. PostgREST caps each response
 * (1000 rows by default), so callers page with `.range()`.
 *
 * Contract:
 *   - pageSize and maxRows must be positive integers (validated).
 *   - Any page error (including page 2+) rejects — never returns a partial
 *     list as if it were complete.
 *   - Reaching maxRows does NOT silently succeed: when the cap lands exactly
 *     on a full page we issue a one-row probe; if more rows exist we throw
 *     IncompleteResultError, otherwise the result is complete.
 */
export class IncompleteResultError extends Error {
  readonly code = "INCOMPLETE_RESULT";
  constructor(
    readonly label: string,
    readonly rowsFetched: number,
    readonly cap: number,
  ) {
    super(
      `${label}: more than ${cap} rows — results would be incomplete, so they were not shown. Narrow the date range.`,
    );
    this.name = "IncompleteResultError";
  }
}

export class PageFetchError extends Error {
  readonly code = "PAGE_FETCH_FAILED";
  constructor(
    readonly label: string,
    readonly offset: number,
    message: string,
  ) {
    super(`${label}: failed to load rows from offset ${offset}: ${message}`);
    this.name = "PageFetchError";
  }
}

export type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

export interface DrainOptions {
  pageSize?: number;
  maxRows?: number;
  label?: string;
  onRequest?: () => void;
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

export function validatePaging(pageSize: number, maxRows: number): void {
  if (!Number.isInteger(pageSize) || pageSize <= 0)
    throw new RangeError(`pageSize must be a positive integer (got ${pageSize})`);
  if (!Number.isInteger(maxRows) || maxRows <= 0)
    throw new RangeError(`maxRows must be a positive integer (got ${maxRows})`);
}

export async function drainPages<T>(
  fetchPage: (from: number, to: number) => PageResult<T>,
  opts: DrainOptions = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 100_000;
  const label = opts.label ?? "query";
  validatePaging(pageSize, maxRows);
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const to = Math.min(from + pageSize, maxRows) - 1;
    opts.onRequest?.();
    const { data, error } = await fetchPage(from, to);
    if (error) throw new PageFetchError(label, from, errMessage(error));
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < to - from + 1) return out; // short page → end of data
  }
  // Cap reached exactly on a full page: probe for one more row.
  opts.onRequest?.();
  const probe = await fetchPage(maxRows, maxRows);
  if (probe.error) throw new PageFetchError(label, maxRows, errMessage(probe.error));
  if ((probe.data ?? []).length > 0) throw new IncompleteResultError(label, out.length, maxRows);
  return out;
}
