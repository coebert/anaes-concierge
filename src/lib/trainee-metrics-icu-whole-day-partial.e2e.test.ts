import { describe, it, expect } from "vitest";
import {
  computeTraineeMetrics,
  type MetricAssignment,
} from "./trainee-metrics";

/**
 * End-to-end regression: when CLWRota syncs only a subset of the half-day
 * rows for a single ICU whole-day shift (AM only, PM only, AM+evening,
 * PM+evening, evening only, etc.), the trainee metrics must still report
 * exactly one ICU shift per date. Partial presence is the common real-world
 * case — sync drops, mid-day edits, or rota corrections frequently leave a
 * date with only one or two of its three sessions wired up.
 *
 * If any of these collapse incorrectly, ICU shift counts will silently
 * inflate or deflate on dashboards, so each partial combination is asserted
 * independently rather than via a parametric loop.
 */
describe("trainee-metrics — ICU whole-day partial-presence regression (e2e)", () => {
  const ASOF = new Date("2026-06-30").getTime();
  const WINDOW_START = "2026-02-01";

  const icu = (
    session: "am" | "pm" | "eve",
    session_date: string,
    duty: "icu_ct2_plus" | "icu_trainee" = "icu_ct2_plus",
  ): MetricAssignment => ({
    role_on_list: "solo",
    session,
    duty_type: duty,
    theatre_session_id: null,
    session_date,
  });

  it("AM only on a date counts as one ICU shift", () => {
    const m = computeTraineeMetrics(
      [icu("am", "2026-06-15")],
      WINDOW_START, new Map(), new Map(), ASOF, null, false,
    );
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("PM only on a date counts as one ICU shift", () => {
    const m = computeTraineeMetrics(
      [icu("pm", "2026-06-15")],
      WINDOW_START, new Map(), new Map(), ASOF, null, false,
    );
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("evening only on a date counts as one ICU shift", () => {
    const m = computeTraineeMetrics(
      [icu("eve", "2026-06-15")],
      WINDOW_START, new Map(), new Map(), ASOF, null, false,
    );
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("AM + evening (no PM) collapses to one ICU shift", () => {
    const m = computeTraineeMetrics(
      [icu("am", "2026-06-15"), icu("eve", "2026-06-15")],
      WINDOW_START, new Map(), new Map(), ASOF, null, false,
    );
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
    expect(m.totalAssignments).toBe(2);
  });

  it("PM + evening (no AM) collapses to one ICU shift", () => {
    const m = computeTraineeMetrics(
      [icu("pm", "2026-06-15"), icu("eve", "2026-06-15")],
      WINDOW_START, new Map(), new Map(), ASOF, null, false,
    );
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("AM + PM (no evening) collapses to one ICU shift", () => {
    const m = computeTraineeMetrics(
      [icu("am", "2026-06-15"), icu("pm", "2026-06-15")],
      WINDOW_START, new Map(), new Map(), ASOF, null, false,
    );
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("mixed partial coverage across multiple dates counts one shift per date", () => {
    // Date A: AM only. Date B: PM + eve. Date C: full AM+PM+eve. Date D: eve only.
    const a: MetricAssignment[] = [
      icu("am", "2026-06-10"),
      icu("pm", "2026-06-11"), icu("eve", "2026-06-11"),
      icu("am", "2026-06-12"), icu("pm", "2026-06-12"), icu("eve", "2026-06-12"),
      icu("eve", "2026-06-13"),
    ];
    const m = computeTraineeMetrics(a, WINDOW_START, new Map(), new Map(), ASOF, null, false);
    expect(m.icuLists).toBe(4);
    expect(m.onCallLists).toBe(4);
    expect(m.totalAssignments).toBe(7);
  });

  it("partial presence with mixed icu duty_types on the same date still collapses", () => {
    // CLWRota occasionally maps AM as icu_trainee and PM as icu_ct2_plus on
    // the same shift when a trainee crosses a grade boundary mid-day.
    const a: MetricAssignment[] = [
      icu("am", "2026-06-15", "icu_trainee"),
      icu("pm", "2026-06-15", "icu_ct2_plus"),
    ];
    const m = computeTraineeMetrics(a, WINDOW_START, new Map(), new Map(), ASOF, null, false);
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("a partial ICU date alongside a non-ICU on-call keeps them separate", () => {
    const a: MetricAssignment[] = [
      icu("am", "2026-06-15"), // partial ICU day → 1 ICU shift
      { role_on_list: "solo", session: "eve", duty_type: "registrar_oncall",
        theatre_session_id: null, session_date: "2026-06-16" },
    ];
    const m = computeTraineeMetrics(a, WINDOW_START, new Map(), new Map(), ASOF, null, false);
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(2); // 1 ICU + 1 registrar on-call
  });
});
