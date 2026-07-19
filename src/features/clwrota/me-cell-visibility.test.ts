import { describe, it, expect } from "vitest";
import {
  filterAssignmentsForCell,
  type CalendarSpaAdminAssignment,
} from "./me-cell-visibility";

const day = "2026-05-26";
const other = "2026-05-27";

const mk = (
  session: "am" | "pm",
  duty: CalendarSpaAdminAssignment["duty_type"] = "medical_examiner",
  date: string = day,
): CalendarSpaAdminAssignment & { id: string } => ({
  id: `${duty}-${date}-${session}`,
  duty_type: duty,
  session_date: date,
  session,
});

describe("Medical examiner AM/PM cell visibility", () => {
  it("shows an AM ME session only in the AM cell, never in the PM cell", () => {
    const rows = [mk("am")];
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "am")).toHaveLength(1);
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "pm")).toHaveLength(0);
  });

  it("shows a PM ME session only in the PM cell, never in the AM cell", () => {
    const rows = [mk("pm")];
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "pm")).toHaveLength(1);
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "am")).toHaveLength(0);
  });

  it("renders a split all-day ME row (am+pm) in both cells but never doubles up", () => {
    const rows = [mk("am"), mk("pm")];
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "am")).toEqual([rows[0]]);
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "pm")).toEqual([rows[1]]);
  });

  it("does not bleed a ME session onto a neighbouring day", () => {
    const rows = [mk("am"), mk("pm")];
    expect(filterAssignmentsForCell(rows, "medical_examiner", other, "am")).toHaveLength(0);
    expect(filterAssignmentsForCell(rows, "medical_examiner", other, "pm")).toHaveLength(0);
  });

  it("keeps ME rows out of the SPA and Admin cells for the same day/half", () => {
    const rows = [mk("am"), mk("pm")];
    expect(filterAssignmentsForCell(rows, "spa", day, "am")).toHaveLength(0);
    expect(filterAssignmentsForCell(rows, "admin", day, "pm")).toHaveLength(0);
  });

  it("keeps SPA/Admin rows out of the ME cell for the same day/half", () => {
    const rows = [mk("am", "spa"), mk("pm", "admin")];
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "am")).toHaveLength(0);
    expect(filterAssignmentsForCell(rows, "medical_examiner", day, "pm")).toHaveLength(0);
  });

  it("tolerates null/undefined assignment lists", () => {
    expect(filterAssignmentsForCell(null, "medical_examiner", day, "am")).toEqual([]);
    expect(filterAssignmentsForCell(undefined, "medical_examiner", day, "pm")).toEqual([]);
  });
});
