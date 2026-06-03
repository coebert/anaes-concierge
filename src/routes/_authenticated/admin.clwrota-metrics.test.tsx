// @vitest-environment jsdom
/**
 * Integration test: when the listClwRotaSyncMetrics response is invalid
 * (e.g. is_backfill is a string instead of a boolean), the CLWRota metrics
 * dashboard must show a safe error card and MUST NOT render any data rows.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// jsdom polyfills (Radix / Recharts touch ResizeObserver on mount).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

// --- Mocks --------------------------------------------------------------

// Make `createFileRoute` an inert factory so the route module loads outside
// a router context.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: (_path: string) => (opts: Record<string, unknown>) => ({
      options: opts,
    }),
  };
});

// `useServerFn` normally binds an RPC; in the test, just return the fn
// straight through so our mocked listClwRotaSyncMetrics is the one invoked.
vi.mock("@tanstack/react-start", () => ({
  useServerFn: <T,>(fn: T) => fn,
}));

// Mock the server fn module. The handler returns a payload whose
// `is_backfill` field is a string — this MUST trip the runtime Zod
// validator at the client boundary.
const listClwRotaSyncMetricsMock = vi.fn();
vi.mock("@/lib/clwrota.functions", () => ({
  listClwRotaSyncMetrics: listClwRotaSyncMetricsMock,
}));

// Import AFTER the mocks are registered.
import { ClwRotaMetricsPage } from "./admin.clwrota-metrics";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ClwRotaMetricsPage />
    </QueryClientProvider>,
  );
}

const baseInvalidRow = {
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
  // is_backfill intentionally wrong: a string, not a boolean.
  is_backfill: "yes",
};

describe("CLWRota metrics dashboard — invalid is_backfill", () => {
  beforeEach(() => {
    listClwRotaSyncMetricsMock.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("shows the safe error card and renders no metric rows when is_backfill is not a boolean", async () => {
    listClwRotaSyncMetricsMock.mockResolvedValue({
      rows: [baseInvalidRow],
      days: 30,
      sync_kind: "all",
    });

    renderPage();

    // Safe error card appears.
    const errorCard = await waitFor(() =>
      screen.getByTestId("clwrota-metrics-error"),
    );
    expect(errorCard).toBeTruthy();
    expect(errorCard.textContent ?? "").toMatch(/Couldn't load sync metrics/i);
    // Error message mentions the offending path so an operator can debug.
    expect(errorCard.textContent ?? "").toMatch(/is_backfill/);

    // The empty-state card MUST NOT be shown — that would imply zero rows
    // were returned, masking the validation failure.
    expect(screen.queryByText(/No sync runs in the last/i)).toBeNull();

    // No table body / row data should render. The table only renders inside
    // the success branch, so the row id should never appear in the DOM.
    expect(screen.queryByText("row-1")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("also rejects a row that omits is_backfill entirely", async () => {
    const { is_backfill: _omit, ...rowWithout } = baseInvalidRow;
    listClwRotaSyncMetricsMock.mockResolvedValue({
      rows: [rowWithout],
      days: 30,
      sync_kind: "all",
    });

    renderPage();

    const errorCard = await waitFor(() =>
      screen.getByTestId("clwrota-metrics-error"),
    );
    expect(errorCard.textContent ?? "").toMatch(/is_backfill/);
    expect(screen.queryByRole("table")).toBeNull();
  });
});
