// Pure helpers for the trainee-facing competency progress page.
//
// Two things this module computes:
//   1. `computeTraineeProgress` — for a given trainee, a per-specialty list of
//      required/recommended competencies with a status (held / missing / etc.).
//   2. `computeEligibility` — for a given holdings snapshot (one or many
//      staff), which staff are eligible to run each specialty solo or as a
//      supervising consultant.
//
// The evaluator itself lives in ./competencies.ts. We keep this file pure so
// it can be tested in isolation and reused by admin surfaces later.

import {
  isHoldingActive,
  type Competency,
  type CompetencyRequirement,
  type StaffCompetency,
} from "./competencies";

export type SignoffStatus =
  | "signed_off_independent"
  | "signed_off_supervised"
  | "signed_off_unspecified"
  | "expiring"
  | "expired"
  | "revoked"
  | "missing";

export interface ProgressItem {
  competencyId: string;
  competencyName: string;
  competencyCode: string;
  requirement: "required" | "recommended";
  appliesToRole: "solo" | "supervising" | "any";
  status: SignoffStatus;
  level: "independent" | "supervised" | "aware" | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
}

export interface SpecialtyProgress {
  specialtyId: string;
  specialtyName: string;
  items: ProgressItem[];
  requiredTotal: number;
  requiredHeld: number;
}

export interface Specialty {
  id: string;
  name: string;
}

/** Whole-day difference (b - a) for YYYY-MM-DD strings. */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

function statusForHolding(
  holding: StaffCompetency | undefined,
  onDate: string,
): { status: SignoffStatus; days: number | null } {
  if (!holding) return { status: "missing", days: null };
  if (holding.revoked_at && holding.revoked_at <= onDate) {
    return { status: "revoked", days: null };
  }
  if (holding.expires_at) {
    const days = daysBetween(onDate, holding.expires_at);
    if (days < 0) return { status: "expired", days };
    if (days <= 30) return { status: "expiring", days };
  }
  if (holding.level === "independent") {
    return { status: "signed_off_independent", days: null };
  }
  if (holding.level === "supervised") {
    return { status: "signed_off_supervised", days: null };
  }
  return { status: "signed_off_unspecified", days: null };
}

export interface ComputeTraineeProgressArgs {
  staffId: string;
  onDate: string;
  specialties: Specialty[];
  competencies: Competency[];
  requirements: CompetencyRequirement[];
  staffCompetencies: StaffCompetency[];
}

/** Per-specialty required-and-recommended progress for one trainee. */
export function computeTraineeProgress(
  args: ComputeTraineeProgressArgs,
): SpecialtyProgress[] {
  const compById = new Map(args.competencies.map((c) => [c.id, c]));
  const heldByComp = new Map<string, StaffCompetency>();
  for (const h of args.staffCompetencies) {
    if (h.staff_id !== args.staffId) continue;
    heldByComp.set(h.competency_id, h);
  }

  const bySpec = new Map<string, CompetencyRequirement[]>();
  for (const r of args.requirements) {
    if (!bySpec.has(r.specialty_id)) bySpec.set(r.specialty_id, []);
    bySpec.get(r.specialty_id)!.push(r);
  }

  const out: SpecialtyProgress[] = [];
  for (const spec of args.specialties) {
    const reqs = bySpec.get(spec.id) ?? [];
    if (reqs.length === 0) continue;
    const items: ProgressItem[] = [];
    let requiredTotal = 0;
    let requiredHeld = 0;
    for (const r of reqs) {
      const comp = compById.get(r.competency_id);
      if (!comp) continue;
      const holding = heldByComp.get(r.competency_id);
      const active = holding && isHoldingActive(holding, args.onDate);
      const { status, days } = statusForHolding(
        active ? holding : holding, // still surface expired/revoked
        args.onDate,
      );
      if (r.requirement === "required") {
        requiredTotal += 1;
        if (
          active &&
          (status === "signed_off_independent" ||
            status === "signed_off_supervised" ||
            status === "signed_off_unspecified" ||
            status === "expiring")
        ) {
          requiredHeld += 1;
        }
      }
      items.push({
        competencyId: comp.id,
        competencyName: comp.name,
        competencyCode: comp.code,
        requirement: r.requirement,
        appliesToRole: r.applies_to_role,
        status,
        level: holding?.level ?? null,
        expiresAt: holding?.expires_at ?? null,
        daysUntilExpiry: days,
      });
    }
    // Sort: required-missing first, then required, then recommended.
    items.sort((a, b) => {
      const score = (i: ProgressItem) =>
        (i.requirement === "required" ? 0 : 10) +
        (i.status === "missing" || i.status === "expired" || i.status === "revoked"
          ? 0
          : 1);
      const s = score(a) - score(b);
      if (s !== 0) return s;
      return a.competencyName.localeCompare(b.competencyName);
    });
    out.push({
      specialtyId: spec.id,
      specialtyName: spec.name,
      items,
      requiredTotal,
      requiredHeld,
    });
  }
  out.sort((a, b) => a.specialtyName.localeCompare(b.specialtyName));
  return out;
}

// ----------------------------------------------------------------
// Eligibility ("who can run this list?")
// ----------------------------------------------------------------

export interface EligibilityStaff {
  staffId: string;
  fullName: string;
  grade: string | null;
  eligibleSolo: boolean;
  eligibleSupervising: boolean;
}

export interface SpecialtyEligibility {
  specialtyId: string;
  specialtyName: string;
  solo: EligibilityStaff[];
  supervising: EligibilityStaff[];
}

interface StaffMeta {
  staffId: string;
  fullName: string;
  grade: string | null;
}

export interface ComputeEligibilityArgs {
  onDate: string;
  specialties: Specialty[];
  competencies: Competency[];
  requirements: CompetencyRequirement[];
  staff: StaffMeta[];
  staffCompetencies: StaffCompetency[];
}

/**
 * For each specialty, return the staff eligible to run a list solo or as a
 * supervising consultant. Eligibility means: for every `required` requirement
 * matching the role, the staff has an active holding. For solo, any
 * "supervised"-only holding disqualifies.
 */
export function computeEligibility(
  args: ComputeEligibilityArgs,
): SpecialtyEligibility[] {
  // Pre-index active holdings per staff.
  const heldByStaff = new Map<string, Map<string, StaffCompetency>>();
  for (const h of args.staffCompetencies) {
    if (!isHoldingActive(h, args.onDate)) continue;
    let inner = heldByStaff.get(h.staff_id);
    if (!inner) {
      inner = new Map();
      heldByStaff.set(h.staff_id, inner);
    }
    inner.set(h.competency_id, h);
  }

  const bySpec = new Map<string, CompetencyRequirement[]>();
  for (const r of args.requirements) {
    if (r.requirement !== "required") continue;
    if (!bySpec.has(r.specialty_id)) bySpec.set(r.specialty_id, []);
    bySpec.get(r.specialty_id)!.push(r);
  }

  const out: SpecialtyEligibility[] = [];
  for (const spec of args.specialties) {
    const reqs = bySpec.get(spec.id) ?? [];
    const solo: EligibilityStaff[] = [];
    const supervising: EligibilityStaff[] = [];
    for (const s of args.staff) {
      const held = heldByStaff.get(s.staffId) ?? new Map();
      const soloOk = reqs
        .filter((r) => r.applies_to_role === "solo" || r.applies_to_role === "any")
        .every((r) => {
          const h = held.get(r.competency_id);
          if (!h) return false;
          if (h.level === "supervised") return false;
          return true;
        });
      const supOk = reqs
        .filter((r) => r.applies_to_role === "supervising" || r.applies_to_role === "any")
        .every((r) => held.has(r.competency_id));
      if (soloOk) {
        solo.push({
          staffId: s.staffId,
          fullName: s.fullName,
          grade: s.grade,
          eligibleSolo: true,
          eligibleSupervising: supOk,
        });
      }
      if (supOk && !soloOk) {
        supervising.push({
          staffId: s.staffId,
          fullName: s.fullName,
          grade: s.grade,
          eligibleSolo: false,
          eligibleSupervising: true,
        });
      } else if (supOk && soloOk) {
        supervising.push({
          staffId: s.staffId,
          fullName: s.fullName,
          grade: s.grade,
          eligibleSolo: true,
          eligibleSupervising: true,
        });
      }
    }
    solo.sort((a, b) => a.fullName.localeCompare(b.fullName));
    supervising.sort((a, b) => a.fullName.localeCompare(b.fullName));
    out.push({
      specialtyId: spec.id,
      specialtyName: spec.name,
      solo,
      supervising,
    });
  }
  out.sort((a, b) => a.specialtyName.localeCompare(b.specialtyName));
  return out;
}
