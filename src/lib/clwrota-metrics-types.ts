/**
 * Shared types for CLWRota sync metrics. Derived from the generated
 * Supabase Database types so the row shape stays in sync across the
 * server fn (`listClwRotaSyncMetrics`) and every UI consumer.
 *
 * `is_backfill` is required on read — synthetic/backfilled rows must be
 * classified explicitly by all renderers.
 */
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
