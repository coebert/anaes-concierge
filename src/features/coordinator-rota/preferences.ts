import type { Issue } from "@/lib/rota-validation";

export type PreferenceLevel = "preferred" | "willing" | "prefer_not_to" | "none";

export interface StaffPracticePref {
  staff_id: string;
  covers_obstetrics: boolean;
  covers_paediatrics: boolean;
  covers_cleft_palate: boolean;
}

export interface StaffSpecialtyPref {
  staff_id: string;
  specialty_id: string;
  preference: PreferenceLevel;
}

/**
 * Detect coverage requirements from a specialty name. Names in the
 * Salisbury register include phrases like "Obstetric anaesthesia",
 * "Paediatric surgery", "Cleft palate", etc.
 */
export function detectListCoverageRequirements(specialtyName: string | null | undefined) {
  const n = (specialtyName ?? "").toLowerCase();
  return {
    needsObstetrics: /\bobstet/i.test(n),
    needsPaediatrics: /\bpaed|\bpediat/i.test(n),
    needsCleft: /\bcleft/i.test(n),
  };
}

export interface EvaluatePreferenceInput {
  staffId: string;
  grade: string | null | undefined;
  specialtyId: string | null | undefined;
  specialtyName: string | null | undefined;
  practicePref: StaffPracticePref | undefined;
  specialtyPref: StaffSpecialtyPref | undefined;
}

/**
 * Emits issues (warnings) when a consultant or SAS doctor's recorded
 * preferences do not match the surgical list. Trainees and other grades
 * pass through with no preference-derived issues.
 */
export function evaluatePreference(input: EvaluatePreferenceInput): Issue[] {
  const issues: Issue[] = [];
  if (!input.specialtyId) return issues;
  if (input.grade !== "consultant" && input.grade !== "sas") return issues;

  const spec = input.specialtyPref?.preference ?? "willing";
  if (spec === "none") {
    issues.push({
      severity: "warning",
      message: `Preference — this ${input.grade === "sas" ? "SAS doctor" : "consultant"} is marked as not covering ${input.specialtyName ?? "this specialty"}.`,
    });
  }

  const req = detectListCoverageRequirements(input.specialtyName);
  if (req.needsObstetrics && !input.practicePref?.covers_obstetrics) {
    issues.push({
      severity: "warning",
      message: "Preference — not marked as covering obstetrics.",
    });
  }
  if (req.needsPaediatrics && !input.practicePref?.covers_paediatrics) {
    issues.push({
      severity: "warning",
      message: "Preference — not marked as covering paediatrics.",
    });
  }
  if (req.needsCleft && !input.practicePref?.covers_cleft_palate) {
    issues.push({
      severity: "warning",
      message: "Preference — not marked as doing cleft palate lists.",
    });
  }
  return issues;
}

/**
 * True if this staff member "matches" the list based on preferences.
 * A match means: no specialty preference of "none", plus all required
 * coverage flags are set. Non-consultant/SAS staff always match.
 */
export function preferenceMatches(input: EvaluatePreferenceInput): boolean {
  if (input.grade !== "consultant" && input.grade !== "sas") return true;
  if (!input.specialtyId) return true;
  if ((input.specialtyPref?.preference ?? "willing") === "none") return false;
  const req = detectListCoverageRequirements(input.specialtyName);
  if (req.needsObstetrics && !input.practicePref?.covers_obstetrics) return false;
  if (req.needsPaediatrics && !input.practicePref?.covers_paediatrics) return false;
  if (req.needsCleft && !input.practicePref?.covers_cleft_palate) return false;
  return true;
}

/** Highest-tier "preferred" (only for consultants/SAS with matching spec pref). */
export function isPreferred(input: EvaluatePreferenceInput): boolean {
  if (input.grade !== "consultant" && input.grade !== "sas") return false;
  return (input.specialtyPref?.preference ?? "willing") === "preferred";
}

/**
 * Compare two staff members for the assignment dropdown. Ordering:
 *   1. Preferred (★) first
 *   2. Then matching (covers all required flags + specialty not "none")
 *   3. Then everyone else
 * Ties fall through to a caller-provided tiebreaker (usually surname).
 *
 * Exported so the sort is unit-testable independently of the dialog.
 */
export function compareStaffByPreference<T>(
  a: T,
  b: T,
  toInput: (s: T) => EvaluatePreferenceInput,
  tiebreak: (a: T, b: T) => number = () => 0,
): number {
  const ai = toInput(a);
  const bi = toInput(b);
  const ap = isPreferred(ai) ? 0 : 1;
  const bp = isPreferred(bi) ? 0 : 1;
  if (ap !== bp) return ap - bp;
  const am = preferenceMatches(ai) ? 0 : 1;
  const bm = preferenceMatches(bi) ? 0 : 1;
  if (am !== bm) return am - bm;
  return tiebreak(a, b);
}

