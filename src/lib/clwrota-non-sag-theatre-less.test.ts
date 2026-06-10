import { describe, it, expect } from "vitest";
import { isNonSagRotaLabel } from "./clwrota-labels";

/**
 * Integration regression tests for the CLWRota row shapes that produce
 * an AssignmentDraft with `is_non_sag: true` but no resolvable theatre.
 *
 * The sync in src/lib/clwrota.functions.ts collects the same six free-text
 * fields used here and feeds them into `isNonSagRotaLabel`, then writes the
 * result to `rota_assignments.is_non_sag` regardless of whether the row
 * resolved to a theatre_session_id. Without this, theatre-less NHH lists
 * and non-SAG on-call cover would be silently dropped from the consultant
 * audit (see consultant-non-sag-classify.test.ts).
 *
 * If these tests fail, either the sync's tag detection has regressed or
 * upstream CLWRota has changed where it places the marker — and admins
 * will need to flag every affected row manually.
 */

/** Mirrors the field bundle the sync passes to isNonSagRotaLabel. */
function detectFromRow(row: {
  personNameRaw?: string | null;
  consultantName?: string | null;
  extraTypeName?: string | null;
  roleRaw?: string | null;
  theatreName?: string | null;
  specialtyName?: string | null;
}): boolean {
  return isNonSagRotaLabel([
    row.personNameRaw ?? null,
    row.consultantName ?? null,
    row.extraTypeName ?? null,
    row.roleRaw ?? null,
    row.theatreName ?? null,
    row.specialtyName ?? null,
  ]);
}

describe("CLWRota non-SAG detection — theatre-less rows", () => {
  it("flags an NHH list with no theatre column when the consultant slot carries [Non-SAG]", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        consultantName: "Mr Smith [Non-SAG]",
        // theatreName intentionally absent — CLWRota occasionally omits it
        // for off-site NHH lists.
        roleRaw: "Anaesthetist",
        specialtyName: "General",
      }),
    ).toBe(true);
  });

  it("flags an NHH list when only the rota_name carries the tag", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr S Abbas [Non-SAG]",
        // No theatre, no consultant — bare cover entry.
      }),
    ).toBe(true);
  });

  it("flags an NHH list whose specialty column carries the tag", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        consultantName: "Mr Smith",
        specialtyName: "Endo (non-sag)",
      }),
    ).toBe(true);
  });

  it("flags a row whose extra_type.name = 'Non-SAG' (current CLWRota field)", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        extraTypeName: "Non-SAG",
      }),
    ).toBe(true);
  });

  it("does not falsely flag a SAG list with no theatre", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        consultantName: "Mr Smith",
        roleRaw: "Anaesthetist",
        specialtyName: "Orthopaedics",
      }),
    ).toBe(false);
  });
});

describe("CLWRota non-SAG detection — on-call rows", () => {
  it("flags a non-SAG on-call cover via the role column", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        roleRaw: "Non-SAG on-call",
        // No theatre and no consultant — on-call rows generally lack both.
      }),
    ).toBe(true);
  });

  it("flags a non-SAG on-call cover via the rota_name tag", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr S Abbas [Non-SAG]",
        roleRaw: "On-call",
      }),
    ).toBe(true);
  });

  it("flags a non-SAG on-call where extra_type carries the tag", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        roleRaw: "On-call cover",
        extraTypeName: "Non-SAG cover",
      }),
    ).toBe(true);
  });

  it("does not flag a regular SAG on-call row", () => {
    expect(
      detectFromRow({
        personNameRaw: "Dr Patel",
        roleRaw: "On-call",
        consultantName: null,
        theatreName: null,
      }),
    ).toBe(false);
  });
});
