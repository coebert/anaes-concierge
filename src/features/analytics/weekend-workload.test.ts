import { describe, it, expect } from "vitest";
import {
  countWeekendDates,
  isExcludedSagRow,
  isWeekendISO,
  type WeekendWorkloadRow,
} from "./weekend-workload";

function row(overrides: Partial<WeekendWorkloadRow>): WeekendWorkloadRow {
  return {
    staff_id: "s1",
    session_date: "2025-06-07", // Saturday
    is_non_sag: false,
    extra_type: null,
    theatre_sessions: { is_non_sag: false, theatres: { kind: "nhs" } },
    ...overrides,
  };
}

describe("weekend-workload", () => {
  it("isWeekendISO flags Sat/Sun only", () => {
    expect(isWeekendISO("2025-06-07")).toBe(true); // Sat
    expect(isWeekendISO("2025-06-08")).toBe(true); // Sun
    expect(isWeekendISO("2025-06-09")).toBe(false); // Mon
    expect(isWeekendISO("2025-06-06")).toBe(false); // Fri
  });

  it("counts distinct Sat/Sun dates and splits Sat vs Sun", () => {
    const rows = [
      row({ session_date: "2025-06-07" }), // Sat
      row({ session_date: "2025-06-08" }), // Sun
      row({ session_date: "2025-06-14" }), // Sat
    ];
    const [r] = countWeekendDates(rows);
    expect(r.total).toBe(3);
    expect(r.sat).toBe(2);
    expect(r.sun).toBe(1);
  });

  it("de-duplicates multiple sessions on the same weekend date", () => {
    const rows = [
      row({ session_date: "2025-06-07" }),
      row({ session_date: "2025-06-07" }), // same date, another session
      row({ session_date: "2025-06-07" }),
    ];
    const [r] = countWeekendDates(rows);
    expect(r.total).toBe(1);
    expect(r.sat).toBe(1);
    expect(r.sun).toBe(0);
  });

  it("ignores weekday sessions", () => {
    const rows = [
      row({ session_date: "2025-06-09" }), // Mon
      row({ session_date: "2025-06-10" }), // Tue
    ];
    expect(countWeekendDates(rows)).toEqual([]);
  });

  it("excludes rows tagged as extras / locum / WLI via extra_type", () => {
    const rows = [
      row({ session_date: "2025-06-07", extra_type: "extra" }),
      row({ session_date: "2025-06-08", extra_type: "locum" }),
      row({ session_date: "2025-06-14", extra_type: "wli" }),
      row({ session_date: "2025-06-15", extra_type: "sag" }),
    ];
    expect(countWeekendDates(rows)).toEqual([]);
  });

  it("excludes SAG (private) lists but keeps non-SAG NHH cover", () => {
    // Private + not flagged non_sag => SAG => excluded.
    const sagRow = row({
      session_date: "2025-06-07",
      is_non_sag: false,
      theatre_sessions: { is_non_sag: false, theatres: { kind: "private" } },
    });
    expect(isExcludedSagRow(sagRow)).toBe(true);

    // Private but flagged non_sag on the row => non-SAG cover => kept.
    const nonSagRowFlag = row({
      session_date: "2025-06-08",
      is_non_sag: true,
      theatre_sessions: { is_non_sag: false, theatres: { kind: "private" } },
    });
    expect(isExcludedSagRow(nonSagRowFlag)).toBe(false);

    // Private but flagged non_sag on the theatre_session => kept.
    const nonSagRowSession = row({
      session_date: "2025-06-14",
      is_non_sag: false,
      theatre_sessions: { is_non_sag: true, theatres: { kind: "private" } },
    });
    expect(isExcludedSagRow(nonSagRowSession)).toBe(false);

    // NHS list => never SAG-excluded.
    const nhsRow = row({
      session_date: "2025-06-15",
      theatre_sessions: { is_non_sag: false, theatres: { kind: "nhs" } },
    });
    expect(isExcludedSagRow(nhsRow)).toBe(false);

    const counts = countWeekendDates([
      sagRow,
      nonSagRowFlag,
      nonSagRowSession,
      nhsRow,
    ]);
    // Only the three non-excluded weekend dates count.
    expect(counts[0].total).toBe(3);
  });

  it("groups per staff and skips rows missing staff_id or session_date", () => {
    const rows = [
      row({ staff_id: "a", session_date: "2025-06-07" }),
      row({ staff_id: "a", session_date: "2025-06-08" }),
      row({ staff_id: "b", session_date: "2025-06-07" }),
      row({ staff_id: null, session_date: "2025-06-07" }),
      row({ staff_id: "c", session_date: null }),
    ];
    const counts = countWeekendDates(rows);
    const byId = Object.fromEntries(counts.map((c) => [c.staff_id, c.total]));
    expect(byId).toEqual({ a: 2, b: 1 });
    // Sorted by total desc.
    expect(counts[0].staff_id).toBe("a");
  });

  it("combines all exclusion rules together", () => {
    const rows = [
      // Kept: NHS weekend session.
      row({ staff_id: "a", session_date: "2025-06-07" }),
      // Dropped: extras.
      row({ staff_id: "a", session_date: "2025-06-08", extra_type: "extra" }),
      // Dropped: SAG (private, not non-sag).
      row({
        staff_id: "a",
        session_date: "2025-06-14",
        theatre_sessions: {
          is_non_sag: false,
          theatres: { kind: "private" },
        },
      }),
      // Dropped: weekday.
      row({ staff_id: "a", session_date: "2025-06-09" }),
      // Kept: non-SAG private cover.
      row({
        staff_id: "a",
        session_date: "2025-06-15",
        is_non_sag: true,
        theatre_sessions: {
          is_non_sag: false,
          theatres: { kind: "private" },
        },
      }),
    ];
    const [r] = countWeekendDates(rows);
    expect(r.total).toBe(2);
    expect(r.sat).toBe(1); // 2025-06-07
    expect(r.sun).toBe(1); // 2025-06-15
  });
});
