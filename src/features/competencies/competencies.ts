// Pure helpers for the competency / credentialing register.
//
// Two data shapes here:
//   * `CompetencyRequirement` — "to work a list of specialty X in role Y, you
//     need competency Z (required or recommended)".
//   * `StaffCompetency` — "staff member S holds competency C (with optional
//     level, expiry and revocation)".
//
// The evaluator combines them for a candidate assignment and returns Issue[]
// (severity: warning|info) that plug into the existing rota-validation UI.
// Missing a `required` competency is a WARNING (not an error) — the
// coordinator can still override; this is a soft flag, not a block.

import type { Issue } from "@/lib/rota-validation";

export type CompetencyCategory =
  | "subspecialty"
  | "procedural"
  | "lead_role"
  | "transfer"
  | "training"
  | "other";

export type CompetencyLevel = "independent" | "supervised" | "aware";

export type RequirementLevel = "required" | "recommended";

/** solo/supervising apply to theatre role_on_list. `any` matches all. */
export type CompetencyRequirementRole = "solo" | "supervising" | "any";

export interface Competency {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: CompetencyCategory;
  applies_to_grades: string[];
  active: boolean;
  sort_order: number;
}

export interface StaffCompetency {
  id: string;
  staff_id: string;
  competency_id: string;
  level: CompetencyLevel | null;
  granted_at: string; // YYYY-MM-DD
  expires_at: string | null;
  revoked_at: string | null;
  notes: string | null;
}

export interface CompetencyRequirement {
  id: string;
  specialty_id: string;
  competency_id: string;
  requirement: RequirementLevel;
  applies_to_role: CompetencyRequirementRole;
}

/** Is this holding valid on the given ISO date? */
export function isHoldingActive(
  holding: Pick<StaffCompetency, "granted_at" | "expires_at" | "revoked_at">,
  onDate: string,
): boolean {
  if (holding.revoked_at && holding.revoked_at <= onDate) return false;
  if (holding.granted_at > onDate) return false;
  if (holding.expires_at && holding.expires_at < onDate) return false;
  return true;
}

/** Does a role match a requirement's applies_to_role? */
export function roleMatchesRequirement(
  role: string,
  requiredFor: CompetencyRequirementRole,
): boolean {
  if (requiredFor === "any") return true;
  if (requiredFor === "solo") return role === "solo";
  if (requiredFor === "supervising") return role === "supervising";
  return false;
}

export interface EvaluateCompetencyArgs {
  staffId: string;
  specialtyId: string | null;
  role: string;
  onDate: string;
  requirements: CompetencyRequirement[];
  staffCompetencies: StaffCompetency[];
  competencies: Competency[];
  /**
   * When true (default), a missing `required` competency — or a solo role
   * held only at `supervised` level — is emitted as an ERROR, so the rota
   * validator will block the assignment. Set to false to downgrade to a
   * warning (used for read-only surfaces such as reports/inbox).
   */
  blockMissingRequired?: boolean;
}

/**
 * Return Issue[] describing any missing/expiring competencies for the
 * candidate assignment. By default, missing `required` competencies raise an
 * ERROR which blocks the assignment in the rota editor. Missing
 * `recommended` competencies remain informational.
 */
export function evaluateCompetency(args: EvaluateCompetencyArgs): Issue[] {
  const issues: Issue[] = [];
  if (!args.specialtyId) return issues;
  const block = args.blockMissingRequired ?? true;

  const relevant = args.requirements.filter(
    (r) =>
      r.specialty_id === args.specialtyId &&
      roleMatchesRequirement(args.role, r.applies_to_role),
  );
  if (relevant.length === 0) return issues;

  const held = new Map<string, StaffCompetency>();
  for (const h of args.staffCompetencies) {
    if (h.staff_id !== args.staffId) continue;
    if (!isHoldingActive(h, args.onDate)) continue;
    held.set(h.competency_id, h);
  }
  const compById = new Map(args.competencies.map((c) => [c.id, c]));

  for (const r of relevant) {
    const comp = compById.get(r.competency_id);
    if (!comp) continue;
    const holding = held.get(r.competency_id);
    if (!holding) {
      if (r.requirement === "required") {
        issues.push({
          severity: block ? "error" : "warning",
          message: `Not signed off for "${comp.name}" — required competency for this list.`,
        });
      } else {
        issues.push({
          severity: "info",
          message: `Not signed off for "${comp.name}" (recommended).`,
        });
      }
      continue;
    }
    if (holding.expires_at) {
      const days = daysBetween(args.onDate, holding.expires_at);
      if (days <= 30 && days >= 0) {
        issues.push({
          severity: "info",
          message: `"${comp.name}" sign-off expires in ${days} day${days === 1 ? "" : "s"}.`,
        });
      }
    }
    if (holding.level === "supervised" && args.role === "solo") {
      issues.push({
        severity: block && r.requirement === "required" ? "error" : "warning",
        message: `"${comp.name}" sign-off is "supervised" only — solo role not permitted.`,
      });
    }
  }
  return issues;
}

/** Whole-days between two YYYY-MM-DD strings (b - a). Ignores DST. */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ta = Date.UTC(ay, am - 1, ad);
  const tb = Date.UTC(by, bm - 1, bd);
  return Math.round((tb - ta) / 86_400_000);
}
