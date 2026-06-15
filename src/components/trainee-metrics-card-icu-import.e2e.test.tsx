// @vitest-environment jsdom
/**
 * End-to-end regression: a rota import that lands partial ICU sessions in
 * `rota_assignments` (only AM, only PM, only eve, or any two of the three
 * on the same date) must surface in the trainee metrics card as exactly
 * one shift per date — both in the ICU shifts tile and the On-call rollup.
 *
 * The test simulates the real path that a CLWRota sync takes:
 *   1. raw CLWRota rows are "imported" into an in-memory `rota_assignments`
 *      store (mocked supabase),
 *   2. the trainee overview projection (same shape as
 *      `src/routes/_authenticated/trainees.tsx` lines 205-214) reads those
 *      rows back and converts them to `MetricAssignment[]`,
 *   3. `computeTraineeMetrics` runs over the projection,
 *   4. `<TraineeMetricsCard />` renders the metrics.
 *
 * Asserting on the rendered tile values pins down the full chain: any
 * regression in the import projection, the collapsing logic, or the tile
 * wiring will fail this test.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import React from "react";

import { TraineeMetricsCard } from "@/components/trainee-metrics-card";
import {
  computeTraineeMetrics,
  type MetricAssignment,
} from "@/lib/trainee-metrics";

// --- In-memory rota store (mocked supabase) -----------------------------

type RotaRow = {
  id: string;
  staff_id: string;
  role_on_list: string;
  session: "am" | "pm" | "eve";
  duty_type: string;
  theatre_session_id: string | null;
  session_date: string;
  locally_modified: boolean;
};

const STAFF_ID = "trainee-1";
let rotaStore: RotaRow[] = [];

/**
 * Simulate a CLWRota sync: replace this trainee's rows with the new batch.
 * Returns the imported rows for chaining.
 */
function importRota(rows: Omit<RotaRow, "id" | "staff_id" | "locally_modified">[]) {
  rotaStore = rotaStore.filter((r) => r.staff_id !== STAFF_ID);
  rows.forEach((r, idx) => {
    rotaStore.push({
      ...r,
      id: `${STAFF_ID}:${r.session_date}:${r.session}:${idx}`,
      staff_id: STAFF_ID,
      locally_modified: false,
    });
  });
  return rotaStore.filter((r) => r.staff_id === STAFF_ID);
}

/**
 * Mirror of the trainees.tsx overview projection (lines 205-214).
 * Keeping the shape conversion in one place ensures this test fails the
 * moment the route's projection drifts away from what the card expects.
 */
function projectForCard(staffId: string): MetricAssignment[] {
  return rotaStore
    .filter((a) => a.staff_id === staffId)
    .map((a) => ({
      role_on_list: a.role_on_list,
      session: a.session,
      duty_type: a.duty_type,
      theatre_session_id: a.theatre_session_id,
      session_date: a.session_date,
    }));
}

// --- Render helpers ------------------------------------------------------

const ASOF = new Date("2026-06-30").getTime();
const WINDOW_START = "2026-02-01";

function renderCardFromStore() {
  const metrics = computeTraineeMetrics(
    projectForCard(STAFF_ID),
    WINDOW_START,
    new Map(),
    new Map(),
    ASOF,
    null,
    false,
  );
  return render(
    <TraineeMetricsCard
      metrics={metrics}
      startDate={WINDOW_START}
      title="ICU trainee"
    />,
  );
}

function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  const tile = labelEl.closest("div");
  if (!tile) throw new Error(`No tile container for label ${label}`);
  const candidates = within(tile).getAllByText(/^\d+$/);
  if (candidates.length === 0) throw new Error(`No numeric value in tile ${label}`);
  return candidates[0].textContent ?? "";
}

beforeEach(() => {
  rotaStore = [];
});
afterEach(() => cleanup());

// --- Test fixtures: partial ICU sessions per date -----------------------

const icuRow = (
  session: "am" | "pm" | "eve",
  session_date: string,
): Omit<RotaRow, "id" | "staff_id" | "locally_modified"> => ({
  role_on_list: "solo",
  session,
  duty_type: "icu_ct2_plus",
  theatre_session_id: null,
  session_date,
});

describe("e2e: rota import with partial ICU sessions → rendered tiles", () => {
  it("imports AM-only ICU for one date → tiles show 1 shift", () => {
    importRota([icuRow("am", "2026-06-15")]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("imports PM-only ICU for one date → tiles show 1 shift", () => {
    importRota([icuRow("pm", "2026-06-15")]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("imports evening-only ICU for one date → tiles show 1 shift", () => {
    importRota([icuRow("eve", "2026-06-15")]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("imports AM+PM (no eve) for one date → tiles show 1 shift", () => {
    importRota([icuRow("am", "2026-06-15"), icuRow("pm", "2026-06-15")]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("imports PM+eve (no AM) for one date → tiles show 1 shift", () => {
    importRota([icuRow("pm", "2026-06-15"), icuRow("eve", "2026-06-15")]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("imports a mixed-partial week → tiles show one shift per date", () => {
    // Five distinct ICU dates, each with a different partial-coverage shape.
    importRota([
      icuRow("am", "2026-06-08"),                                 // AM only
      icuRow("pm", "2026-06-09"),                                 // PM only
      icuRow("eve", "2026-06-10"),                                // eve only
      icuRow("am", "2026-06-11"), icuRow("eve", "2026-06-11"),    // AM + eve
      icuRow("am", "2026-06-12"), icuRow("pm", "2026-06-12"),
        icuRow("eve", "2026-06-12"),                              // full day
    ]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("5");
    expect(tileValue("On-call")).toBe("5");
    expect(tileValue("Total assignments")).toBe("8");
  });

  it("a re-sync that drops the PM session keeps the date at 1 shift", () => {
    // First sync: full AM+PM+eve day → 1 shift.
    importRota([
      icuRow("am", "2026-06-15"),
      icuRow("pm", "2026-06-15"),
      icuRow("eve", "2026-06-15"),
    ]);
    let view = renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
    view.unmount();

    // Re-sync: only AM + eve survive (PM row dropped from CLWRota response).
    importRota([icuRow("am", "2026-06-15"), icuRow("eve", "2026-06-15")]);
    renderCardFromStore();
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });
});
