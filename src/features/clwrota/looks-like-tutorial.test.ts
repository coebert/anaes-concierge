import { describe, it, expect } from "vitest";
import { ensureRotaReportFields, looksLikeTutorialLabel } from "./parsing";
import {
  isTutorialAttendeeAssignment,
  isTutorialAuditCandidate,
} from "./tutorial-audit";

describe("looksLikeTutorialLabel", () => {
  it("matches tutorial and tutorials tokens", () => {
    expect(looksLikeTutorialLabel(["Tutorial"])).toBe(true);
    expect(looksLikeTutorialLabel(["Consultant tutorials"])).toBe(true);
    expect(looksLikeTutorialLabel(["Tutorial/SPA"])).toBe(true);
    // Regression: CLWRota often records the topic in a free-text note on
    // rows whose role/duty is just "SPA" / "Consultant" — the sync now
    // includes the notes field in tutorial detection.
    expect(
      looksLikeTutorialLabel([
        "SPA",
        null,
        "Tutorial: airway management",
      ]),
    ).toBe(true);
  });

  it("matches lectures and departmental teaching", () => {
    expect(looksLikeTutorialLabel(["Lecture"])).toBe(true);
    expect(looksLikeTutorialLabel(["Departmental teaching"])).toBe(true);
    expect(looksLikeTutorialLabel(["IMT Teaching/ Outpatients"])).toBe(true);
  });

  it("does not match plain teaching blocks or College Tutor role", () => {
    expect(looksLikeTutorialLabel(["Teaching"])).toBe(false);
    expect(looksLikeTutorialLabel(["Non-patient-facing: Fellow"])).toBe(false);
    expect(looksLikeTutorialLabel(["College Tutor"])).toBe(false);
  });

  it("ignores nullish or empty labels", () => {
    expect(looksLikeTutorialLabel([null, undefined, ""])).toBe(false);
  });
});

describe("ensureRotaReportFields", () => {
  it("requests the CLWRota fields that carry tutorial labels", () => {
    const url = ensureRotaReportFields(
      "https://example.test/central_api/query/assignments?fields=date,person.local_id",
    );
    const fields = new URL(url).searchParams.get("fields")?.split(",") ?? [];

    expect(fields).toContain("notes");
    expect(fields).toContain("slot_notes");
    expect(fields).toContain("slot_titles");
    expect(fields).toContain("place.name");
  });
});

describe("isTutorialAuditCandidate", () => {
  it("treats CLWRota teaching assignments as tutorial audit candidates", () => {
    expect(
      isTutorialAuditCandidate({
        duty_type: "teaching",
        notes: "Non-patient-facing: Consultant",
        role_on_list: "teaching",
      }),
    ).toBe(true);
  });

  it("keeps legacy SPA/admin tutorial-labelled assignments as candidates", () => {
    expect(
      isTutorialAuditCandidate({
        duty_type: "spa",
        notes: "Tutorial/SPA",
        role_on_list: "admin_session",
      }),
    ).toBe(true);
  });

  it("excludes tutorial attendee assignments", () => {
    const row = {
      duty_type: "teaching",
      notes: "Tutorial (attending): Tutorial/SPA",
      role_on_list: "teaching",
    };
    expect(isTutorialAttendeeAssignment(row)).toBe(true);
    expect(isTutorialAuditCandidate(row)).toBe(false);
  });
});
