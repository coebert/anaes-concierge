import { memo, useMemo, useState } from "react";
import { buildSearchTokens, cellMatchesSearch } from "@/lib/calendar-search";
import { filterAssignmentsForCell } from "@/features/clwrota/me-cell-visibility";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  listActiveStaffSafe,
  listStaffByIdsSafe,
} from "@/features/staff/staff-directory.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Info,
  User,
} from "lucide-react";
import { cn, parseDateLocal, toISODateLocal, formatDateGB, formatDateWithWeekdayGB } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import { specialtyTone, specialtyColorKey } from "@/lib/specialty-colors";

type SessionHalf = "am" | "pm";

// Trainee levels too junior to ever genuinely run a list solo. Kept in sync
// with JUNIOR_LEVELS in src/lib/solo-stats.ts — an unmatched entry means the
// calendar and the solo-stats aggregator would disagree.
const JUNIOR_TRAINEE_LEVELS = new Set([
  "FY2", "ACCS", "CT1", "CT2", "ST1", "ST2",
]);

export function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function addDays(d: Date, n: number) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
export function iso(d: Date) { return toISODateLocal(d); }
export function fmt(d: Date) {
  // British DD/MM/YYYY with weekday context, e.g. "Mon 26/05/2026".
  return formatDateWithWeekdayGB(d);
}

export type ViewMode = "day" | "week" | "month";

/**
 * Small pill used to mark AM / PM session columns and labels.
 * Distinct tones for AM (sky) vs PM (indigo) help scanning the grid quickly.
 */
export function SessionChip({
  half,
  active = false,
  className,
}: {
  half: "am" | "pm";
  active?: boolean;
  className?: string;
}) {
  const isAm = half === "am";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] tabular-nums transition-colors",
        isAm
          ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
        active &&
          (isAm
            ? "bg-sky-500 text-white border-sky-500 shadow-sm"
            : "bg-indigo-500 text-white border-indigo-500 shadow-sm"),
        className,
      )}
    >
      {half.toUpperCase()}
    </span>
  );
}

export function startOfMonth(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function endOfMonth(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function buildDays(anchor: Date, mode: ViewMode, includeWeekend = false): Date[] {
  if (mode === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  if (mode === "month") {
    const start = startOfMonth(anchor);
    const end = endOfMonth(anchor);
    const out: Date[] = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const dow = d.getDay();
      if (!includeWeekend && (dow === 0 || dow === 6)) continue;
      out.push(new Date(d));
    }
    return out;
  }
  const ws = startOfWeek(anchor);
  const len = includeWeekend ? 7 : 5;
  return Array.from({ length: len }, (_, i) => addDays(ws, i));
}

export function shiftAnchor(anchor: Date, mode: ViewMode, dir: 1 | -1): Date {
  if (mode === "day") return addDays(anchor, dir);
  if (mode === "week") return addDays(anchor, dir * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

export function ViewModeToggle({
  mode, onChange,
}: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-md border">
      {(["day", "week", "month"] as ViewMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={cn(
            "px-3 py-1 text-xs font-medium capitalize first:rounded-l-md last:rounded-r-md",
            mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export function PeriodNav({
  anchor, mode, onChange,
}: { anchor: Date; mode: ViewMode; onChange: (d: Date) => void }) {
  const label = (() => {
    if (mode === "day") {
      // British DD/MM/YYYY with full weekday, e.g. "Monday, 26/05/2026".
      // eslint-disable-next-line no-restricted-syntax -- weekday name only; numeric date comes from formatDateGB.
      const wd = anchor.toLocaleDateString("en-GB", { weekday: "long" });
      return `${wd}, ${formatDateGB(anchor)}`;
    }
    // Month-only navigation label (e.g. "May 2026") — not a full date.
    // eslint-disable-next-line no-restricted-syntax
    if (mode === "month") return anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const ws = startOfWeek(anchor);
    return `Week of ${fmt(ws)}`;
  })();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onChange(shiftAnchor(anchor, mode, -1))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div className="flex-1 min-w-[140px] rounded-md border px-3 py-1 text-xs font-medium tabular-nums text-center sm:flex-none sm:min-w-[180px]">
        {label}
      </div>
      <Button variant="outline" size="sm" onClick={() => onChange(shiftAnchor(anchor, mode, 1))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onChange(new Date())}>
        Today
      </Button>
    </div>
  );
}

export function WeekPicker({
  weekStart, onChange, days,
}: {
  weekStart: Date; onChange: (d: Date) => void; days?: 5 | 7;
}) {
  void days;
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onChange(addDays(weekStart, -7))}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Input
        type="date" value={iso(weekStart)}
        onChange={(e) => {
          const d = parseDateLocal(e.target.value);
          if (d) onChange(startOfWeek(d));
        }}
        className="h-8 w-40"
      />
      <Button variant="outline" size="sm" onClick={() => onChange(addDays(weekStart, 7))}>
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onChange(startOfWeek(new Date()))}>
        This week
      </Button>
    </div>
  );
}

/* --------------------- Global read-only grid --------------------- */

type StaffLite = {
  id: string;
  full_name: string;
  grade: string | null;
  training_level: string | null;
};

type TheatreAssignModel = {
  id: string;
  staffId: string;
  fullName: string;
  grade: string | null;
  trainingLevel: string | null;
  roleOnList: string;
  isSoloTrainee: boolean;
};

type TheatreCellModel = {
  key: string;
  isPm: boolean;
  hasSession: boolean;
  isNonSag: boolean;
  spec: string | undefined;
  tone: ReturnType<typeof specialtyTone>;
  surgicalConsultant: string | null;
  assigns: TheatreAssignModel[];
  parts: string[];
};

export type MedicalExaminerDetails = {
  assignmentId: string;
  sessionDate: string;
  session: SessionHalf;
  dutyType: string;
  clwrotaExternalId: string | null;
  source: string;
  roleOnList: string;
  notes: string | null;
  extraType: string | null;
  locallyModified: boolean;
  isNonSag: boolean;
  createdAt: string;
  updatedAt: string;
};

type StaffListAssignModel = {
  id: string;
  staffId: string;
  fullName: string;
  grade: string | null;
  trainingLevel: string | null;
  tag?: string | null;
  medicalExaminer?: MedicalExaminerDetails;
};

type StaffListCellModel = {
  key: string;
  isPm: boolean;
  assigns: StaffListAssignModel[];
  parts: string[];
};

type NhhCellModel = {
  key: string;
  staff: Array<{ id: string; fullName: string }>;
  parts: string[];
};

type NightCellModel = {
  key: string;
  staff: Array<{ id: string; fullName: string; grade: string | null; tag: string | null }>;
  parts: string[];
};

const TheatreCellContent = memo(function TheatreCellContent({
  model,
}: {
  model: TheatreCellModel;
}) {
  if (!model.hasSession) {
    return <div className="text-muted-foreground/40 text-[10px]">—</div>;
  }
  const { spec, tone, surgicalConsultant, assigns, isNonSag } = model;
  return (
    <div className="space-y-1">
      {isNonSag && (
        <Badge
          variant="outline"
          className="text-[9px] border-amber-500/60 bg-warning-muted text-warning"
          title="NHH list covered as part of NHS job plan (non-SAG)"
        >
          Non-SAG
        </Badge>
      )}
      {spec && <div className={cn("font-bold truncate", tone.label)}>{spec}</div>}
      {surgicalConsultant && (
        <div className="text-[10px] text-muted-foreground truncate">
          {surgicalConsultant}
        </div>
      )}
      {assigns.map((a) => {
        const isConsultant = a.grade === "consultant";
        const isTrainee = a.grade === "trainee";
        const showRoleBadge = !(
          a.roleOnList === "solo" && (isConsultant || !a.isSoloTrainee)
        );
        return (
          <Link
            key={a.id}
            to="/calendar/staff/$staffId"
            params={{ staffId: a.staffId }}
            className={cn(
              "block truncate text-[10px] hover:underline",
              isConsultant && "font-bold",
              isTrainee && "text-blue-600 dark:text-blue-400",
            )}
          >
            {showRoleBadge && (
              <Badge
                variant={a.roleOnList === "supervising" ? "default" : "outline"}
                className={cn(
                  "mr-1 px-1 py-0 text-[9px]",
                  a.roleOnList === "solo" &&
                    "bg-yellow-400 text-black border-yellow-500 hover:bg-yellow-400",
                )}
              >
                {a.roleOnList}
              </Badge>
            )}
            {a.fullName}
            {isTrainee ? ` (${a.trainingLevel || "Level unknown"})` : ""}
          </Link>
        );
      })}
    </div>
  );
});

const StaffListCellContent = memo(function StaffListCellContent({
  model,
}: {
  model: StaffListCellModel;
}) {
  if (model.assigns.length === 0) {
    return <div className="text-muted-foreground/40 text-[10px]">—</div>;
  }
  return (
    <div className="space-y-1">
      {model.assigns.map((a) => {
        const isConsultant = a.grade === "consultant";
        const isTrainee = a.grade === "trainee";
        return (
          <div key={a.id} className="flex items-center gap-1 min-w-0">
            <Link
              to="/calendar/staff/$staffId"
              params={{ staffId: a.staffId }}
              className={cn(
                "block truncate text-[10px] hover:underline flex-1 min-w-0",
                isConsultant && "font-bold",
                isTrainee && "text-blue-600 dark:text-blue-400",
              )}
            >
              {a.tag && (
                <Badge variant="outline" className="mr-1 px-1 py-0 text-[9px]">
                  {a.tag}
                </Badge>
              )}
              {a.fullName}
              {isTrainee ? ` (${a.trainingLevel || "Level unknown"})` : ""}
            </Link>
            {a.medicalExaminer && (
              <MedicalExaminerDetailsDialog
                details={a.medicalExaminer}
                staffName={a.fullName}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

const SESSION_TIMES: Record<SessionHalf, { start: string; end: string; label: string }> = {
  am: { start: "08:00", end: "13:00", label: "AM (08:00–13:00)" },
  pm: { start: "13:00", end: "18:00", label: "PM (13:00–18:00)" },
};

const MedicalExaminerDetailsDialog = memo(function MedicalExaminerDetailsDialog({
  details,
  staffName,
}: {
  details: MedicalExaminerDetails;
  staffName: string;
}) {
  const times = SESSION_TIMES[details.session];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Medical examiner session details"
          data-testid="medical-examiner-details-trigger"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Info className="h-3 w-3" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid="medical-examiner-details-panel">
        <DialogHeader>
          <DialogTitle>Medical examiner session</DialogTitle>
          <DialogDescription>
            {staffName} — {formatDateWithWeekdayGB(parseDateLocal(details.sessionDate))}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Session</dt>
          <dd className="font-medium">{times.label}</dd>
          <dt className="text-muted-foreground">Start time</dt>
          <dd className="font-mono">{times.start}</dd>
          <dt className="text-muted-foreground">End time</dt>
          <dd className="font-mono">{times.end}</dd>
          <dt className="text-muted-foreground">Duty type</dt>
          <dd className="font-medium">{details.dutyType}</dd>
          <dt className="text-muted-foreground">Role</dt>
          <dd>{details.roleOnList}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd>
            {details.source}
            {details.locallyModified && (
              <Badge variant="outline" className="ml-2 text-[9px]">
                Locally modified
              </Badge>
            )}
          </dd>
          <dt className="text-muted-foreground">CLWRota ID</dt>
          <dd className="font-mono break-all">
            {details.clwrotaExternalId ?? <span className="text-muted-foreground">—</span>}
          </dd>
          {details.extraType && (
            <>
              <dt className="text-muted-foreground">Extra type</dt>
              <dd>{details.extraType}</dd>
            </>
          )}
          {details.isNonSag && (
            <>
              <dt className="text-muted-foreground">Flags</dt>
              <dd>
                <Badge variant="outline" className="text-[9px]">Non-SAG</Badge>
              </dd>
            </>
          )}
          {details.notes && (
            <>
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap">{details.notes}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Synced</dt>
          <dd className="text-muted-foreground">
            {new Date(details.updatedAt).toLocaleString("en-GB")}
          </dd>
        </dl>
      </DialogContent>
    </Dialog>
  );
});

const NhhCellContent = memo(function NhhCellContent({
  model,
}: {
  model: NhhCellModel;
}) {
  if (model.staff.length === 0) {
    return <div className="text-muted-foreground/40 text-[10px]">—</div>;
  }
  return (
    <div className="space-y-1">
      <Badge
        variant="outline"
        className="px-1 py-0 text-[9px] border-purple-500 text-purple-700 dark:text-purple-300"
      >
        OOH
      </Badge>
      {model.staff.map((s) => (
        <Link
          key={s.id}
          to="/calendar/staff/$staffId"
          params={{ staffId: s.id }}
          className="block truncate text-[10px] font-bold hover:underline"
        >
          {s.fullName}
        </Link>
      ))}
    </div>
  );
});

const NightCellContent = memo(function NightCellContent({
  model,
}: {
  model: NightCellModel;
}) {
  if (model.staff.length === 0) {
    return <div className="text-muted-foreground/40 text-[10px]">—</div>;
  }
  return (
    <div className="space-y-1">
      <Badge
        variant="outline"
        className="px-1 py-0 text-[9px] border-indigo-500 text-indigo-700 dark:text-indigo-300"
      >
        Night
      </Badge>
      {model.staff.map((s) => {
        const isConsultant = s.grade === "consultant";
        const isTrainee = s.grade === "trainee";
        return (
          <Link
            key={s.id + (s.tag ?? "")}
            to="/calendar/staff/$staffId"
            params={{ staffId: s.id }}
            className={cn(
              "block truncate text-[10px] hover:underline",
              isConsultant && "font-bold",
              isTrainee && "text-blue-600 dark:text-blue-400",
            )}
          >
            {s.tag && (
              <Badge variant="outline" className="mr-1 px-1 py-0 text-[9px]">
                {s.tag}
              </Badge>
            )}
            {s.fullName}
          </Link>
        );
      })}
    </div>
  );
});

export function GlobalWeekGrid({
  weekStart,
  days: daysProp,
  searchQuery = "",
}: {
  weekStart: Date;
  days?: Date[];
  searchQuery?: string;
}) {
  const days = useMemo(
    () => daysProp ?? Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart, daysProp],
  );
  const startIso = iso(days[0]);
  const endIso = iso(days[days.length - 1]);

  const searchTokens = useMemo(() => buildSearchTokens(searchQuery), [searchQuery]);

  const { data: theatres } = useQuery({
    queryKey: ["theatres-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres").select("id,name,kind,sort_order")
        .eq("active", true).order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: sessions } = useQuery({
    queryKey: ["theatre-sessions", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,session,session_date,surgical_consultant,specialty_id,is_non_sag")
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return data;
    },
  });

  const { data: assignments } = useQuery({
    queryKey: ["assignments", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,theatre_session_id,role_on_list,supervisor_id")
        .eq("duty_type", "theatre")
        .in("session", ["am", "pm"])
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: SessionHalf; session_date: string;
        theatre_session_id: string | null; role_on_list: string; supervisor_id: string | null;
      }>;
    },
  });

  const { data: nhhOncall } = useQuery({
    queryKey: ["nhh-oncall", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date")
        .eq("duty_type", "nhh_oncall")
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: string; session_date: string;
      }>;
    },
  });

  const { data: spaAdmin } = useQuery({
    queryKey: ["spa-admin", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,duty_type,clwrota_external_id,source,role_on_list,notes,extra_type,locally_modified,is_non_sag,created_at,updated_at")
        .or("duty_type.in.(spa,admin,medical_examiner),and(duty_type.eq.teaching,notes.ilike.Tutorial:%25)")
        .in("session", ["am", "pm"])
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []).map((r) => ({
        ...r,
        // Re-map teaching-tutorial rows onto a synthetic "tutorial" bucket
        // so the calendar row config filter (filterAssignmentsForCell) can
        // find them without leaking generic teaching blocks into the row.
        duty_type:
          r.duty_type === "teaching" && (r.notes ?? "").startsWith("Tutorial:")
            ? "tutorial"
            : r.duty_type,
      })) as Array<{
        id: string; staff_id: string; session: SessionHalf; session_date: string;
        duty_type: "spa" | "admin" | "medical_examiner" | "tutorial";
        clwrota_external_id: string | null;
        source: string;
        role_on_list: string;
        notes: string | null;
        extra_type: string | null;
        locally_modified: boolean;
        is_non_sag: boolean;
        created_at: string;
        updated_at: string;
      }>;
    },
  });

  const extraDutyTypes = useMemo(
    () => [
      "consultant_in_charge",
      "obstetrics", "obstetrics_2nd",
      "icu_consultant_oncall", "icu_ct2_plus", "icu_trainee",
      "general_consultant_oncall", "registrar_oncall", "sho_oncall",
    ] as const,
    [],
  );
  const { data: extraDuties } = useQuery({
    queryKey: ["extra-duties", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,duty_type")
        .in("duty_type", [...extraDutyTypes])
        .in("session", ["am", "pm"])
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: SessionHalf; session_date: string;
        duty_type: string;
      }>;
    },
  });

  // Night on-call — separate row spanning the whole day. Covers general/ICU
  // consultants and registrar/SHO cover for the night shift (excludes NHH,
  // which has its own dedicated row above).
  const nightOnCallDutyTypes = useMemo(
    () => [
      "general_consultant_oncall",
      "icu_consultant_oncall",
      "registrar_oncall",
      "sho_oncall",
    ] as const,
    [],
  );
  const { data: nightOnCall } = useQuery({
    queryKey: ["night-oncall", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,duty_type")
        .in("duty_type", [...nightOnCallDutyTypes])
        .eq("session", "night")
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; staff_id: string; session: string; session_date: string;
        duty_type: string;
      }>;
    },
  });




  const listActive = useServerFn(listActiveStaffSafe);
  const { data: staff } = useQuery({
    queryKey: ["staff-active-with-grade-safe"],
    queryFn: () => listActive(),
  });

  const { data: specs } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name");
      if (error) throw error;
      return data;
    },
  });

  // Stable lookup map of staff by id. Recomputed only when the staff list changes.
  const staffMap = useMemo(() => {
    const m = new Map<string, StaffLite>();
    for (const s of (staff ?? []) as StaffLite[]) m.set(s.id, s);
    return m;
  }, [staff]);
  const specMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of specs ?? []) m.set(s.id, s.name);
    return m;
  }, [specs]);

  const gradeRank = (g: string | null | undefined) =>
    g === "consultant" ? 0 : g === "sas" ? 1 : g === "trainee" ? 2 : 3;

  // Precompute per-theatre rows of cell models. Token changes do NOT invalidate
  // this — only the underlying data does — so memoized cell content components
  // can bail out and only the outer <td> reflows the dim class while typing.
  const theatreRows = useMemo(() => {
    type Theatre = NonNullable<typeof theatres>[number];
    if (!theatres) return [] as Array<{ theatre: Theatre; cells: TheatreCellModel[] }>;
    return theatres.map((t) => {
      const cells: TheatreCellModel[] = [];
      for (const d of days) {
        const dayIso = iso(d);
        for (const sh of ["am", "pm"] as SessionHalf[]) {
          const ts = sessions?.find(
            (x) => x.theatre_id === t.id && x.session_date === dayIso && x.session === sh,
          );
          const rawAssigns = ts
            ? (assignments ?? []).filter((a) => a.theatre_session_id === ts.id)
            : [];
          const sortedAssigns = [...rawAssigns].sort(
            (a, b) =>
              gradeRank(staffMap.get(a.staff_id)?.grade) -
              gradeRank(staffMap.get(b.staff_id)?.grade),
          );
          const hasSupervisor = sortedAssigns.some((x) => {
            const g = staffMap.get(x.staff_id)?.grade;
            return g === "consultant" || g === "sas";
          });
          const assignModels: TheatreAssignModel[] = sortedAssigns.map((a) => {
            const sp = staffMap.get(a.staff_id);
            const isTrainee = sp?.grade === "trainee";
            const level = (sp?.training_level ?? "").trim().toUpperCase().replace(/\s+/g, "");
            const isJunior = JUNIOR_TRAINEE_LEVELS.has(level);
            return {
              id: a.id,
              staffId: a.staff_id,
              fullName: sp?.full_name ?? "—",
              grade: sp?.grade ?? null,
              trainingLevel: sp?.training_level ?? null,
              roleOnList: a.role_on_list,
              isSoloTrainee:
                !!isTrainee &&
                a.role_on_list === "solo" &&
                !a.supervisor_id &&
                !hasSupervisor &&
                !isJunior,
            };
          });
          const spec = ts ? specMap.get(ts.specialty_id ?? "") : undefined;
          const parts: string[] = [];
          if (spec) parts.push(spec);
          if (ts?.surgical_consultant) parts.push(ts.surgical_consultant);
          for (const a of assignModels) parts.push(a.fullName);
          cells.push({
            key: t.id + dayIso + sh,
            isPm: sh === "pm",
            hasSession: !!ts,
            isNonSag: !!ts?.is_non_sag,
            spec,
            tone: specialtyTone(spec ?? null),
            surgicalConsultant: ts?.surgical_consultant ?? null,
            assigns: assignModels,
            parts,
          });
        }
      }
      return { theatre: t, cells };
    });
  }, [theatres, days, sessions, assignments, staffMap, specMap]);

  const spaAdminRowConfigs = useMemo(
    () =>
      [
        { key: "spa", label: "SPA", sub: "Supporting prof. activities", tint: "bg-emerald-500/5" },
        { key: "admin", label: "Admin", sub: "Administrative time", tint: "bg-sky-500/5" },
        { key: "medical_examiner", label: "Medical examiner", sub: "ME session", tint: "bg-violet-500/5" },
        { key: "tutorial", label: "Tutorials", sub: "Tutorial / lecture delivery", tint: "bg-amber-500/5" },
      ] as const,
    [],
  );

  const spaAdminRows = useMemo(() => {
    return spaAdminRowConfigs.map((row) => {
      const cells: StaffListCellModel[] = [];
      for (const d of days) {
        const dayIso = iso(d);
        for (const sh of ["am", "pm"] as SessionHalf[]) {
          const raw = filterAssignmentsForCell(spaAdmin, row.key, dayIso, sh);
          const sorted = [...raw].sort(
            (a, b) =>
              gradeRank(staffMap.get(a.staff_id)?.grade) -
              gradeRank(staffMap.get(b.staff_id)?.grade),
          );
          const assigns: StaffListAssignModel[] = sorted.map((a) => {
            const sp = staffMap.get(a.staff_id);
            return {
              id: a.id,
              staffId: a.staff_id,
              fullName: sp?.full_name ?? "—",
              grade: sp?.grade ?? null,
              trainingLevel: sp?.training_level ?? null,
              medicalExaminer:
                a.duty_type === "medical_examiner"
                  ? {
                      assignmentId: a.id,
                      sessionDate: a.session_date,
                      session: a.session,
                      dutyType: a.duty_type,
                      clwrotaExternalId: a.clwrota_external_id,
                      source: a.source,
                      roleOnList: a.role_on_list,
                      notes: a.notes,
                      extraType: a.extra_type,
                      locallyModified: a.locally_modified,
                      isNonSag: a.is_non_sag,
                      createdAt: a.created_at,
                      updatedAt: a.updated_at,
                    }
                  : undefined,
            };
          });
          cells.push({
            key: row.key + dayIso + sh,
            isPm: sh === "pm",
            assigns,
            parts: assigns.map((a) => a.fullName),
          });
        }
      }
      return { row, cells };
    });
  }, [spaAdminRowConfigs, days, spaAdmin, staffMap]);

  const extraRowConfigs = useMemo(
    () =>
      [
        {
          key: "consultant_in_charge",
          label: "Consultant in charge",
          sub: "Site lead for the session",
          tint: "bg-rose-500/5",
          duties: ["consultant_in_charge"],
        },
        {
          key: "obstetrics",
          label: "Obstetrics / Labour ward",
          sub: "1st + 2nd on-call",
          tint: "bg-pink-500/5",
          duties: ["obstetrics", "obstetrics_2nd"],
        },
        {
          key: "icu",
          label: "ICU",
          sub: "Consultant + trainee cover",
          tint: "bg-cyan-500/5",
          duties: ["icu_consultant_oncall", "icu_ct2_plus", "icu_trainee"],
        },
        {
          key: "oncall",
          label: "On-call",
          sub: "General hospital cover",
          tint: "bg-amber-500/5",
          duties: ["general_consultant_oncall", "registrar_oncall", "sho_oncall"],
        },
      ] as const,
    [],
  );

  const dutyTag = (duty: string): string | null => {
    switch (duty) {
      case "obstetrics_2nd": return "2nd";
      case "icu_consultant_oncall": return "Cons";
      case "icu_ct2_plus": return "CT2+";
      case "icu_trainee": return "Trn";
      case "general_consultant_oncall": return "Cons";
      case "registrar_oncall": return "Reg";
      case "sho_oncall": return "SHO";
      default: return null;
    }
  };

  const extraRows = useMemo(() => {
    return extraRowConfigs.map((row) => {
      const cells: StaffListCellModel[] = [];
      for (const d of days) {
        const dayIso = iso(d);
        for (const sh of ["am", "pm"] as SessionHalf[]) {
          const raw = (extraDuties ?? []).filter(
            (a) =>
              (row.duties as readonly string[]).includes(a.duty_type) &&
              a.session_date === dayIso &&
              a.session === sh,
          );
          const sorted = [...raw].sort(
            (a, b) =>
              gradeRank(staffMap.get(a.staff_id)?.grade) -
              gradeRank(staffMap.get(b.staff_id)?.grade),
          );
          const assigns: StaffListAssignModel[] = sorted.map((a) => {
            const sp = staffMap.get(a.staff_id);
            return {
              id: a.id,
              staffId: a.staff_id,
              fullName: sp?.full_name ?? "—",
              grade: sp?.grade ?? null,
              trainingLevel: sp?.training_level ?? null,
              tag: dutyTag(a.duty_type),
            };
          });
          cells.push({
            key: row.key + dayIso + sh,
            isPm: sh === "pm",
            assigns,
            parts: assigns.map((a) => a.fullName),
          });
        }
      }
      return { row, cells };
    });
  }, [extraRowConfigs, days, extraDuties, staffMap]);

  const nhhRow = useMemo(() => {
    const cells: NhhCellModel[] = [];
    for (const d of days) {
      const dayIso = iso(d);
      const dayAssigns = (nhhOncall ?? []).filter((a) => a.session_date === dayIso);
      const seen = new Set<string>();
      const uniqueStaff: Array<{ id: string; fullName: string }> = [];
      for (const a of dayAssigns) {
        if (seen.has(a.staff_id)) continue;
        seen.add(a.staff_id);
        uniqueStaff.push({
          id: a.staff_id,
          fullName: staffMap.get(a.staff_id)?.full_name ?? "—",
        });
      }
      cells.push({
        key: "nhh-" + dayIso,
        staff: uniqueStaff,
        parts: uniqueStaff.map((s) => s.fullName),
      });
    }
    return cells;
  }, [days, nhhOncall, staffMap]);

  const nightRow = useMemo(() => {
    const cells: NightCellModel[] = [];
    for (const d of days) {
      const dayIso = iso(d);
      const dayAssigns = (nightOnCall ?? []).filter((a) => a.session_date === dayIso);
      const sorted = [...dayAssigns].sort(
        (a, b) =>
          gradeRank(staffMap.get(a.staff_id)?.grade) -
          gradeRank(staffMap.get(b.staff_id)?.grade),
      );
      const seen = new Set<string>();
      const staffList: NightCellModel["staff"] = [];
      for (const a of sorted) {
        const key = a.staff_id + ":" + a.duty_type;
        if (seen.has(key)) continue;
        seen.add(key);
        const sp = staffMap.get(a.staff_id);
        staffList.push({
          id: a.staff_id,
          fullName: sp?.full_name ?? "—",
          grade: sp?.grade ?? null,
          tag: dutyTag(a.duty_type),
        });
      }
      cells.push({
        key: "night-" + dayIso,
        staff: staffList,
        parts: staffList.map((s) => s.fullName),
      });
    }
    return cells;
  }, [days, nightOnCall, staffMap]);



  // Dimming helper — cheap string scan, runs per-cell on each keystroke but
  // only toggles a className on the outer <td>; memoized cell-content
  // components below skip re-rendering entirely.
  const dimClass = (hasContent: boolean, parts: string[]) => {
    if (searchTokens.length === 0) return undefined;
    if (!hasContent) return "opacity-20";
    return cellMatchesSearch(searchTokens, parts) ? undefined : "opacity-20";
  };

  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              <th className="border-b border-r p-2 text-left font-medium w-28">Theatre</th>
              {days.map((d) => (
                <th key={iso(d)} colSpan={2} className="border-b border-r p-2 text-center font-medium">
                  {fmt(d)}
                </th>
              ))}
            </tr>
            <tr className="text-muted-foreground">
              <th className="border-b border-r p-1"></th>
              {days.flatMap((d) => [
                <th key={iso(d) + "am"} className="border-b p-1 font-normal">
                  <SessionChip half="am" />
                </th>,
                <th key={iso(d) + "pm"} className="border-b border-r p-1 font-normal">
                  <SessionChip half="pm" />
                </th>,
              ])}
            </tr>

          </thead>
          <tbody>
            {theatreRows.map(({ theatre: t, cells }) => (
              <tr key={t.id} className="align-top">
                <td className="border-r p-2 font-medium whitespace-nowrap">
                  {t.name}
                  <div className="text-[10px] text-muted-foreground">
                    {t.kind === "main"
                      ? "Main"
                      : t.kind === "day_surgery"
                      ? "Day surgery"
                      : "Private (NHH)"}
                  </div>
                </td>
                {cells.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "min-w-[110px] border-b p-1.5 align-top transition-colors",
                      c.isPm ? "border-r" : "border-r border-r-border/30",
                      c.hasSession && c.tone.cell,
                      dimClass(c.hasSession, c.parts),
                    )}
                  >
                    <TheatreCellContent model={c} />
                  </td>
                ))}
              </tr>
            ))}
            {/* SPA and Admin sessions — non-clinical, broken down per AM/PM. */}
            {spaAdminRows.map(({ row, cells }) => (
              <tr key={row.key} className={cn("align-top", row.tint)}>
                <td className="border-r border-t p-2 font-medium whitespace-nowrap">
                  {row.label}
                  <div className="text-[10px] text-muted-foreground">{row.sub}</div>
                </td>
                {cells.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "min-w-[110px] border-b border-t p-1.5 align-top",
                      c.isPm ? "border-r" : "border-r border-r-border/30",
                      dimClass(c.assigns.length > 0, c.parts),
                    )}
                  >
                    <StaffListCellContent model={c} />
                  </td>
                ))}
              </tr>
            ))}
            {/* Consultant in charge / Obstetrics / ICU / On-call rows. */}
            {extraRows.map(({ row, cells }) => (
              <tr key={row.key} className={cn("align-top", row.tint)}>
                <td className="border-r border-t p-2 font-medium whitespace-nowrap">
                  {row.label}
                  <div className="text-[10px] text-muted-foreground">{row.sub}</div>
                </td>
                {cells.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "min-w-[110px] border-b border-t p-1.5 align-top",
                      c.isPm ? "border-r" : "border-r border-r-border/30",
                      dimClass(c.assigns.length > 0, c.parts),
                    )}
                  >
                    <StaffListCellContent model={c} />
                  </td>
                ))}
              </tr>
            ))}
            {/* NHH 1st On-call — out-of-hours cover for New Hall Hospital.
                Spans the whole day so we render one cell per date (colSpan=2). */}
            <tr className="align-top bg-purple-500/5">
              <td className="border-r border-t p-2 font-medium whitespace-nowrap">
                NHH 1st On-call
                <div className="text-[10px] text-muted-foreground">Out of hours</div>
              </td>
              {nhhRow.map((c) => (
                <td
                  key={c.key}
                  colSpan={2}
                  className={cn(
                    "min-w-[110px] border-b border-t border-r p-1.5 align-top",
                    dimClass(c.staff.length > 0, c.parts),
                  )}
                >
                  <NhhCellContent model={c} />
                </td>
              ))}
            </tr>
            {/* Night on-call — full-day row grouping general/ICU consultant
                and registrar/SHO night cover. NHH nights render separately
                in the row above. */}
            <tr className="align-top bg-indigo-500/5">
              <td className="border-r border-t p-2 font-medium whitespace-nowrap">
                Night on-call
                <div className="text-[10px] text-muted-foreground">Overnight cover</div>
              </td>
              {nightRow.map((c) => (
                <td
                  key={c.key}
                  colSpan={2}
                  className={cn(
                    "min-w-[110px] border-b border-t border-r p-1.5 align-top",
                    dimClass(c.staff.length > 0, c.parts),
                  )}
                >
                  <NightCellContent model={c} />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}


/* --------------------- Per-staff week view --------------------- */

export function StaffWeekView({ staffId }: { staffId: string }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const toggleDay = (dayIso: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayIso)) next.delete(dayIso);
      else next.add(dayIso);
      return next;
    });
  };
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const startIso = iso(days[0]);
  const endIso = iso(days[days.length - 1]);

  const lookupStaff = useServerFn(listStaffByIdsSafe);
  const { data: profile } = useQuery({
    queryKey: ["profile-safe", staffId],
    queryFn: async () => {
      const rows = await lookupStaff({ data: { ids: [staffId] } });
      return rows[0] ?? null;
    },
  });

  const { data: assigns } = useQuery({
    queryKey: ["staff-assigns", staffId, startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,session,session_date,theatre_session_id,role_on_list,supervisor_id")
        .eq("staff_id", staffId)
        .gte("session_date", startIso).lte("session_date", endIso);
      if (error) throw error;
      return data;
    },
  });

  const sessionIds = (assigns ?? []).map((a) => a.theatre_session_id).filter(Boolean) as string[];
  const { data: ts } = useQuery({
    queryKey: ["staff-theatre-sessions", sessionIds],
    enabled: sessionIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,specialty_id,surgical_consultant,is_non_sag")
        .in("id", sessionIds);
      if (error) throw error;
      return data;
    },
  });

  const { data: theatres } = useQuery({
    queryKey: ["theatres-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres").select("id,name").order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: specs } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("specialties").select("id,name");
      if (error) throw error;
      return data;
    },
  });

  const { data: leave } = useQuery({
    queryKey: ["staff-leave", staffId, startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("id,type,status,start_date,end_date,half_day_start,half_day_end")
        .eq("staff_id", staffId)
        .lte("start_date", endIso).gte("end_date", startIso);
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2
            className={cn(
              "text-xl font-semibold",
              profile?.grade === "consultant" && "font-bold",
            )}
          >
            {profile?.full_name ?? "Staff member"}
            {profile?.grade === "trainee"
              ? ` (${profile?.training_level || "Level unknown"})`
              : ""}
          </h2>
          <p className="text-sm text-muted-foreground">
            {profile?.grade ?? "—"}
            {profile?.grade === "trainee" ? ` · ${profile?.training_level || "Level unknown"}` : ""}
          </p>
        </div>
        <WeekPicker weekStart={weekStart} onChange={setWeekStart} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {days.map((d) => {
          const dayIso = iso(d);
          const dayAssigns = assigns?.filter((a) => a.session_date === dayIso) ?? [];
          const dayLeave = leave?.filter(
            (l) => l.start_date <= dayIso && l.end_date >= dayIso,
          ) ?? [];
          const isToday = dayIso === iso(new Date());
          const isExpanded = expandedDays.has(dayIso);
          return (
            <Card key={dayIso} className={cn(isToday && "ring-2 ring-primary")}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-sm font-medium">{fmt(d)}</div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isToday && <Badge variant="default" className="text-[9px]">Today</Badge>}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => toggleDay(dayIso)}
                      title={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                {dayLeave.map((l) => (
                  <div key={l.id} className="rounded bg-amber-500/10 p-2 text-xs">
                    <Badge variant="outline" className="mr-1">{l.type}</Badge>
                    <span className="text-muted-foreground">{l.status}</span>
                  </div>
                ))}
                {isExpanded ? (
                  <div className="grid grid-cols-1 gap-2">
                    {(["am", "pm"] as SessionHalf[]).map((sh) => {
                      const a = dayAssigns.find((x) => x.session === sh);
                      const session = a && ts?.find((s) => s.id === a.theatre_session_id);
                      const theatre = session && theatres?.find((t) => t.id === session.theatre_id);
                      const spec = session && specs?.find((s) => s.id === session.specialty_id);
                      const tone = specialtyTone(spec?.name ?? null);
                      return (
                        <div key={sh} className={cn("rounded border p-3 text-xs transition-colors", a && tone.cell)}>
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{sh}</div>
                          {a ? (
                            <div className="space-y-1">
                              <div className="min-w-0 truncate font-medium">{theatre?.name ?? "—"}</div>
                              {session?.is_non_sag && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] border-amber-500/60 bg-warning-muted text-warning"
                                  title="NHH list covered as part of NHS job plan (non-SAG)"
                                >
                                  Non-SAG
                                </Badge>
                              )}
                              {spec && <div className={cn("min-w-0 truncate font-medium", tone.label)}>{spec.name}</div>}
                              {session?.surgical_consultant && (
                                <div className="min-w-0 truncate text-muted-foreground">{session.surgical_consultant}</div>
                              )}
                              <Badge variant="outline" className="text-[9px]">
                                {a.role_on_list}
                              </Badge>
                            </div>
                          ) : (
                            <div className="text-muted-foreground/60">—</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {(["am", "pm"] as SessionHalf[]).map((sh) => {
                      const a = dayAssigns.find((x) => x.session === sh);
                      const session = a && ts?.find((s) => s.id === a.theatre_session_id);
                      const theatre = session && theatres?.find((t) => t.id === session.theatre_id);
                      return (
                        <div key={sh} className="flex items-center gap-2 text-xs">
                          <SessionChip half={sh} className="scale-90 origin-left" />
                          <span className="min-w-0 truncate">
                            {theatre?.name ?? <span className="text-muted-foreground/60">—</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------- Staff picker --------------------- */

export function StaffPicker({
  value, onChange,
}: { value?: string; onChange: (id: string) => void }) {
  const listActive = useServerFn(listActiveStaffSafe);
  const { data } = useQuery({
    queryKey: ["staff-active-safe"],
    queryFn: () => listActive(),
  });
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-64">
        <User className="mr-2 h-4 w-4" />
        <SelectValue placeholder="Jump to staff…" />
      </SelectTrigger>
      <SelectContent>
        {data
          ?.sort((a, b) => compareBySurname(a.full_name, b.full_name))
          .map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.full_name} {s.grade ? `(${s.grade})` : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* --------------------- Specialty colour legend --------------------- */

export function SpecialtyLegend() {
  const [open, setOpen] = useState(true);
  const { data: specs } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("specialties").select("id,name");
      if (error) throw error;
      return data;
    },
  });

  if (!specs?.length) return null;

  // Group by colour key so "Ortho", "Orthopedics", "Trauma" etc. share one swatch
  const groups = new Map<string, { key: string; names: string[]; tone: ReturnType<typeof specialtyTone> }>();
  for (const sp of specs) {
    const ck = specialtyColorKey(sp.name);
    const key = ck ?? "neutral";
    const existing = groups.get(key);
    if (existing) {
      existing.names.push(sp.name);
    } else {
      groups.set(key, { key, names: [sp.name], tone: specialtyTone(sp.name) });
    }
  }

  // Sort groups alphabetically by their first (canonical) name
  const sortedGroups = Array.from(groups.values()).sort((a, b) =>
    a.names[0].localeCompare(b.names[0]),
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-foreground hover:opacity-80 transition-opacity cursor-pointer">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>Specialties</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs mt-1.5">
          {sortedGroups.map((g) => {
            const label = g.names.sort((a, b) => a.localeCompare(b)).join(" / ");
            return (
              <span key={g.key} className="inline-flex items-center gap-1">
                <span className={cn("h-2.5 w-2.5 rounded-sm", g.tone.swatch)} />
                <span className={cn(g.tone.label)}>{label}</span>
              </span>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Legend describing every duty type rendered on the global calendar / staff-in-work
 * view. Lets users verify that Medical examiner sessions (and every other row)
 * are actually included in the filter, and shows what is deliberately excluded.
 */
export function DutyTypeLegend() {
  const [open, setOpen] = useState(false);
  const included: Array<{ label: string; sub: string; swatch: string }> = [
    { label: "Theatre lists", sub: "All theatre sessions (main, day surgery, private/NHH)", swatch: "bg-muted" },
    { label: "SPA", sub: "duty_type = spa · Supporting professional activities", swatch: "bg-emerald-500/40" },
    { label: "Admin", sub: "duty_type = admin · Administrative time", swatch: "bg-sky-500/40" },
    { label: "Medical examiner", sub: "duty_type = medical_examiner · AM/PM split from CLWRota", swatch: "bg-violet-500/40" },
    { label: "Consultant in charge", sub: "duty_type = consultant_in_charge", swatch: "bg-rose-500/40" },
    { label: "Obstetrics / Labour ward", sub: "duty_type = obstetrics, obstetrics_2nd", swatch: "bg-pink-500/40" },
    { label: "ICU", sub: "duty_type = icu (consultant + trainee)", swatch: "bg-cyan-500/40" },
    { label: "NHH 1st on-call", sub: "duty_type = nhh_oncall · Out-of-hours cover", swatch: "bg-purple-500/40" },
    { label: "Night on-call", sub: "General/ICU consultant + trainee night cover", swatch: "bg-slate-500/40" },
  ];
  const excluded: Array<{ label: string; sub: string }> = [
    { label: "Leave", sub: "Approved/pending leave is shown on staff views, not counted as duty" },
    { label: "Non-work markers", sub: "Blank cells indicate no scheduled duty" },
  ];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        data-testid="duty-type-legend-trigger"
        className="flex items-center gap-1 text-xs font-medium text-foreground hover:opacity-80 transition-opacity cursor-pointer"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>Duty types shown</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          data-testid="duty-type-legend-panel"
          className="mt-1.5 grid gap-3 text-xs sm:grid-cols-2"
        >
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Included in staff-in-work view
            </div>
            <ul className="space-y-1">
              {included.map((row) => (
                <li key={row.label} className="flex items-start gap-2" data-testid={`duty-legend-included-${row.label}`}>
                  <span className={cn("mt-1 h-2.5 w-2.5 rounded-sm shrink-0", row.swatch)} />
                  <span>
                    <span className="font-medium">{row.label}</span>
                    <span className="text-muted-foreground"> — {row.sub}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Not counted as duty
            </div>
            <ul className="space-y-1">
              {excluded.map((row) => (
                <li key={row.label} data-testid={`duty-legend-excluded-${row.label}`}>
                  <span className="font-medium">{row.label}</span>
                  <span className="text-muted-foreground"> — {row.sub}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
