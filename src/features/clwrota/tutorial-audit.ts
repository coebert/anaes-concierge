import { looksLikeTutorialLabel } from "./parsing";

type TutorialAuditAssignment = {
  duty_type: string | null;
  notes: string | null;
  role_on_list: string | null;
};

export function isTutorialAttendeeAssignment(
  row: Pick<TutorialAuditAssignment, "notes">,
): boolean {
  return /^\s*tutorial\s*\(attending\)/i.test(row.notes ?? "");
}

export function isTutorialAuditCandidate(row: TutorialAuditAssignment): boolean {
  if (isTutorialAttendeeAssignment(row)) return false;
  if (row.duty_type === "teaching") return true;
  return looksLikeTutorialLabel([row.notes, row.role_on_list]);
}