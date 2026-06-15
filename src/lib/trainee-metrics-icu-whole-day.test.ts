import { describe, it, expect } from "vitest";
import {
  computeTraineeMetrics,
  type MetricAssignment,
} from "./trainee-metrics";

/**
 * Whole-day ICU shifts (AM + PM, sometimes + evening on the same date)
 * must count as ONE ICU shift, not three. CLWRota seeds one row per
 * half-day session, so the raw row count triples the real ICU load.
 */
describe("trainee-metrics — ICU whole-day shift collapsing", () => {
  it("AM + PM ICU rows on the same date count as one ICU shift", () => {
    const a: MetricAssignment[] = [
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "pm", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-15" },
    ];
    const m = computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, false);
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1); // ICU rolls into on-call counts
    expect(m.totalAssignments).toBe(2);
  });

  it("AM + PM + evening ICU rows on the same date still count as one shift", () => {
    const a: MetricAssignment[] = [
      { role_on_list: "solo", session: "am", duty_type: "icu_trainee",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "pm", duty_type: "icu_trainee",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "eve", duty_type: "icu_trainee",
        theatre_session_id: null, session_date: "2026-06-15" },
    ];
    const m = computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, false);
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(1);
  });

  it("ICU shifts on different dates count separately", () => {
    const a: MetricAssignment[] = [
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "pm", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-16" },
      { role_on_list: "solo", session: "pm", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-16" },
    ];
    const m = computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, false);
    expect(m.icuLists).toBe(2);
    expect(m.onCallLists).toBe(2);
  });

  it("ICU rows mixed with other on-call duties: ICU collapses, other on-calls stay per-session", () => {
    const a: MetricAssignment[] = [
      // Whole-day ICU shift → 1 ICU shift.
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "pm", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: "2026-06-15" },
      // Two separate evening on-calls → 2 on-call sessions (no collapsing).
      { role_on_list: "solo", session: "eve", duty_type: "registrar_oncall",
        theatre_session_id: null, session_date: "2026-06-16" },
      { role_on_list: "solo", session: "eve", duty_type: "registrar_oncall",
        theatre_session_id: null, session_date: "2026-06-17" },
    ];
    const m = computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, false);
    expect(m.icuLists).toBe(1);
    expect(m.onCallLists).toBe(3); // 1 ICU shift + 2 registrar on-calls
  });

  it("ICU rows with missing session_date are not silently merged", () => {
    // Defensive: a row without a session_date is rare but possible. Each
    // such row counts as its own shift rather than collapsing them all.
    const a: MetricAssignment[] = [
      { role_on_list: "solo", session: "am", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: null },
      { role_on_list: "solo", session: "pm", duty_type: "icu_ct2_plus",
        theatre_session_id: null, session_date: null },
    ];
    const m = computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, false);
    expect(m.icuLists).toBe(2);
  });

  it("obstetrics rows are NOT collapsed (only ICU is in scope of this change)", () => {
    const a: MetricAssignment[] = [
      { role_on_list: "solo", session: "am", duty_type: "obstetrics",
        theatre_session_id: null, session_date: "2026-06-15" },
      { role_on_list: "solo", session: "pm", duty_type: "obstetrics",
        theatre_session_id: null, session_date: "2026-06-15" },
    ];
    const m = computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, false);
    expect(m.obstetricsLists).toBe(2);
  });
});
