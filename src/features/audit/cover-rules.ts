/**
 * Anaesthetic cover rules — the single source for the Robustness overview,
 * day detail, what-if simulator and the home summary.
 *
 * Who counts as SOLO-CAPABLE cover for a planned daytime list:
 *   - consultants who are free (not on leave, an excluded duty or a list);
 *   - trainees whose recorded training level is exactly ST6, ST7 or ST8
 *     (trimmed, case-insensitive) and who are free.
 * SAS doctors and other trainees are tracked for context but never count
 * toward headroom. Unknown grades never count.
 *
 * SPA CONTINGENCY: consultants on SPA are NOT in baseline headroom. They are
 * a separate, explicit contingency — counted only in `headroomWithSpa`, which
 * decides whether a deficit is "SPA needed" (SPA closes it) or "Shortfall".
 *
 * RISK (per AM/PM half):
 *   headroom = solo-capable free staff − unfilled planned lists
 *   shortfall    headroom < 0 and headroom + SPA consultants < 0
 *   spa_required headroom < 0 but SPA consultants close the gap
 *   tight        0 ≤ headroom ≤ RISK_TIGHT
 *   ok           headroom > RISK_TIGHT
 */
export type CoverRisk = "ok" | "tight" | "spa_required" | "shortfall";

/** Training levels that may solo-cover a daytime list. */
export const SOLO_CAPABLE_TRAINING_LEVELS = ["ST6", "ST7", "ST8"] as const;

/** Headroom at or below this is "tight". */
export const RISK_TIGHT = 1;

export function isSeniorTrainee(trainingLevel: string | null | undefined): boolean {
  if (!trainingLevel) return false;
  const t = trainingLevel.trim().toUpperCase();
  return (SOLO_CAPABLE_TRAINING_LEVELS as readonly string[]).includes(t);
}

/** Grade + level → may this person lead a planned list alone? */
export function isSoloCapable(grade: string | null | undefined, trainingLevel: string | null | undefined) {
  if (grade === "consultant") return true;
  if (grade === "trainee") return isSeniorTrainee(trainingLevel);
  return false;
}

export function classifyRisk(headroom: number, headroomWithSpa: number): CoverRisk {
  if (headroom < 0 && headroomWithSpa >= 0) return "spa_required";
  if (headroom < 0) return "shortfall";
  if (headroom <= RISK_TIGHT) return "tight";
  return "ok";
}

/** Severity order used by every roll-up (worst half of a day, simulator deltas). */
export const RISK_SEVERITY: Record<CoverRisk, number> = {
  ok: 0,
  tight: 1,
  spa_required: 2,
  shortfall: 3,
};

export function worseRisk(a: CoverRisk, b: CoverRisk): CoverRisk {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
}

export const RISK_LABEL: Record<CoverRisk, string> = {
  ok: "OK",
  tight: "Tight",
  spa_required: "SPA needed",
  shortfall: "Shortfall",
};

const levels = SOLO_CAPABLE_TRAINING_LEVELS.join("/");

/** Shared wording — every screen describes the rule the same way. */
export const COVER_TEXT = {
  soloCapableShort: `consultants + ${levels} trainees`,
  soloCapable: `Solo-capable = free consultants and free ${levels} trainees. SAS doctors and other trainees are shown for context but never count toward headroom.`,
  headroom:
    "Headroom = solo-capable staff who are free that half-day, minus planned lists still without anyone assigned.",
  spa: "Consultants on SPA are a separate contingency: never part of headroom, used only to tell “SPA needed” from “Shortfall”.",
  rostered:
    "Only staff with at least one rota entry that day count; no entry means not on duty, not spare capacity.",
  risk: {
    ok: `Headroom above ${RISK_TIGHT} — more than ${RISK_TIGHT} spare solo-capable person.`,
    tight: `Covered, but headroom is 0–${RISK_TIGHT} — little buffer for unexpected absence.`,
    spa_required: "Not enough solo-capable staff; covering every list needs a consultant pulled off SPA.",
    shortfall: "Not enough solo-capable staff even if every consultant on SPA is redeployed.",
  } satisfies Record<CoverRisk, string>,
} as const;
