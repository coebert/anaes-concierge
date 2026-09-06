import { describe, expect, it } from "vitest";
import { tallyPaByConsultant } from "./pa-by-consultant";
import type { IcuPaRules, IcuRow } from "./icu-workload";

const RULES: IcuPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

const row = (over: Partial<IcuRow> = {}): IcuRow => ({
  staff_id: "a",
  session_date: "2026-06-01", // Monday
  session: "am",
  duty_type: "icu_trainee",
  extra_type: null,
  pa_credit: null,
  attending_consultant_ids: null,
  ...over,
});

describe("tallyPaByConsultant", () => {
  it("sums recorded CLWRota PAs directly", () => {
    const [t] = tallyPaByConsultant(
      [row({ pa_credit: 1 }), row({ session: "pm", pa_credit: 1.5 })],
      RULES,
    );
    expect(t.recordedPas).toBe(2.5);
    expect(t.estimatedPas).toBe(0);
    expect(t.gapSessions).toBe(0);
    expect(t.totalPas).toBe(2.5);
  });

  it("flags sessions without a recorded PA as evidence gaps and estimates them", () => {
    const [t] = tallyPaByConsultant(
      [row({ pa_credit: 1 }), row({ session_date: "2026-06-02" })],
      RULES,
    );
    expect(t.recordedPas).toBe(1);
    expect(t.gapSessions).toBe(1);
    expect(t.gapDates).toEqual(["2026-06-02"]);
    expect(t.estimatedPas).toBe(1);
  });

  it("dedupes on-call halves when estimating gap rows", () => {
    const [t] = tallyPaByConsultant(
      [row({ session: "eve" }), row({ session: "night" })],
      RULES,
    );
    expect(t.gapSessions).toBe(2);
    expect(t.estimatedPas).toBe(1.5); // one on-call, not two
  });

  it("weekend gap day is worth the weekend credit only, not session + weekend", () => {
    // 2026-06-07 is a Sunday.
    const [t] = tallyPaByConsultant(
      [row({ session_date: "2026-06-07", session: "night" })],
      RULES,
    );
    expect(t.estimatedPas).toBe(3);
  });

  it("credits every attending consultant, not just the rostered person", () => {
    const out = tallyPaByConsultant(
      [row({ pa_credit: 2, attending_consultant_ids: ["a", "b"] })],
      RULES,
    );
    expect(out).toHaveLength(2);
    expect(out.find((t) => t.staffId === "a")?.recordedPas).toBe(2);
    expect(out.find((t) => t.staffId === "b")?.recordedPas).toBe(2);
  });

  it("ignores non-ICU duty types and sorts by total PAs descending", () => {
    const out = tallyPaByConsultant(
      [
        row({ duty_type: "theatre" }),
        row({ staff_id: "a", pa_credit: 1 }),
        row({ staff_id: "b", pa_credit: 4 }),
      ],
      RULES,
    );
    expect(out.map((t) => t.staffId)).toEqual(["b", "a"]);
  });
});
