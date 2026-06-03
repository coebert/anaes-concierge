/**
 * Verifies the client-side runtime validator catches a bad `is_backfill`
 * even when the server handler returns the payload unvalidated.
 *
 * Scenario: simulate a server fn that bypassed its own Zod parse (e.g.
 * because of a stale deploy or a future refactor that drops the call) and
 * confirm `parseListClwRotaSyncMetricsResponse` — the second checkpoint at
 * the client boundary — still rejects the response.
 */
import { describe, it, expect } from "vitest";
import { parseListClwRotaSyncMetricsResponse } from "./clwrota-metrics-types";

const baseRow = {
  id: "row-1",
  sync_kind: "rota",
  run_at: new Date("2026-06-01T08:00:00Z").toISOString(),
  ok: true,
  duration_ms: 1234,
  rows_pulled: 10,
  rows_drafted: 10,
  rows_upserted: 10,
  rows_failed: 0,
  rows_skipped_validation: 0,
  chunks_total: 1,
  chunks_succeeded_first_try: 1,
  chunks_succeeded_after_retry: 0,
  chunks_fell_back_to_per_row: 0,
  per_row_attempts: 0,
  per_row_succeeded: 0,
  per_row_failed: 0,
  upsert_attempts_total: 1,
  upsert_retries_total: 0,
  errors_count: 0,
  notes: null,
};

/** Simulates an unvalidated server handler that just hands its DB rows
 *  back to the client without going through the shared parser. */
async function simulatedUnvalidatedServerFn(payload: unknown): Promise<unknown> {
  return payload;
}

describe("parseListClwRotaSyncMetricsResponse — client-side safety net", () => {
  it("accepts a well-formed response with a boolean is_backfill", async () => {
    const raw = await simulatedUnvalidatedServerFn({
      rows: [{ ...baseRow, is_backfill: true }],
      days: 30,
      sync_kind: "all",
    });
    const parsed = parseListClwRotaSyncMetricsResponse(raw);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].is_backfill).toBe(true);
  });

  it("rejects when is_backfill is a string instead of a boolean", async () => {
    const raw = await simulatedUnvalidatedServerFn({
      rows: [{ ...baseRow, is_backfill: "yes" }],
      days: 30,
      sync_kind: "all",
    });
    expect(() => parseListClwRotaSyncMetricsResponse(raw)).toThrow(
      /rows\.0\.is_backfill/,
    );
  });

  it("rejects when is_backfill is null", async () => {
    const raw = await simulatedUnvalidatedServerFn({
      rows: [{ ...baseRow, is_backfill: null }],
      days: 30,
      sync_kind: "all",
    });
    expect(() => parseListClwRotaSyncMetricsResponse(raw)).toThrow(
      /rows\.0\.is_backfill/,
    );
  });

  it("rejects when is_backfill is missing entirely", async () => {
    const raw = await simulatedUnvalidatedServerFn({
      rows: [baseRow],
      days: 30,
      sync_kind: "all",
    });
    expect(() => parseListClwRotaSyncMetricsResponse(raw)).toThrow(
      /rows\.0\.is_backfill/,
    );
  });

  it("rejects when only one row in a batch has a bad is_backfill", async () => {
    const raw = await simulatedUnvalidatedServerFn({
      rows: [
        { ...baseRow, id: "row-a", is_backfill: false },
        { ...baseRow, id: "row-b", is_backfill: 1 },
        { ...baseRow, id: "row-c", is_backfill: true },
      ],
      days: 30,
      sync_kind: "all",
    });
    expect(() => parseListClwRotaSyncMetricsResponse(raw)).toThrow(
      /rows\.1\.is_backfill/,
    );
  });
});
