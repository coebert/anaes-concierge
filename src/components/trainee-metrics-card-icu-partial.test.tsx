// @vitest-environment jsdom
/**
 * UI regression: when CLWRota rows for a date are partially present
 * (AM only, PM only, eve only, AM+PM, AM+eve, PM+eve), the trainee metrics
 * card must show exactly one ICU shift per date in both the "ICU shifts"
 * tile and the "On-call" rollup. This test drives real metrics through
 * computeTraineeMetrics and asserts the rendered tile values, so any
 * regression in either the collapsing logic OR the tile wiring is caught.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import React from "react";

import { TraineeMetricsCard } from "@/components/trainee-metrics-card";
import {
  computeTraineeMetrics,
  type MetricAssignment,
} from "@/features/trainees/trainee-metrics";

const ASOF = new Date("2026-06-30").getTime();
const WINDOW_START = "2026-02-01";

const icu = (
  session: "am" | "pm" | "eve",
  session_date: string,
): MetricAssignment => ({
  role_on_list: "solo",
  session,
  duty_type: "icu_ct2_plus",
  theatre_session_id: null,
  session_date,
});

function tileValue(label: string): string {
  // Each <Metric> renders the label and value as siblings inside the same
  // grid cell. Find the label element, walk up to its tile container, then
  // pull the prominent numeric value out.
  const labelEl = screen.getByText(label);
  const tile = labelEl.closest("div");
  if (!tile) throw new Error(`No tile container for ${label}`);
  // The value is the largest text node inside the tile. Filter to the digit-only span.
  const candidates = within(tile).getAllByText(/^\d+$/);
  if (candidates.length === 0) throw new Error(`No numeric value in tile ${label}`);
  return candidates[0].textContent ?? "";
}

function renderWith(assignments: MetricAssignment[]) {
  const metrics = computeTraineeMetrics(
    assignments,
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
      title="Test trainee"
    />,
  );
}

afterEach(() => cleanup());

describe("TraineeMetricsCard — ICU partial-presence tile rendering", () => {
  it("AM only on a date → ICU tile shows 1, On-call tile shows 1", () => {
    renderWith([icu("am", "2026-06-15")]);
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("PM only on a date → ICU tile shows 1, On-call tile shows 1", () => {
    renderWith([icu("pm", "2026-06-15")]);
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("evening only on a date → ICU tile shows 1, On-call tile shows 1", () => {
    renderWith([icu("eve", "2026-06-15")]);
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("AM + evening (no PM) on a date → ICU tile shows 1, On-call tile shows 1", () => {
    renderWith([icu("am", "2026-06-15"), icu("eve", "2026-06-15")]);
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("PM + evening (no AM) on a date → ICU tile shows 1, On-call tile shows 1", () => {
    renderWith([icu("pm", "2026-06-15"), icu("eve", "2026-06-15")]);
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("AM + PM (no evening) on a date → ICU tile shows 1, On-call tile shows 1", () => {
    renderWith([icu("am", "2026-06-15"), icu("pm", "2026-06-15")]);
    expect(tileValue("ICU shifts")).toBe("1");
    expect(tileValue("On-call")).toBe("1");
  });

  it("three partial dates each render as one shift → ICU tile shows 3, On-call tile shows 3", () => {
    renderWith([
      icu("am", "2026-06-10"),
      icu("pm", "2026-06-11"),
      icu("eve", "2026-06-12"),
    ]);
    expect(tileValue("ICU shifts")).toBe("3");
    expect(tileValue("On-call")).toBe("3");
  });
});
