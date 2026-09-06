import { describe, expect, it } from "vitest";
import {
  areaForRow,
  summariseByArea,
  listSpecialtySessions,
  tallySpecialtyWorkload,
  type SpecialtyPaRules,
  type SpecialtyRow,
} from "./specialty-workload";

const rules: SpecialtyPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

const row = (r: Partial<SpecialtyRow>): SpecialtyRow => ({
  staff_id: "s1",
  session_date: "2026-06-01", // Monday
  session: "am",
  duty_type: "theatre",
  extra_type: null,
  ...r,
});

describe("areaForRow", () => {
  it("uses the theatre list specialty when present", () => {
    expect(areaForRow(row({ specialty_name: "Orthopaedics" }))).toBe("Orthopaedics");
  });

  it("falls back to a duty label for non-theatre work", () => {
    expect(areaForRow(row({ duty_type: "obstetrics", specialty_name: null }))).toBe("Obstetrics");
    expect(areaForRow(row({ duty_type: "icu_consultant_oncall" }))).toBe("Intensive care");
    expect(areaForRow(row({ duty_type: "medical_examiner" }))).toBe("Medical examiner");
  });
});

describe("tallySpecialtyWorkload", () => {
  it("splits a doctor's work across specialties", () => {
    const out = tallySpecialtyWorkload(
      [
        row({ specialty_name: "Orthopaedics" }),
        row({ specialty_name: "Orthopaedics", session: "pm" }),
        row({ session_date: "2026-06-02", specialty_name: "ENT" }),
      ],
      rules,
    );
    const ortho = out.find((t) => t.area === "Orthopaedics")!;
    const ent = out.find((t) => t.area === "ENT")!;
    expect(ortho.sessions).toBe(2);
    expect(ortho.days).toBe(1);
    expect(ortho.totalPas).toBe(2);
    expect(ent.sessions).toBe(1);
  });

  it("counts one on-call per date and uses on-call credit", () => {
    const out = tallySpecialtyWorkload(
      [
        row({ duty_type: "general_consultant_oncall", session: "eve", specialty_name: null }),
        row({ duty_type: "general_consultant_oncall", session: "night", specialty_name: null }),
      ],
      rules,
    );
    expect(out[0]!.onCalls).toBe(1);
    expect(out[0]!.totalPas).toBe(1.5);
  });

  it("replaces rather than stacks weekend credit on a weekend on-call", () => {
    const out = tallySpecialtyWorkload(
      [
        row({
          session_date: "2026-06-06", // Saturday
          duty_type: "general_consultant_oncall",
          session: "night",
          specialty_name: null,
        }),
      ],
      rules,
    );
    expect(out[0]!.totalPas).toBe(3);
    expect(out[0]!.weekendDays).toBe(1);
  });

  it("uses CLWRota's recorded PA value when it has one", () => {
    const out = tallySpecialtyWorkload(
      [row({ specialty_name: "Urology", pa_credit: 1.25 })],
      rules,
    );
    expect(out[0]!.clwrotaPas).toBe(1.25);
    expect(out[0]!.estimatedPas).toBe(0);
  });

  it("keeps extra / locum work out of job-planned PAs", () => {
    const out = tallySpecialtyWorkload(
      [row({ specialty_name: "General surgery", extra_type: "locum" })],
      rules,
    );
    expect(out[0]!.plannedPas).toBe(0);
    expect(out[0]!.extraPas).toBe(1);
    expect(out[0]!.extraSessions).toBe(1);
  });

  it("credits every attending consultant named on a row", () => {
    const out = tallySpecialtyWorkload(
      [row({ specialty_name: "Paediatrics", attending_consultant_ids: ["a", "b"] })],
      rules,
    );
    expect(out.map((t) => t.staff_id).sort()).toEqual(["a", "b"]);
  });
});

describe("summariseByArea", () => {
  it("rolls per-doctor tallies into one row per area", () => {
    const tallies = tallySpecialtyWorkload(
      [
        row({ specialty_name: "ENT" }),
        row({ staff_id: "s2", specialty_name: "ENT", session: "pm" }),
      ],
      rules,
    );
    const summary = summariseByArea(tallies);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.doctors).toBe(2);
    expect(summary[0]!.sessions).toBe(2);
    expect(summary[0]!.totalPas).toBe(2);
  });
});

describe("listSpecialtySessions", () => {
  it("returns one row per doctor per session half with its credited PA", () => {
    const sessions = listSpecialtySessions(
      [row({ specialty_name: "ENT", attending_consultant_ids: ["a", "b"] })],
      rules,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.creditedPa).toBe(1);
    expect(sessions[0]!.sharedWith).toEqual(["b"]);
    expect(sessions[0]!.recordedPa).toBeNull();
  });

  it("keeps CLWRota's recorded PA value", () => {
    const [s] = listSpecialtySessions([row({ specialty_name: "ENT", pa_credit: 0.75 })], rules);
    expect(s!.recordedPa).toBe(0.75);
    expect(s!.creditedPa).toBe(0.75);
  });

  it("credits an on-call only once across its halves", () => {
    const sessions = listSpecialtySessions(
      [
        row({ duty_type: "general_consultant_oncall", session: "eve", specialty_name: null }),
        row({ duty_type: "general_consultant_oncall", session: "night", specialty_name: null }),
      ],
      rules,
    );
    expect(sessions.map((s) => s.creditedPa)).toEqual([1.5, 0]);
  });

  it("credits a weekend day once, replacing session credit", () => {
    const sessions = listSpecialtySessions(
      [
        row({ session_date: "2026-06-06", specialty_name: "ENT" }),
        row({ session_date: "2026-06-06", session: "pm", specialty_name: "ENT" }),
      ],
      rules,
    );
    expect(sessions.map((s) => s.creditedPa)).toEqual([3, 0]);
  });
});
