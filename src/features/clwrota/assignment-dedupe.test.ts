import { describe, expect, it } from "vitest";
import { dedupeAssignmentsBySyncKeys } from "./assignment-dedupe";

const assignment = (overrides: Partial<Parameters<typeof dedupeAssignmentsBySyncKeys>[0][number]>) => ({
  staff_id: "staff-1",
  session_date: "2026-01-10",
  session: "am",
  duty_type: "spa",
  clwrota_external_id: "ext-1",
  notes: null,
  theatre_session_key: null,
  extra_type: null,
  is_non_sag: false,
  ...overrides,
});

describe("dedupeAssignmentsBySyncKeys", () => {
  it("keeps the latest row for a repeated CLWRota external id", () => {
    const result = dedupeAssignmentsBySyncKeys([
      assignment({ clwrota_external_id: "same", duty_type: "spa" }),
      assignment({ clwrota_external_id: "same", duty_type: "admin", notes: "updated" }),
    ]);

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].duty_type).toBe("admin");
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toBe("duplicate_external_id");
  });

  it("collapses double-booked staff/session rows before database upsert", () => {
    const result = dedupeAssignmentsBySyncKeys([
      assignment({ clwrota_external_id: "generic-spa", duty_type: "spa" }),
      assignment({
        clwrota_external_id: "tutorial-row",
        duty_type: "teaching",
        notes: "Tutorial: airway management",
      }),
    ]);

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].clwrota_external_id).toBe("tutorial-row");
    expect(result.assignments[0].duty_type).toBe("teaching");
    expect(result.dropped.map((row) => row.reason)).toContain("duplicate_staff_session");
  });

  it("keeps theatre work ahead of a generic non-patient-facing duplicate", () => {
    const result = dedupeAssignmentsBySyncKeys([
      assignment({ clwrota_external_id: "generic-spa", duty_type: "spa" }),
      assignment({
        clwrota_external_id: "theatre-row",
        duty_type: "theatre",
        theatre_session_key: "2026-01-10|theatre-1|am",
      }),
    ]);

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].clwrota_external_id).toBe("theatre-row");
  });
});