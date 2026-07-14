import { describe, it, expect } from "vitest";
import {
  classifyExtraCategory,
  countWeekendExtras,
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

describe("countWeekendExtras", () => {
  it("classifies extra_type variants case-insensitively", () => {
    expect(classifyExtraCategory(row({ extra_type: "Extra" }))).toBe("extra");
    expect(classifyExtraCategory(row({ extra_type: "LOCUM" }))).toBe("locum");
    expect(classifyExtraCategory(row({ extra_type: " wli " }))).toBe("wli");
    expect(classifyExtraCategory(row({ extra_type: "sag" }))).toBe("sag");
    // Unknown non-null tags fall into extras.
    expect(classifyExtraCategory(row({ extra_type: "overtime" }))).toBe("extra");
    // Job-plan row on an NHS list — not extras.
    expect(classifyExtraCategory(row({}))).toBeNull();
  });

  it("buckets private SAG lists (no extra_type) as sag", () => {
    const sagRow = row({
      theatre_sessions: { is_non_sag: false, theatres: { kind: "private" } },
    });
    expect(classifyExtraCategory(sagRow)).toBe("sag");
  });

  it("counts distinct dates per category per staff member", () => {
    const rows = [
      row({ staff_id: "a", session_date: "2025-06-07", extra_type: "extra" }),
      row({ staff_id: "a", session_date: "2025-06-07", extra_type: "extra" }), // dup date
      row({ staff_id: "a", session_date: "2025-06-08", extra_type: "locum" }),
      row({ staff_id: "a", session_date: "2025-06-14", extra_type: "wli" }),
      row({ staff_id: "a", session_date: "2025-06-15", extra_type: "sag" }),
      // Weekday — ignored.
      row({ staff_id: "a", session_date: "2025-06-09", extra_type: "extra" }),
      // Different staff.
      row({ staff_id: "b", session_date: "2025-06-07", extra_type: "locum" }),
    ];
    const counts = countWeekendExtras(rows);
    const byId = Object.fromEntries(counts.map((c) => [c.staff_id, c]));
    expect(byId.a).toEqual({ staff_id: "a", extra: 1, locum: 1, wli: 1, sag: 1 });
    expect(byId.b).toEqual({ staff_id: "b", extra: 0, locum: 1, wli: 0, sag: 0 });
  });

  it("counts private SAG lists without extra_type into the sag bucket", () => {
    const rows = [
      row({
        staff_id: "a",
        session_date: "2025-06-07",
        theatre_sessions: { is_non_sag: false, theatres: { kind: "private" } },
      }),
    ];
    expect(countWeekendExtras(rows)[0].sag).toBe(1);
  });
});
