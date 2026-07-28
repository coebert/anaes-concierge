import { describe, it, expect } from "vitest";
import {
  filterAssignmentsForCell,
  type CalendarSpaAdminAssignment,
} from "./me-cell-visibility";

/**
 * AM/PM visibility contract for SPA and Admin rows on the global calendar.
 *
 * Same last-line guard as Medical Examiner: a session persisted for one
 * half-day must never render in the other. These tests lock the SPA and
 * Admin behaviour independently so a future regression on either row is
 * caught in isolation.
 */
const day = "2026-05-26";
const other = "2026-05-27";

const mk = (
  duty: CalendarSpaAdminAssignment["duty_type"],
  session: "am" | "pm",
  date: string = day,
): CalendarSpaAdminAssignment & { id: string } => ({
  id: `${duty}-${date}-${session}`,
  duty_type: duty,
  session_date: date,
  session,
});

describe.each(["spa", "admin"] as const)(
  "%s AM/PM cell visibility",
  (duty) => {
    it("renders an AM session only in the AM cell", () => {
      const rows = [mk(duty, "am")];
      expect(filterAssignmentsForCell(rows, duty, day, "am")).toHaveLength(1);
      expect(filterAssignmentsForCell(rows, duty, day, "pm")).toHaveLength(0);
    });

    it("renders a PM session only in the PM cell", () => {
      const rows = [mk(duty, "pm")];
      expect(filterAssignmentsForCell(rows, duty, day, "pm")).toHaveLength(1);
      expect(filterAssignmentsForCell(rows, duty, day, "am")).toHaveLength(0);
    });

    it("renders a split all-day pair in both cells without doubling up", () => {
      const rows = [mk(duty, "am"), mk(duty, "pm")];
      expect(filterAssignmentsForCell(rows, duty, day, "am")).toEqual([rows[0]]);
      expect(filterAssignmentsForCell(rows, duty, day, "pm")).toEqual([rows[1]]);
    });

    it("does not bleed onto a neighbouring day", () => {
      const rows = [mk(duty, "am"), mk(duty, "pm")];
      expect(filterAssignmentsForCell(rows, duty, other, "am")).toHaveLength(0);
      expect(filterAssignmentsForCell(rows, duty, other, "pm")).toHaveLength(0);
    });
  },
);

describe("SPA vs Admin cross-leak protection", () => {
  it("keeps SPA rows out of Admin cells for the same day/half", () => {
    const rows = [mk("spa", "am"), mk("spa", "pm")];
    expect(filterAssignmentsForCell(rows, "admin", day, "am")).toHaveLength(0);
    expect(filterAssignmentsForCell(rows, "admin", day, "pm")).toHaveLength(0);
  });

  it("keeps Admin rows out of SPA cells for the same day/half", () => {
    const rows = [mk("admin", "am"), mk("admin", "pm")];
    expect(filterAssignmentsForCell(rows, "spa", day, "am")).toHaveLength(0);
    expect(filterAssignmentsForCell(rows, "spa", day, "pm")).toHaveLength(0);
  });

  it("keeps Medical examiner rows out of SPA and Admin cells", () => {
    const rows = [mk("medical_examiner", "am"), mk("medical_examiner", "pm")];
    expect(filterAssignmentsForCell(rows, "spa", day, "am")).toHaveLength(0);
    expect(filterAssignmentsForCell(rows, "admin", day, "pm")).toHaveLength(0);
  });

  it("filters a mixed bag down to exactly the requested (duty, day, half)", () => {
    const rows = [
      mk("spa", "am"),
      mk("spa", "pm"),
      mk("admin", "am"),
      mk("admin", "pm"),
      mk("medical_examiner", "am"),
      mk("spa", "am", other),
    ];
    const spaAm = filterAssignmentsForCell(rows, "spa", day, "am");
    expect(spaAm).toHaveLength(1);
    expect(spaAm[0].id).toBe(`spa-${day}-am`);

    const adminPm = filterAssignmentsForCell(rows, "admin", day, "pm");
    expect(adminPm).toHaveLength(1);
    expect(adminPm[0].id).toBe(`admin-${day}-pm`);
  });
});
