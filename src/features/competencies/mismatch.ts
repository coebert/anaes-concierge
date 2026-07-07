// Detailed per-competency breakdown for a candidate pairing (staff × specialty
// × role × date). Powers the "why is this blocked?" tooltip in CellDialog.
//
// Unlike evaluateCompetency (which returns Issue[] to feed the validator),
// this returns a structured row per required-or-recommended competency so the
// UI can render a table: name, requirement level, status, expiry, notes.

import {
  isHoldingActive,
  roleMatchesRequirement,
  type Competency,
  type CompetencyRequirement,
  type StaffCompetency,
  type CompetencyLevel,
} from "./competencies";

export type MismatchStatus =
  | "ok_independent"
  | "ok_supervised"
  | "ok_unspecified"
  | "expiring"
  | "missing"
  | "expired"
  | "revoked"
  | "supervised_only_for_solo";

export interface MismatchRow {
  competencyId: string;
  competencyCode: string;
  competencyName: string;
  requirement: "required" | "recommended";
  status: MismatchStatus;
  blocking: boolean; // would this row cause the assignment to be blocked?
  level: CompetencyLevel | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
}

export interface MismatchDetails {
  rows: MismatchRow[];
  requiredMissing: number;
  requiredHeld: number;
  hasBlocker: boolean;
}

export interface ComputeMismatchArgs {
  staffId: string;
  specialtyId: string;
  role: string;
  onDate: string;
  competencies: Competency[];
  requirements: CompetencyRequirement[];
  staffCompetencies: StaffCompetency[];
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

export function computeCompetencyMismatch(
  args: ComputeMismatchArgs,
): MismatchDetails {
  const compById = new Map(args.competencies.map((c) => [c.id, c]));
  const relevant = args.requirements.filter(
    (r) =>
      r.specialty_id === args.specialtyId &&
      roleMatchesRequirement(args.role, r.applies_to_role),
  );
  const heldById = new Map<string, StaffCompetency>();
  for (const h of args.staffCompetencies) {
    if (h.staff_id !== args.staffId) continue;
    heldById.set(h.competency_id, h);
  }

  const rows: MismatchRow[] = [];
  let requiredMissing = 0;
  let requiredHeld = 0;
  let hasBlocker = false;

  for (const r of relevant) {
    const comp = compById.get(r.competency_id);
    if (!comp) continue;
    const holding = heldById.get(r.competency_id);
    const active = holding ? isHoldingActive(holding, args.onDate) : false;

    let status: MismatchStatus;
    let blocking = false;

    if (!holding) {
      status = "missing";
      blocking = r.requirement === "required";
    } else if (holding.revoked_at && holding.revoked_at <= args.onDate) {
      status = "revoked";
      blocking = r.requirement === "required";
    } else if (holding.expires_at && holding.expires_at < args.onDate) {
      status = "expired";
      blocking = r.requirement === "required";
    } else if (
      holding.level === "supervised" &&
      args.role === "solo" &&
      r.requirement === "required"
    ) {
      status = "supervised_only_for_solo";
      blocking = true;
    } else if (
      active &&
      holding.expires_at &&
      daysBetween(args.onDate, holding.expires_at) <= 30
    ) {
      status = "expiring";
      blocking = false;
    } else if (holding.level === "independent") {
      status = "ok_independent";
    } else if (holding.level === "supervised") {
      status = "ok_supervised";
    } else {
      status = "ok_unspecified";
    }

    if (r.requirement === "required") {
      if (blocking) requiredMissing += 1;
      else requiredHeld += 1;
    }
    if (blocking) hasBlocker = true;

    rows.push({
      competencyId: comp.id,
      competencyCode: comp.code,
      competencyName: comp.name,
      requirement: r.requirement,
      status,
      blocking,
      level: (holding?.level ?? null) as CompetencyLevel | null,
      expiresAt: holding?.expires_at ?? null,
      daysUntilExpiry: holding?.expires_at
        ? daysBetween(args.onDate, holding.expires_at)
        : null,
    });
  }

  rows.sort((a, b) => {
    const score = (r: MismatchRow) =>
      (r.blocking ? 0 : r.requirement === "required" ? 1 : 2);
    const s = score(a) - score(b);
    if (s !== 0) return s;
    return a.competencyName.localeCompare(b.competencyName);
  });

  return { rows, requiredMissing, requiredHeld, hasBlocker };
}

export const STATUS_LABEL: Record<MismatchStatus, string> = {
  ok_independent: "Signed off (independent)",
  ok_supervised: "Signed off (supervised)",
  ok_unspecified: "Signed off",
  expiring: "Expiring soon",
  missing: "Not signed off",
  expired: "Expired",
  revoked: "Revoked",
  supervised_only_for_solo: "Only supervised — solo not permitted",
};
