import { describe, expect, it } from "vitest";
import { dedupeAssignmentsBySyncKeys } from "./assignment-dedupe";

const assignment = (
  overrides: Partial<Parameters<typeof dedupeAssignmentsBySyncKeys>[0][number]>,
) => ({
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

  describe("rows sharing the person|date|session fallback key", () => {
    const fallback = (o: Parameters<typeof assignment>[0]) =>
      assignment({ clwrota_external_id: "p1|2027-01-12|AM", external_id_is_fallback: true, ...o });

    it("keeps the ICU on-call over a SPA in the same half whatever the feed order", () => {
      const onCall = fallback({ duty_type: "icu_consultant_oncall", role_on_list: "on_call" });
      const spa = fallback({ duty_type: "spa", role_on_list: "admin_session" });
      for (const rows of [
        [onCall, spa],
        [spa, onCall],
      ]) {
        const r = dedupeAssignmentsBySyncKeys(rows);
        expect(r.assignments.map((a) => a.duty_type)).toEqual(["icu_consultant_oncall"]);
        expect(r.dropped[0].reason).toBe("duplicate_external_id");
        expect(r.dropped[0].kind).toBe("separate_duty");
      }
    });

    it("keeps the theatre list over an ICU on-call in the same half whatever the feed order", () => {
      const onCall = fallback({ duty_type: "icu_consultant_oncall", role_on_list: "on_call" });
      const list = fallback({
        duty_type: "theatre",
        role_on_list: "solo",
        theatre_session_key: "2027-01-12|t1|am",
      });
      for (const rows of [
        [onCall, list],
        [list, onCall],
      ]) {
        const r = dedupeAssignmentsBySyncKeys(rows);
        expect(r.assignments).toHaveLength(1);
        expect(r.assignments[0].duty_type).toBe("theatre");
        expect(r.assignments[0].theatre_session_key).toBe("2027-01-12|t1|am");
      }
    });

    it("reports a repeated identical row as an identical duty, not a separate one", () => {
      const r = dedupeAssignmentsBySyncKeys([
        fallback({ duty_type: "theatre", theatre_session_key: "k" }),
        fallback({ duty_type: "theatre", theatre_session_key: "k" }),
      ]);
      expect(r.assignments).toHaveLength(1);
      expect(r.dropped[0].kind).toBe("identical_duty");
    });

    it("still lets the latest copy win for a repeated source row id", () => {
      const r = dedupeAssignmentsBySyncKeys([
        assignment({ clwrota_external_id: "row-9", duty_type: "icu_consultant_oncall" }),
        assignment({ clwrota_external_id: "row-9", duty_type: "spa" }),
      ]);
      expect(r.assignments.map((a) => a.duty_type)).toEqual(["spa"]);
    });
  });
});
