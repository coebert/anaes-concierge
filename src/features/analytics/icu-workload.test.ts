import { describe, it, expect } from "vitest";
import {
  tallyIcuWorkload,
  isWeekendISO,
  isExtraRow,
  type IcuRow,
  type IcuPaRules,
} from "./icu-workload";

const RULES: IcuPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

function row(p: Partial<IcuRow>): IcuRow {
  return {
    staff_id: "s1",
    session_date: "2026-06-01", // Monday
    session: "am",
    duty_type: "icu_consultant_oncall",
    extra_type: null,
    ...p,
  };
}

describe("icu-workload", () => {
  it("collapses AM + PM on the same day into one ICU day but two sessions", () => {
    const [t] = tallyIcuWorkload(
      [row({ session: "am" }), row({ session: "pm" })],
      RULES,
    );
    expect(t.days).toBe(1);
    expect(t.sessions).toBe(2);
    expect(t.amSessions).toBe(1);
    expect(t.pmSessions).toBe(1);
    expect(t.plannedPas).toBe(2);
  });

  it("collapses evening + night on the same date into one on-call", () => {
    const [t] = tallyIcuWorkload(
      [row({ session: "eve" }), row({ session: "night" })],
      RULES,
    );
    expect(t.onCalls).toBe(1);
    expect(t.days).toBe(0);
    expect(t.plannedPas).toBe(1.5);
  });

  it("counts weekend ICU days separately and credits them", () => {
    // 2026-06-06 is a Saturday, 2026-06-07 a Sunday.
    expect(isWeekendISO("2026-06-06")).toBe(true);
    expect(isWeekendISO("2026-06-08")).toBe(false);
    const [t] = tallyIcuWorkload(
      [
        row({ session_date: "2026-06-06", session: "am" }),
        row({ session_date: "2026-06-07", session: "night" }),
      ],
      RULES,
    );
    expect(t.weekendDays).toBe(2);
    // Weekend credit REPLACES the session/on-call credit: each weekend day
    // is worth weekend_pa_credit (3), not session/on-call + weekend.
    expect(t.plannedPas).toBe(6);
  });

  it("weekend on-call is worth the weekend credit only, not on-call + weekend", () => {
    // Sunday on-call: 3 PAs, not 1.5 + 3.
    const [t] = tallyIcuWorkload(
      [row({ session_date: "2026-06-07", session: "night" })],
      RULES,
    );
    expect(t.onCalls).toBe(1);
    expect(t.weekendDays).toBe(1);
    expect(t.plannedPas).toBe(3);
  });

  it("keeps extra/locum/WLI/SAG work out of job-planned totals", () => {
    for (const tag of ["extra", "locum", "WLI", "SAG"]) {
      const [t] = tallyIcuWorkload(
        [row({ extra_type: tag }), row({ session: "pm" })],
        RULES,
      );
      expect(t.sessions).toBe(1);
      expect(t.extraSessions).toBe(1);
      expect(t.extraDays).toBe(1);
      expect(t.plannedPas).toBe(1);
      expect(t.extraPas).toBe(1);
      expect(t.totalPas).toBe(2);
    }
    expect(isExtraRow(row({ extra_type: "  " }))).toBe(false);
  });

  it("ignores non-ICU duty types", () => {
    expect(tallyIcuWorkload([row({ duty_type: "theatre" })], RULES)).toEqual([]);
  });

  it("applies sessions-per-PA from the rota rules", () => {
    const [t] = tallyIcuWorkload(
      [
        row({ session: "am" }),
        row({ session: "pm" }),
        row({ session_date: "2026-06-02", session: "am" }),
      ],
      { sessions_per_pa: 2, oncall_pa_credit: 1, weekend_pa_credit: 2 },
    );
    expect(t.sessions).toBe(3);
    expect(t.plannedPas).toBe(1.5);
  });

  it("sorts by total PAs descending and lists traceable dates", () => {
    const out = tallyIcuWorkload(
      [
        row({ staff_id: "a", session_date: "2026-06-02", session: "am" }),
        row({ staff_id: "b", session_date: "2026-06-03", session: "am" }),
        row({ staff_id: "b", session_date: "2026-06-04", session: "am" }),
      ],
      RULES,
    );
    expect(out.map((t) => t.staff_id)).toEqual(["b", "a"]);
    expect(out[0].dates).toEqual(["2026-06-03", "2026-06-04"]);
  });
});
