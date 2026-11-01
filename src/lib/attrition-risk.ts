// Pure-TS operational signal score — a transparent weighted rubric, NOT a
// validated prediction of leaving and NOT a probability. It has no outcome
// validation evidence; it exists only to prompt a supportive conversation.
// Weights, caps and band thresholds are unchanged from the original rubric.

import type { WellbeingResult } from "@/features/wellbeing/wellbeing-score";

export type AttritionBand = "low" | "watch" | "elevated" | "high" | "not_assessed";

export interface AttritionFactor {
  key: string;
  label: string;
  contribution: number; // 0..1
  weight: number;
}

export interface AttritionResult {
  /** Unrounded weighted sum, 0..1 (internal). */
  risk: number;
  /** Displayed signal score, integer 0..100. The band is selected from THIS
   * rounded value so the shown number and band always agree. */
  score: number;
  band: AttritionBand;
  topFactors: AttritionFactor[];
  /** Inputs that were not measured (shown, never silently treated as good). */
  notAssessed: string[];
}

export interface AttritionInput {
  wellbeing: WellbeingResult;
  bradfordScore: number;
  denialRate12m: number; // 0..1
  shortNoticeChanges12m: number;
  daysSinceLastAnnual: number | null; // null = never
  overdueRtwCount: number;
  pulseTrend: number | null; // avg change vs previous cycle, -4..+4 (nullable)
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function computeAttritionRisk(input: AttritionInput): AttritionResult {
  const factors: AttritionFactor[] = [
    {
      key: "wellbeing",
      // Below the coverage gate the arithmetic score is not a wellbeing level
      // and must not be shown as one (e.g. "Wellbeing 100/100").
      label:
        input.wellbeing.scoreKnown === false
          ? "Wellbeing not assessed"
          : `Wellbeing ${input.wellbeing.score}/100`,
      contribution: clamp01((100 - input.wellbeing.score) / 100),
      weight: 0.3,
    },
    {
      key: "bradford",
      label: `Bradford ${input.bradfordScore}`,
      contribution: clamp01(input.bradfordScore / 400),
      weight: 0.15,
    },
    {
      key: "denials",
      label: `Denial rate ${Math.round(input.denialRate12m * 100)}%`,
      contribution: clamp01(input.denialRate12m / 0.4),
      weight: 0.12,
    },
    {
      key: "shortnotice",
      label: `${input.shortNoticeChanges12m} short-notice changes (12m)`,
      contribution: clamp01(input.shortNoticeChanges12m / 20),
      weight: 0.12,
    },
    {
      key: "annual",
      label:
        input.daysSinceLastAnnual == null
          ? "No annual leave recorded"
          : `${input.daysSinceLastAnnual}d since annual leave`,
      contribution:
        input.daysSinceLastAnnual == null ? 0.7 : clamp01(input.daysSinceLastAnnual / 180),
      weight: 0.1,
    },
    {
      key: "rtw",
      label: `${input.overdueRtwCount} overdue RTW`,
      contribution: clamp01(input.overdueRtwCount / 2),
      weight: 0.08,
    },
    {
      key: "pulse",
      label:
        input.pulseTrend == null
          ? "Pulse trend not assessed"
          : `Pulse trend ${input.pulseTrend > 0 ? "+" : ""}${input.pulseTrend.toFixed(1)}`,
      contribution: input.pulseTrend == null ? 0.3 : clamp01(-input.pulseTrend / 2),
      weight: 0.13,
    },
  ];

  const risk = factors.reduce((s, f) => s + f.contribution * f.weight, 0);
  const clamped = Math.max(0, Math.min(1, risk));
  const score = Math.round(clamped * 100);
  const notAssessed: string[] = [];
  if (input.pulseTrend == null) notAssessed.push("pulse survey trend");
  const wellbeingKnown = input.wellbeing.scoreKnown !== false;
  if (!wellbeingKnown) notAssessed.push("wellbeing (insufficient rota data)");
  const band: AttritionBand = !wellbeingKnown ? "not_assessed" : attritionBandFor(score);

  const topFactors = [...factors]
    .sort((a, b) => b.contribution * b.weight - a.contribution * a.weight)
    .slice(0, 3);

  return { risk: clamped, score, band, topFactors, notAssessed };
}

/** Thresholds unchanged (25 / 45 / 65), applied to the displayed integer. */
export function attritionBandFor(score: number): Exclude<AttritionBand, "not_assessed"> {
  return score >= 65 ? "high" : score >= 45 ? "elevated" : score >= 25 ? "watch" : "low";
}

export const ATTRITION_BAND_LABEL: Record<AttritionBand, string> = {
  low: "Low",
  watch: "Watch",
  elevated: "Elevated",
  high: "High",
  not_assessed: "Not assessed",
};

export const ATTRITION_BAND_TONE: Record<AttritionBand, string> = {
  low: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  watch: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  elevated: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  high: "bg-destructive/15 text-destructive",
  not_assessed: "bg-muted text-muted-foreground",
};
