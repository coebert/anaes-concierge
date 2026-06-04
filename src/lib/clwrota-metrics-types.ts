/**
 * Shared types + runtime validation for CLWRota sync metrics. Derived from
 * the generated Supabase Database types so the row shape stays in sync
 * across the server fn (`listClwRotaSyncMetrics`) and every UI consumer.
 *
 * `is_backfill` is required on read — synthetic/backfilled rows must be
 * classified explicitly by all renderers. The Zod schema below enforces
 * this at runtime so a stale DB column, a missing GRANT, or a buggy edge
 * case can never hand the UI a row without the classifier.
 */
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

export type ClwRotaSyncMetricRow =
  Database["public"]["Tables"]["clwrota_sync_metrics"]["Row"];

export type ClwRotaSyncKind = "leave" | "rota" | "staff";

export type ListClwRotaSyncMetricsResponse = {
  rows: ClwRotaSyncMetricRow[];
  days: number;
  sync_kind: ClwRotaSyncKind | "all";
};

/** Classifies a metrics row as synthetic/backfilled vs a real sync run. */
export function isBackfillMetricRow(row: ClwRotaSyncMetricRow): boolean {
  return Boolean(row.is_backfill) || Boolean(row.notes?.startsWith("[BACKFILL"));
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/**
 * Zod schema mirroring `ClwRotaSyncMetricRow`. `is_backfill` is a
 * non-nullable boolean — if Postgres ever sends `null` or omits the field,
 * parsing fails loudly instead of silently rendering an unclassified row.
 */
export const clwRotaSyncMetricRowSchema = z.object({
  id: z.string(),
  sync_kind: z.string(),
  run_at: z.string(),
  ok: z.boolean(),
  duration_ms: z.number().nullable(),
  rows_pulled: z.number(),
  rows_drafted: z.number(),
  rows_upserted: z.number(),
  rows_failed: z.number(),
  rows_skipped_validation: z.number(),
  chunks_total: z.number(),
  chunks_succeeded_first_try: z.number(),
  chunks_succeeded_after_retry: z.number(),
  chunks_fell_back_to_per_row: z.number(),
  per_row_attempts: z.number(),
  per_row_succeeded: z.number(),
  per_row_failed: z.number(),
  upsert_attempts_total: z.number(),
  upsert_retries_total: z.number(),
  errors_count: z.number(),
  notes: z.string().nullable(),
  is_backfill: z.boolean(),
  rows_deleted: z.number(),
  non_working_cleaned: z.number(),
}) satisfies z.ZodType<ClwRotaSyncMetricRow>;

export const listClwRotaSyncMetricsResponseSchema = z.object({
  rows: z.array(clwRotaSyncMetricRowSchema),
  days: z.number(),
  sync_kind: z.enum(["leave", "rota", "staff", "all"]),
}) satisfies z.ZodType<ListClwRotaSyncMetricsResponse>;

/**
 * Parse + validate a metrics list response. Throws a descriptive error
 * (with the row index) if any row is missing `is_backfill` or has the
 * wrong type for any field. Use this at every trust boundary — both at
 * the end of the server fn handler and again on the client right after
 * fetch — so the UI never renders an un-validated row.
 */
export function parseListClwRotaSyncMetricsResponse(
  value: unknown,
): ListClwRotaSyncMetricsResponse {
  const result = listClwRotaSyncMetricsResponseSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".") ?? "<root>";
    throw new Error(
      `Invalid clwrota_sync_metrics response at ${path}: ${first?.message ?? "unknown error"}`,
    );
  }
  return result.data;
}
