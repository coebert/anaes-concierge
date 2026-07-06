import { cn } from "@/lib/utils";

export interface LeaveRow {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  half_day_start: string | null;
  half_day_end: string | null;
  reason: string | null;
  conflict_notes: string | null;
  decision_notes: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  full_name: string;
  grade: string | null;
}

export const ACTIVE_STATUSES = new Set(["approved", "pending"]);

export function statusVariant(
  s: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (s === "approved") return "default";
  if (s === "rejected" || s === "cancelled") return "destructive";
  return "secondary";
}

/** A leave row covers a given date if start_date <= date <= end_date. */
export function leaveCoversDate(r: LeaveRow, isoDate: string): boolean {
  return r.start_date <= isoDate && isoDate <= r.end_date;
}

export function gradeLabel(grade: string | null | undefined): string {
  if (!grade) return "Other";
  if (grade === "consultant") return "Consultant";
  if (grade === "trainee") return "Trainee";
  if (grade === "sas") return "SAS";
  return grade;
}

export function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        accent ? "bg-primary/5 border-primary/30" : "bg-muted/30",
      )}
    >
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
