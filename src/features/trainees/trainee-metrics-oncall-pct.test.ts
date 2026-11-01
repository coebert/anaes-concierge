import { describe, it, expect } from "vitest";
import { computeTraineeMetrics, type MetricAssignment } from "./trainee-metrics";

const row = (session: string, duty: string, date = "2026-06-15", ts: string | null = null): MetricAssignment => ({
  role_on_list: "solo", session, duty_type: duty, theatre_session_id: ts, session_date: date,
});
const run = (a: MetricAssignment[]) =>
  computeTraineeMetrics(a, "2026-02-01", new Map(), new Map(), new Date("2026-06-20").getTime(), null, true);

describe("trainee on-call % uses one unit (sessions)", () => {
  it("all-ICU AM+PM+eve day is 100%, while ICU shift count stays 1", () => {
    const m = run([row("am", "icu_trainee"), row("pm", "icu_trainee"), row("eve", "icu_trainee")]);
    expect(m.onCallPct).toBe(100);
    expect(m.icuLists).toBe(1);
    expect(m.onCallPctBasis).toBe("sessions");
  });
  it("pure theatre is 0%", () => {
    expect(run([row("am", "theatre", "2026-06-15", "t1"), row("pm", "theatre", "2026-06-15", "t2")]).onCallPct).toBe(0);
  });
  it("no sessions is unavailable (null), not 0", () => {
    expect(run([]).onCallPct).toBeNull();
  });
  it("mixed: 2 ICU + 2 theatre sessions = 50%", () => {
    expect(run([row("am", "icu_trainee"), row("pm", "icu_trainee"), row("am", "theatre", "2026-06-16", "t1"), row("pm", "theatre", "2026-06-16", "t2")]).onCallPct).toBe(50);
  });
  it("exact duplicate rows count once", () => {
    const m = run([row("am", "icu_trainee"), row("am", "icu_trainee"), row("am", "theatre", "2026-06-16", "t1")]);
    expect(m.sessionDenominator).toBe(2);
    expect(m.onCallPct).toBe(50);
  });
});
