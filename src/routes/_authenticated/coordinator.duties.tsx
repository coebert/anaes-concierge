import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDateLongGB, formatDateGB, parseDateLocal, todayISO } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/coordinator/duties")({
  component: DutiesPage,
});

type Slot = "am" | "pm" | "eve" | "night";
type DutyType =
  | "consultant_in_charge"
  | "obstetrics"
  | "obstetrics_2nd"
  | "icu_trainee"
  | "icu_ct2_plus"
  | "icu_consultant_oncall"
  | "general_consultant_oncall"
  | "registrar_oncall"
  | "sho_oncall";

interface DutyConfig {
  type: DutyType;
  label: string;
  slots: Slot[];
  description?: string;
}

const DUTY_CONFIG: DutyConfig[] = [
  { type: "consultant_in_charge", label: "Consultant in charge", slots: ["am", "pm"] },
  { type: "obstetrics", label: "Obstetrics", slots: ["am", "pm"] },
  { type: "obstetrics_2nd", label: "2nd Obstetric competent anaesthetist", slots: ["am", "pm"] },
  { type: "icu_trainee", label: "ICU trainees", slots: ["am", "pm"] },
  { type: "icu_ct2_plus", label: "ICU CT2 and above", slots: ["am", "pm"] },
  { type: "icu_consultant_oncall", label: "ICU consultant on-call", slots: ["am", "pm", "eve", "night"] },
  { type: "general_consultant_oncall", label: "General consultant on-call", slots: ["eve", "night"] },
  { type: "registrar_oncall", label: "Registrar on-call", slots: ["eve", "night"] },
  { type: "sho_oncall", label: "SHO on-call", slots: ["eve", "night"] },
];

const SLOT_LABEL: Record<Slot, string> = { am: "AM", pm: "PM", eve: "Eve", night: "Night" };

function startOfWeek(d: Date) {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // Monday-start
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function isoLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DutyRow {
  id: string;
  staff_id: string;
  session_date: string;
  session: Slot;
  duty_type: DutyType;
}

interface StaffRow {
  id: string;
  full_name: string;
  grade: string | null;
  rotation_end_date: string | null;
}

function DutiesPage() {
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(parseDateLocal(todayISO()) ?? new Date()));

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const startIso = isoLocal(days[0]);
  const endIso = isoLocal(days[6]);

  const { data: staff } = useQuery({
    queryKey: ["duties-staff-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,rotation_end_date")
        .eq("active", true)
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as StaffRow[];
    },
  });

  const { data: rows, refetch } = useQuery({
    queryKey: ["duty-assignments", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session_date,session,duty_type")
        .neq("duty_type", "theatre")
        .gte("session_date", startIso)
        .lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as DutyRow[];
    },
  });

  const { data: leave } = useQuery({
    queryKey: ["duties-leave", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("staff_id,start_date,end_date,status")
        .eq("status", "approved")
        .lte("start_date", endIso)
        .gte("end_date", startIso);
      if (error) throw error;
      return data ?? [];
    },
  });

  const staffName = (id: string) => staff?.find((s) => s.id === id)?.full_name ?? "—";
  const isOnLeave = (staffId: string, dateIso: string) =>
    (leave ?? []).some((l) => l.staff_id === staffId && l.start_date <= dateIso && l.end_date >= dateIso);

  const eligibleStaff = (duty: DutyConfig, dateIso: string): StaffRow[] => {
    if (!staff) return [];
    return staff.filter((s) => {
      // Trainees can't be allocated after their rotation end
      if (s.grade === "trainee" && s.rotation_end_date && s.rotation_end_date < dateIso) return false;
      // Grade gating
      switch (duty.type) {
        case "consultant_in_charge":
        case "icu_consultant_oncall":
        case "general_consultant_oncall":
          return s.grade === "consultant";
        case "obstetrics":
        case "obstetrics_2nd":
          return s.grade === "consultant" || s.grade === "sas" || s.grade === "trainee";
        case "icu_trainee":
          return s.grade === "trainee";
        case "icu_ct2_plus":
          return s.grade === "trainee" || s.grade === "sas";
        case "registrar_oncall":
          return s.grade === "trainee" || s.grade === "sas";
        case "sho_oncall":
          return s.grade === "trainee";
        default:
          return true;
      }
    });
  };

  const addMut = useMutation({
    mutationFn: async (args: { staff_id: string; session_date: string; session: Slot; duty_type: DutyType }) => {
      const { error } = await supabase.from("rota_assignments").insert({
        staff_id: args.staff_id,
        session_date: args.session_date,
        session: args.session,
        duty_type: args.duty_type,
        role_on_list: "on_call",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void refetch();
      qc.invalidateQueries({ queryKey: ["assignments"] });
      toast.success("Duty allocated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("rota_assignments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      void refetch();
      qc.invalidateQueries({ queryKey: ["assignments"] });
      toast.success("Duty cleared");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cellRows = (duty: DutyType, dateIso: string, slot: Slot) =>
    (rows ?? []).filter(
      (r) => r.duty_type === duty && r.session_date === dateIso && r.session === slot,
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>Duties &amp; on-call</CardTitle>
            <CardDescription>
              Week of {formatDateLongGB(startIso)}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => setAnchor(addDays(anchor, -7))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAnchor(startOfWeek(parseDateLocal(todayISO()) ?? new Date()))}>
              This week
            </Button>
            <Button variant="outline" size="icon" onClick={() => setAnchor(addDays(anchor, 7))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
      </Card>

      {DUTY_CONFIG.map((duty) => (
        <Card key={duty.type}>
          <CardHeader>
            <CardTitle className="text-base">{duty.label}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="w-24 p-2 text-left font-medium text-muted-foreground">Slot</th>
                  {days.map((d, i) => (
                    <th key={i} className="border-l p-2 text-left font-medium">
                      <div>{d.toLocaleDateString("en-GB", { weekday: "short" })}</div>
                      <div className="text-muted-foreground">{formatDateGB(isoLocal(d)).slice(0, 5)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {duty.slots.map((slot) => (
                  <tr key={slot} className="border-t">
                    <td className="p-2 align-top text-muted-foreground">{SLOT_LABEL[slot]}</td>
                    {days.map((d, i) => {
                      const dateIso = isoLocal(d);
                      const items = cellRows(duty.type, dateIso, slot);
                      return (
                        <td key={i} className="border-l p-1 align-top">
                          <div className="space-y-1">
                            {items.map((r) => (
                              <div
                                key={r.id}
                                className="flex items-center justify-between gap-1 rounded bg-muted px-2 py-1"
                              >
                                <span className="truncate">
                                  {staffName(r.staff_id)}
                                  {isOnLeave(r.staff_id, dateIso) && (
                                    <Badge variant="destructive" className="ml-1 text-[10px]">leave</Badge>
                                  )}
                                </span>
                                <button
                                  className="text-muted-foreground hover:text-destructive"
                                  onClick={() => removeMut.mutate(r.id)}
                                  aria-label="Remove"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                            <Select
                              value=""
                              onValueChange={(v) =>
                                addMut.mutate({
                                  staff_id: v,
                                  session_date: dateIso,
                                  session: slot,
                                  duty_type: duty.type,
                                })
                              }
                            >
                              <SelectTrigger className="h-7 text-xs">
                                <SelectValue placeholder="+ Assign" />
                              </SelectTrigger>
                              <SelectContent>
                                {eligibleStaff(duty, dateIso)
                                  .filter((s) => !items.some((it) => it.staff_id === s.id))
                                  .map((s) => (
                                    <SelectItem key={s.id} value={s.id}>
                                      {s.full_name}
                                      {s.grade ? ` · ${s.grade}` : ""}
                                      {isOnLeave(s.id, dateIso) ? " · on leave" : ""}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
