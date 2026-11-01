import { supabase } from "@/integrations/supabase/client";
import { fetchAllPaged } from "@/lib/supabase-chunked";

/**
 * Minimal filter surface of a PostgREST builder used by pagedSelect callers.
 * Each call returns the same builder so filters chain.
 */
export interface PagedFilter {
  eq(col: string, v: unknown): PagedFilter;
  neq(col: string, v: unknown): PagedFilter;
  gte(col: string, v: unknown): PagedFilter;
  lte(col: string, v: unknown): PagedFilter;
  lt(col: string, v: unknown): PagedFilter;
  gt(col: string, v: unknown): PagedFilter;
  in(col: string, v: readonly unknown[]): PagedFilter;
  is(col: string, v: null | boolean): PagedFilter;
  not(col: string, op: string, v: unknown): PagedFilter;
  or(expr: string): PagedFilter;
}
interface Ordered extends PagedFilter {
  order(col: string, o: { ascending: boolean; nullsFirst?: boolean }): Ordered;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}

export interface PagedSelectOptions {
  filter?: (q: PagedFilter) => PagedFilter;
  /**
   * Stable order. MUST end with a unique column (normally "id") so page
   * boundaries never skip or duplicate tied rows. Prefix "-" for descending.
   */
  order: readonly string[];
  /** Label used in error messages ("rota_assignments" by default). */
  source?: string;
  maxRows?: number;
  client?: { from: (t: never) => unknown };
}

/**
 * Read EVERY matching row (1000-row pages) or throw: page errors (incl. page
 * 2+) raise PageFetchError and exceeding maxRows raises IncompleteResultError.
 * Never returns a silently truncated list.
 */
export async function pagedSelect<T>(
  table: string,
  columns: string,
  opts: PagedSelectOptions,
): Promise<T[]> {
  if (opts.order.length === 0) throw new RangeError("pagedSelect: order is required");
  const client = (opts.client ?? supabase) as unknown as {
    from: (t: string) => { select: (c: string) => Ordered };
  };
  return fetchAllPaged<T>(
    () => {
      let q = client.from(table).select(columns);
      if (opts.filter) q = opts.filter(q) as Ordered;
      for (const o of opts.order) {
        const desc = o.startsWith("-");
        q = q.order(desc ? o.slice(1) : o, { ascending: !desc });
      }
      return q as unknown as {
        range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
      };
    },
    { source: opts.source ?? table, maxRows: opts.maxRows },
  );
}
