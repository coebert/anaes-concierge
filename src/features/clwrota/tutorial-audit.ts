import { looksLikeTutorialLabel } from "./parsing";

type TutorialAuditAssignment = {
  duty_type: string | null;
  notes: string | null;
  role_on_list: string | null;
  extra_type?: string | null;
  theatreName?: string | null;
  locationName?: string | null;
};

export function isTutorialAttendeeAssignment(
  row: Pick<TutorialAuditAssignment, "notes">,
): boolean {
  return /^\s*tutorial\s*\(attending\)/i.test(row.notes ?? "");
}

export function isTutorialAuditCandidate(row: TutorialAuditAssignment): boolean {
  if (isTutorialAttendeeAssignment(row)) return false;
  if (row.duty_type === "teaching") return true;
  return looksLikeTutorialLabel(getTutorialEvidenceLabels(row));
}

export function getTutorialEvidenceLabel(row: TutorialAuditAssignment): string | null {
  for (const label of getTutorialEvidenceLabels(row)) {
    if (label && looksLikeTutorialLabel([label])) return label.trim();
  }
  return null;
}

function getTutorialEvidenceLabels(
  row: TutorialAuditAssignment,
): Array<string | null | undefined> {
  return [
    row.notes,
    row.extra_type ?? null,
    row.theatreName ?? null,
    row.locationName ?? null,
    row.role_on_list,
  ];
}