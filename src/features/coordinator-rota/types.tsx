import { AlertTriangle, Info, ShieldAlert } from "lucide-react";

export type SessionHalf = "am" | "pm";
export type RotaRole =
  | "solo" | "supervised" | "supervising" | "on_call" | "non_clinical" | "teaching" | "admin_session";

export type WeekAssignment = {
  id: string;
  staff_id: string;
  session: SessionHalf;
  session_date: string;
  theatre_session_id: string | null;
  role_on_list: RotaRole;
  supervisor_id?: string | null;
};

export type ContextAssignment = {
  id: string;
  staff_id: string;
  session: SessionHalf;
  session_date: string;
  theatre_session_id: string | null;
  role_on_list: RotaRole;
};

export type JobPlanRow = {
  staff_id: string;
  total_pas: number;
  dcc_pas: number;
  spa_pas: number;
  ltft: boolean;
  ltft_percentage: number | null;
  valid_from: string;
  valid_to: string | null;
};

export type LeaveRow = {
  staff_id: string;
  start_date: string;
  end_date: string;
  status: string;
};

export type FixedSessionRow = {
  staff_id: string;
  day_of_week: number;
  session: SessionHalf;
};

export function SeverityIcon({ severity }: { severity: "error" | "warning" | "info" }) {
  if (severity === "error") return <ShieldAlert className="h-3.5 w-3.5 text-destructive" />;
  if (severity === "warning") return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
  return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
}
