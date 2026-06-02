/**
 * Automatic root-cause investigator for working-pattern validation
 * mismatches.
 *
 * Given a flagged ValidationCell (produced by validateConsultantPatterns),
 * this module:
 *
 *   1. Inspects the underlying sample rows.
 *   2. Classifies the most likely cause(s) of the gap between the model's
 *      working-% and the independently sampled working-%.
 *   3. Emits a list of `Diagnosis` items, each with a human-readable
 *      summary, supporting evidence, and a recommended remediation that
 *      either points to an existing admin page (duty-type mappings) or
 *      describes a code/label change the engineer can apply.
 *
 * The investigator is intentionally pure — it does not mutate the
 * database. The UI layer wires "Apply" buttons into the appropriate
 * admin pages so the human stays in control of any rota / mapping
 * change.
 */

import { normaliseRotaLabelText } from "@/lib/clwrota-labels";
import type {
  ValidationCell,
  ValidationConsultant,
  ValidationReport,
  ValidationSample,
} from "./list-feasibility-validation";

export type DiagnosisCode =
  | "unrecognised_off_label"
  | "non_theatre_clinical_label"
  | "off_day_with_clinical_activity"
  | "sparse_data"
  | "model_undercounts_clinical"
  | "model_overcounts_clinical"
  | "excess_other_duty";

export type RemediationKind =
  | "extend-non-working-labels"
  | "review-duty-mapping"
  | "widen-validation-window"
  | "review-tenure"
  | "review-feasibility-thresholds"
  | "manual-review";

export interface Remediation {
  kind: RemediationKind;
  /** Short imperative summary, e.g. "Add 'study leave' to non-working labels". */
  summary: string;
  /** Optional in-app link to the admin page that can address it. */
  href?: string;
  /** Optional payload an "Apply" handler can use (e.g. the offending label tokens). */
  payload?: Record<string, unknown>;
}

export interface Diagnosis {
  code: DiagnosisCode;
  severity: "info" | "warn" | "error";
  /** One-line plain English explanation. */
  summary: string;
  /** Supporting facts pulled from the cell samples. */
  evidence: string[];
  remediation: Remediation;
}

export interface DiagnosedCell extends ValidationCell {
  diagnoses: Diagnosis[];
}

export interface DiagnosedConsultant
  extends Omit<ValidationConsultant, "cells"> {
  cells: DiagnosedCell[];
  topDiagnosis: Diagnosis | null;
}

export interface DiagnosedReport extends Omit<ValidationReport, "consultants"> {
  consultants: DiagnosedConsultant[];
  /** Tally of diagnoses across every mismatched cell in the report. */
  causeTally: Array<{ code: DiagnosisCode; count: number; summary: string }>;
}

// ---------- Heuristics ----------

const CLINICAL_HINT_WORDS = [
  "list",
  "theatre",
  "endoscopy",
  "obstetric",
  "labour",
  "section",
  "clinic",
  "operating",
  "anaesthetic",
];

const POTENTIAL_OFF_HINT_WORDS = [
  "leave",
  "study",
  "annual",
  "holiday",
  "tcs",
  "swap",
  "unavailable",
  "absent",
  "sick",
  "professional",
  "spa",
];

function uniqueNoteTokens(samples: ValidationSample[]): string[] {
  const seen = new Set<string>();
  for (const s of samples) {
    const norm = normaliseRotaLabelText(s.notes ?? "");
    if (norm) seen.add(norm);
  }
  return [...seen];
}

function findUnrecognisedOffLabels(cell: ValidationCell): string[] {
  // "other_duty" samples whose notes look like a non-working marker we
  // failed to recognise.
  const out = new Set<string>();
  for (const s of cell.samples) {
    if (s.classification !== "other_duty") continue;
    const norm = normaliseRotaLabelText(s.notes ?? "");
    if (!norm) continue;
    if (POTENTIAL_OFF_HINT_WORDS.some((w) => norm.includes(w))) {
      out.add(norm);
    }
  }
  return [...out];
}

function findClinicalLookingOtherDuties(cell: ValidationCell): Array<{
  dutyType: string;
  notes: string;
}> {
  const out: Array<{ dutyType: string; notes: string }> = [];
  const seen = new Set<string>();
  for (const s of cell.samples) {
    if (s.classification !== "other_duty") continue;
    const norm = normaliseRotaLabelText(s.notes ?? "");
    const hasClinicalHint =
      CLINICAL_HINT_WORDS.some((w) => norm.includes(w)) ||
      // duty_type itself might already be a clinical-ish bucket.
      (s.dutyType &&
        CLINICAL_HINT_WORDS.some((w) =>
          (s.dutyType ?? "").toLowerCase().includes(w),
        ));
    if (!hasClinicalHint) continue;
    const key = `${s.dutyType ?? "?"}|${norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dutyType: s.dutyType ?? "(unknown)", notes: s.notes ?? "" });
  }
  return out;
}

export function diagnoseValidationCell(cell: ValidationCell): Diagnosis[] {
  if (!cell.mismatch) return [];

  const diagnoses: Diagnosis[] = [];
  const n = cell.sampleSize;

  // 1) Off-day claimed by model but sampled clinical activity exists.
  if (cell.modelRegularDayOff && cell.clinical > 0) {
    diagnoses.push({
      code: "off_day_with_clinical_activity",
      severity: "error",
      summary:
        "Model marks this half-day as a regular day off, but the sample contains clinical sessions.",
      evidence: [
        `${cell.clinical}/${n} sampled dates show theatre activity.`,
        "The day-off rule is overriding real working sessions.",
      ],
      remediation: {
        kind: "review-feasibility-thresholds",
        summary:
          "Lower the regular-day-off cutoff, widen the tenure, or remove the day-off flag for this consultant.",
        href: "/robustness/list-feasibility",
      },
    });
  }

  // 2) Sparse data — sample too small to be informative once off-day rows
  //    are removed, or noRecord dominates.
  const usableSample = n - cell.offDayLabel;
  if (usableSample <= 2 || cell.noRecord / Math.max(1, n) >= 0.7) {
    diagnoses.push({
      code: "sparse_data",
      severity: "info",
      summary:
        "Very few usable observations for this cell — the apparent gap may be noise rather than a real disagreement.",
      evidence: [
        `Usable observations after removing off-day labels: ${usableSample}/${n}.`,
        `${cell.noRecord} of ${n} sampled dates had no rota record at all.`,
      ],
      remediation: {
        kind: "widen-validation-window",
        summary:
          "Increase the validation window (months back) so more dates fall inside the consultant's tenure.",
      },
    });
  }

  // 3) Unrecognised off-day labels — strong actionable cause.
  const missedOff = findUnrecognisedOffLabels(cell);
  if (missedOff.length > 0) {
    diagnoses.push({
      code: "unrecognised_off_label",
      severity: "warn",
      summary:
        "Some sampled rows look like non-working markers (study leave, annual leave, etc.) but are not recognised as such by the off-day filter.",
      evidence: missedOff
        .slice(0, 4)
        .map((label) => `Unrecognised label: "${label}"`),
      remediation: {
        kind: "extend-non-working-labels",
        summary:
          "Extend src/lib/clwrota-labels.ts so these tokens are treated as non-working and excluded from the denominator.",
        payload: { tokens: missedOff },
      },
    });
  }

  // 4) Clinical-looking rows mis-categorised as 'other_duty'.
  const clinicalLooking = findClinicalLookingOtherDuties(cell);
  if (clinicalLooking.length > 0) {
    diagnoses.push({
      code: "non_theatre_clinical_label",
      severity: "warn",
      summary:
        "Some 'other_duty' rows have clinical-sounding labels (theatre / list / endoscopy / obstetrics). They are probably mis-mapped duty types.",
      evidence: clinicalLooking.slice(0, 4).map(
        (r) => `duty_type="${r.dutyType}" notes="${r.notes.slice(0, 60)}"`,
      ),
      remediation: {
        kind: "review-duty-mapping",
        summary:
          "Open duty-type mappings and re-map these labels to 'theatre' so the model counts them as clinical activity.",
        href: "/admin/duty-mappings",
        payload: {
          dutyTypes: [...new Set(clinicalLooking.map((r) => r.dutyType))],
        },
      },
    });
  }

  // 5) Directional sign of the residual gap.
  const directionalCause: DiagnosisCode =
    cell.delta > 0 ? "model_undercounts_clinical" : "model_overcounts_clinical";
  if (!diagnoses.some((d) => d.code === directionalCause)) {
    if (cell.delta > 0) {
      diagnoses.push({
        code: "model_undercounts_clinical",
        severity: "warn",
        summary:
          "The independent sample shows more clinical activity than the model. Consultant tenure or weighting may be too narrow.",
        evidence: [
          `Model ${cell.modelPct}% vs sampled ${cell.sampledPct}% (Δ +${cell.delta}).`,
          `Clinical observations: ${cell.clinical}/${usableSample} usable rows.`,
        ],
        remediation: {
          kind: "review-tenure",
          summary:
            "Check that the consultant's tenure window covers their full working history and isn't truncated by missing rota imports.",
        },
      });
    } else if (cell.delta < 0) {
      // Many "other_duty" rows (SPA / admin / on-call) push sampled% down.
      const otherShare =
        usableSample > 0 ? cell.otherDuty / usableSample : 0;
      if (otherShare >= 0.5) {
        diagnoses.push({
          code: "excess_other_duty",
          severity: "warn",
          summary:
            "Most sampled rows are non-theatre duties (SPA, admin, on-call, leave). The model is over-treating this slot as theatre-bearing.",
          evidence: [
            `${cell.otherDuty}/${usableSample} usable rows are non-theatre duty types.`,
            `Top duty types: ${uniqueNoteTokens(
              cell.samples.filter((s) => s.classification === "other_duty"),
            )
              .slice(0, 3)
              .map((t) => `"${t}"`)
              .join(", ") || "—"}.`,
          ],
          remediation: {
            kind: "review-duty-mapping",
            summary:
              "If these labels really are clinical, re-map them. Otherwise the consultant simply isn't theatre-active on this slot.",
            href: "/admin/duty-mappings",
          },
        });
      } else {
        diagnoses.push({
          code: "model_overcounts_clinical",
          severity: "warn",
          summary:
            "The model rates this slot as more clinical than the sample supports.",
          evidence: [
            `Model ${cell.modelPct}% vs sampled ${cell.sampledPct}% (Δ ${cell.delta}).`,
            `Clinical observations: ${cell.clinical}/${usableSample} usable rows.`,
          ],
          remediation: {
            kind: "review-feasibility-thresholds",
            summary:
              "Tighten the 'regular working' threshold or revisit how this consultant's tenure is computed.",
          },
        });
      }
    }
  }

  if (diagnoses.length === 0) {
    diagnoses.push({
      code: "model_undercounts_clinical",
      severity: "info",
      summary:
        "Mismatch detected but no specific cause heuristic matched — manual review recommended.",
      evidence: [`Δ ${cell.delta} pts across ${n} samples.`],
      remediation: {
        kind: "manual-review",
        summary: "Open the sampled rows and check raw CLWRota data by hand.",
      },
    });
  }

  return diagnoses;
}

const CAUSE_LABELS: Record<DiagnosisCode, string> = {
  unrecognised_off_label: "Unrecognised off-day labels",
  non_theatre_clinical_label: "Clinical activity mis-mapped to other duty",
  off_day_with_clinical_activity: "Day-off flag despite clinical sessions",
  sparse_data: "Sparse data / small sample",
  model_undercounts_clinical: "Model under-counts clinical activity",
  model_overcounts_clinical: "Model over-counts clinical activity",
  excess_other_duty: "Mostly SPA / admin / on-call duties",
};

export function diagnoseValidationReport(
  report: ValidationReport,
): DiagnosedReport {
  const tally = new Map<DiagnosisCode, number>();

  const consultants: DiagnosedConsultant[] = report.consultants.map((c) => {
    const cells: DiagnosedCell[] = c.cells.map((cell) => {
      const diagnoses = diagnoseValidationCell(cell);
      for (const d of diagnoses) {
        tally.set(d.code, (tally.get(d.code) ?? 0) + 1);
      }
      return { ...cell, diagnoses };
    });

    // Pick the most severe diagnosis across the consultant's cells as the
    // headline cause shown in the collapsed row.
    const sev = { error: 3, warn: 2, info: 1 } as const;
    let topDiagnosis: Diagnosis | null = null;
    for (const cell of cells) {
      for (const d of cell.diagnoses) {
        if (!topDiagnosis || sev[d.severity] > sev[topDiagnosis.severity]) {
          topDiagnosis = d;
        }
      }
    }

    return { ...c, cells, topDiagnosis };
  });

  const causeTally = [...tally.entries()]
    .map(([code, count]) => ({ code, count, summary: CAUSE_LABELS[code] }))
    .sort((a, b) => b.count - a.count);

  return { ...report, consultants, causeTally };
}

export { CAUSE_LABELS };
