/**
 * Compile-time type tests for the shared CLWRota sync-metrics types.
 *
 * These assertions are evaluated by `tsc` during the normal build. If the
 * generated Supabase row shape ever drops `is_backfill`, makes it optional,
 * or widens its type, the build fails here before the dashboard can render
 * a row that's missing the classifier.
 *
 * No runtime code — purely type-level.
 */
import type {
  ClwRotaSyncMetricRow,
  ListClwRotaSyncMetricsResponse,
} from "./clwrota-metrics-types";
import { isBackfillMetricRow } from "./clwrota-metrics-types";

// --- tiny type-equality helpers -------------------------------------------
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

// `?:` makes a key optional; this resolves to `true` only for required keys.
type IsRequired<T, K extends keyof T> =
  Record<string, never> extends Pick<T, K> ? false : true;

// --- assertions -----------------------------------------------------------

// 1. `is_backfill` exists on the row.
type _HasIsBackfill = Expect<
  Equal<keyof ClwRotaSyncMetricRow & "is_backfill", "is_backfill">
>;

// 2. `is_backfill` is REQUIRED (not optional) on read.
type _IsBackfillRequired = Expect<
  IsRequired<ClwRotaSyncMetricRow, "is_backfill">
>;

// 3. `is_backfill` is strictly `boolean` — not `boolean | null`, not `unknown`.
type _IsBackfillIsBoolean = Expect<
  Equal<ClwRotaSyncMetricRow["is_backfill"], boolean>
>;

// 4. The list-metrics response carries rows of the same shape, so every UI
//    consumer that reads `response.rows[n]` sees the same required field.
type _ResponseRowMatches = Expect<
  Equal<ListClwRotaSyncMetricsResponse["rows"][number], ClwRotaSyncMetricRow>
>;

// 5. The shared classifier accepts a full row (and therefore enforces that
//    callers pass something containing the required `is_backfill` field).
//    Removing `is_backfill` from the row must produce a compile error.
type _ClassifierAcceptsRow = Expect<
  Equal<Parameters<typeof isBackfillMetricRow>[0], ClwRotaSyncMetricRow>
>;

// 6. A row literal missing `is_backfill` must NOT be assignable.
//    `@ts-expect-error` itself fails the build if the error disappears.
const _missingIsBackfill = (): ClwRotaSyncMetricRow => ({
  // @ts-expect-error is_backfill is required on ClwRotaSyncMetricRow
  id: "x",
  sync_kind: "rota",
  run_at: new Date().toISOString(),
  ok: true,
  duration_ms: 0,
  rows_pulled: 0,
  rows_drafted: 0,
  rows_upserted: 0,
  rows_failed: 0,
  rows_skipped_validation: 0,
  chunks_total: 0,
  chunks_succeeded_first_try: 0,
  chunks_succeeded_after_retry: 0,
  chunks_fell_back_to_per_row: 0,
  per_row_attempts: 0,
  per_row_succeeded: 0,
  per_row_failed: 0,
  upsert_attempts_total: 0,
  upsert_retries_total: 0,
  errors_count: 0,
  notes: null,
});

// Reference the helpers so unused-locals lint rules don't strip them.
export type __ClwRotaMetricsTypeTests = [
  _HasIsBackfill,
  _IsBackfillRequired,
  _IsBackfillIsBoolean,
  _ResponseRowMatches,
  _ClassifierAcceptsRow,
  ReturnType<typeof _missingIsBackfill>,
];
