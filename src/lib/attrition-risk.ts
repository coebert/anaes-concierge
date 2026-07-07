// Pure-TS attrition risk model — transparent weighted rubric, not ML.
// Combines wellbeing signals + Bradford + leave/history features.

import type { WellbeingResult } from "@/features/wellbeing/wellbeing-score";

export type AttritionBand = "low" | "watch" | "elevated" | "high";

export interface AttritionFactor {
  key: string;
  label: string;
  contribution: number; // 0..1
  weight: number;
}

export interface AttritionResult {
  risk: number; // 0..1
  band: AttritionBand;
  topFactors: AttritionFactor[];
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
      label: `Wellbeing ${input.wellbeing.score}/100`,
      contribution: clamp01((100 - input.wellbeing.score) / 100),
      weight: 0.30,
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
        input.daysSinceLastAnnual == null
          ? 0.7
          : clamp01(input.daysSinceLastAnnual / 180),
      weight: 0.10,
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
          ? "No recent pulse response"
          : `Pulse trend ${input.pulseTrend > 0 ? "+" : ""}${input.pulseTrend.toFixed(1)}`,
      contribution:
        input.pulseTrend == null ? 0.3 : clamp01(-input.pulseTrend / 2),
      weight: 0.13,
    },
  ];

  const risk = factors.reduce((s, f) => s + f.contribution * f.weight, 0);
  const clamped = Math.max(0, Math.min(1, risk));
  const band: AttritionBand =
    clamped >= 0.65 ? "high" : clamped >= 0.45 ? "elevated" : clamped >= 0.25 ? "watch" : "low";

  const topFactors = [...factors]
    .sort((a, b) => b.contribution * b.weight - a.contribution * a.weight)
    .slice(0, 3);

  return { risk: Math.round(clamped * 100) / 100, band, topFactors };
}

export const ATTRITION_BAND_LABEL: Record<AttritionBand, string> = {
  low: "Low",
  watch: "Watch",
  elevated: "Elevated",
  high: "High",
};

export const ATTRITION_BAND_TONE: Record<AttritionBand, string> = {
  low: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  watch: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  elevated: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  high: "bg-destructive/15 text-destructive",
};
