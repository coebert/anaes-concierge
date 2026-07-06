export type TraineeBucket = "all" | "junior" | "senior";
export const BUCKET_LABEL: Record<TraineeBucket, string> = {
  all: "All trainees",
  junior: "CT2–ST4",
  senior: "ST5–ST8+",
};

export function traineeBucket(level: string | null | undefined): TraineeBucket | null {
  if (!level) return null;
  const m = level.trim().toUpperCase().match(/^(CT|ST)(\d+)/);
  if (!m) return null;
  const prefix = m[1];
  const n = parseInt(m[2], 10);
  if (prefix === "CT") return n >= 2 ? "junior" : null;
  // ST
  if (n >= 1 && n <= 4) return "junior";
  if (n >= 5) return "senior";
  return null;
}

export type Grade = "consultant" | "sas" | "trainee";
export const GRADES: Grade[] = ["consultant", "sas", "trainee"];
export const GRADE_LABEL: Record<Grade, string> = {
  consultant: "Consultants",
  sas: "SAS doctors",
  trainee: "Trainees",
};

export const LEAVE_TYPES = ["annual", "sick", "parental", "study", "compassionate", "other"] as const;
export type LeaveType = typeof LEAVE_TYPES[number];
export const LEAVE_LABEL: Record<LeaveType, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  parental: "Parental leave",
  study: "Study leave",
  compassionate: "Compassionate",
  other: "Other",
};
