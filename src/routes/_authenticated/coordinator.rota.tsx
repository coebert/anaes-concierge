import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Plus, Trash2, AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { cn, parseDateLocal, formatDateLongGB } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import {
  validateAssignment, worstSeverity,
  type Issue, type Profile, type RotaRules,
} from "@/lib/rota-validation";

type SessionHalf = "am" | "pm";
type RotaRole =
  | "solo" | "supervised" | "supervising" | "on_call" | "non_clinical" | "teaching" | "admin_session";

export const Route = createFileRoute("/_authenticated/coordinator/rota")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/login" });
  },
  component: RotaGridGuard,
});

function RotaGridGuard() {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  if (!hasRole("admin")) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Only administrators can edit the rota.
        </CardContent>
      </Card>
    );
  }
  return <RotaGridPage />;
}

/* ---------- Date helpers ---------- */
function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
function iso(d: Date) { return d.toISOString().slice(0, 10); }
function fmt(d: Date) {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function RotaGridPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const startIso = iso(days[0]);
  const endIso = iso(days[days.length - 1]);

  const [cellOpen, setCellOpen] = useState<{
    theatreId: string; date: string; session: SessionHalf;
  } | null>(null);

  const { data: theatres } = useQuery({
    queryKey: ["theatres-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres")
        .select("id,name,kind,sort_order")
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: theatreSessions } = useQuery({
    queryKey: ["theatre-sessions", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,theatre_id,session,session_date,surgical_consultant,specialty_id")
        .gte("session_date", startIso)
        .lte("session_date", endIso);
      if (error) throw error;
      return data;
    },
  });

  const { data: specialtiesList } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });
  const specialtyName = (id: string | null) =>
    id ? specialtiesList?.find((s) => s.id === id)?.name : undefined;

  const { data: assignments } = useQuery({
    queryKey: ["assignments", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,theatre_session_id,role_on_list,supervisor_id")
        .gte("session_date", startIso)
        .lte("session_date", endIso);
      if (error) throw error;
      return data;
    },
  });

  // Wider window for TCS rolling checks (±21 days around the displayed week).
  const ctxStartIso = iso(addDays(days[0], -21));
  const ctxEndIso = iso(addDays(days[days.length - 1], 21));
  const { data: contextAssignments } = useQuery({
    queryKey: ["assignments-context", ctxStartIso, ctxEndIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,theatre_session_id,role_on_list")
        .gte("session_date", ctxStartIso)
        .lte("session_date", ctxEndIso);
      if (error) throw error;
      return data;
    },
  });

  const { data: staff } = useQuery({
    queryKey: ["staff-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,training_level,rotation_end_date")
        .eq("active", true)
        .order("full_name");
      if (error) throw error;
      return data as Profile[];
    },
  });

  const { data: rules } = useQuery({
    queryKey: ["rota-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_rules").select("*").eq("id", 1).maybeSingle();
      if (error) throw error;
      return (data ?? null) as RotaRules | null;
    },
  });

  const { data: jobPlans } = useQuery({
    queryKey: ["job-plans-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_plans")
        .select("staff_id,total_pas,dcc_pas,spa_pas,ltft,ltft_percentage,valid_from,valid_to");
      if (error) throw error;
      return data;
    },
  });

  const { data: leave } = useQuery({
    queryKey: ["leave-week", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("leave_requests")
        .select("staff_id,start_date,end_date,status")
        .lte("start_date", endIso)
        .gte("end_date", startIso);
      if (error) throw error;
      return data;
    },
  });

  const { data: fixedSessions } = useQuery({
    queryKey: ["fixed-sessions-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fixed_sessions")
        .select("staff_id,day_of_week,session");
      if (error) throw error;
      return data as { staff_id: string; day_of_week: number; session: SessionHalf }[];
    },
  });

  const staffName = (id: string | null) =>
    staff?.find((s) => s.id === id)?.full_name ?? "—";

  const cellSession = (theatreId: string, date: string, session: SessionHalf) =>
    theatreSessions?.find(
      (s) => s.theatre_id === theatreId && s.session_date === date && s.session === session,
    );

  const cellAssignments = (theatreSessionId: string | undefined) =>
    theatreSessionId
      ? assignments?.filter((a) => a.theatre_session_id === theatreSessionId) ?? []
      : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rota editor</h1>
          <p className="text-sm text-muted-foreground">
            Week of {fmt(days[0])} — click any cell to set the surgical list and assign anaesthetists.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input
            type="date" value={iso(weekStart)}
            onChange={(e) => setWeekStart(startOfWeek(new Date(e.target.value)))}
            className="h-8 w-40"
          />
          <Button variant="outline" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>
            This week
          </Button>
        </div>
      </div>

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
                  <th key={iso(d) + "am"} className="border-b p-1 font-normal">AM</th>,
                  <th key={iso(d) + "pm"} className="border-b border-r p-1 font-normal">PM</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {theatres?.map((t) => (
                <tr key={t.id} className="align-top">
                  <td className="border-r p-2 font-medium whitespace-nowrap">
                    {t.name}
                    <div className="text-[10px] text-muted-foreground">
                      {t.kind === "main" ? "Main" : "Day surgery"}
                    </div>
                  </td>
                  {days.flatMap((d) =>
                    (["am", "pm"] as SessionHalf[]).map((s) => {
                      const ts = cellSession(t.id, iso(d), s);
                      const assigns = cellAssignments(ts?.id);
                      const isPm = s === "pm";
                      return (
                        <td
                          key={t.id + iso(d) + s}
                          onClick={() =>
                            setCellOpen({ theatreId: t.id, date: iso(d), session: s })
                          }
                          className={cn(
                            "min-w-[110px] cursor-pointer border-b p-1.5 hover:bg-accent/40",
                            isPm ? "border-r" : "border-r border-r-border/30",
                          )}
                        >
                          {ts ? (
                            <div className="space-y-1">
                              {specialtyName(ts.specialty_id) && (
                                <div className="font-medium truncate">{specialtyName(ts.specialty_id)}</div>
                              )}
                              {ts.surgical_consultant && (
                                <div className="text-[10px] text-muted-foreground truncate">
                                  {ts.surgical_consultant}
                                </div>
                              )}
                              {assigns.map((a) => (
                                <div key={a.id} className="truncate text-[10px]">
                                  <Badge
                                    variant={a.role_on_list === "supervising" ? "default" : "outline"}
                                    className="mr-1 px-1 py-0 text-[9px]"
                                  >
                                    {a.role_on_list}
                                  </Badge>
                                  {staffName(a.staff_id)}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-muted-foreground/60 text-[10px]">+ add</div>
                          )}
                        </td>
                      );
                    }),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {cellOpen && (
        <CellDialog
          theatreId={cellOpen.theatreId}
          theatreName={theatres?.find((t) => t.id === cellOpen.theatreId)?.name ?? ""}
          date={cellOpen.date}
          session={cellOpen.session}
          onOpenChange={(o) => !o && setCellOpen(null)}
          staff={staff ?? []}
          weekDates={days.map(iso)}
          weekAssignments={assignments ?? []}
          contextAssignments={contextAssignments ?? []}
          jobPlans={jobPlans ?? []}
          leave={leave ?? []}
          fixedSessions={fixedSessions ?? []}
          rules={rules ?? DEFAULT_RULES}
        />
      )}
    </div>
  );
}

const DEFAULT_RULES: RotaRules = {
  sessions_per_pa: 1,
  max_sessions_per_week: 10,
  max_consecutive_days: 7,
  honour_fixed_sessions: true,
  allow_back_to_back_oncall: false,
};

/* ----------------------- Cell dialog ----------------------- */

function CellDialog({
  theatreId, theatreName, date, session, onOpenChange, staff,
  weekDates, weekAssignments, contextAssignments, jobPlans, leave, fixedSessions, rules,
}: {
  theatreId: string; theatreName: string; date: string; session: SessionHalf;
  onOpenChange: (o: boolean) => void;
  staff: Profile[];
  weekDates: string[];
  weekAssignments: {
    id: string; staff_id: string; session: SessionHalf; session_date: string;
    theatre_session_id: string | null; role_on_list: RotaRole;
  }[];
  contextAssignments: {
    id: string; staff_id: string; session: SessionHalf; session_date: string;
    theatre_session_id: string | null; role_on_list: RotaRole;
  }[];
  jobPlans: {
    staff_id: string; total_pas: number; dcc_pas: number; spa_pas: number;
    ltft: boolean; ltft_percentage: number | null; valid_from: string; valid_to: string | null;
  }[];
  leave: { staff_id: string; start_date: string; end_date: string; status: string }[];
  fixedSessions: { staff_id: string; day_of_week: number; session: SessionHalf }[];
  rules: RotaRules;
}) {
  const qc = useQueryClient();

  const { data: specialties } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });

  const { data: ts, refetch } = useQuery({
    queryKey: ["theatre-session", theatreId, date, session],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_sessions")
        .select("id,specialty_id,surgical_consultant,notes")
        .eq("theatre_id", theatreId)
        .eq("session_date", date)
        .eq("session", session)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [specialtyId, setSpecialtyId] = useState<string>("");
  const [consultant, setConsultant] = useState<string>("");

  useEffect(() => {
    setSpecialtyId(ts?.specialty_id ?? "");
    setConsultant(ts?.surgical_consultant ?? "");
  }, [ts?.id, ts?.specialty_id, ts?.surgical_consultant]);

  const saveSession = useMutation({
    mutationFn: async () => {
      if (ts) {
        const { error } = await supabase
          .from("theatre_sessions")
          .update({
            specialty_id: specialtyId || null,
            surgical_consultant: consultant || null,
          })
          .eq("id", ts.id);
        if (error) throw error;
        return ts.id;
      } else {
        const { data, error } = await supabase
          .from("theatre_sessions")
          .insert({
            theatre_id: theatreId, session_date: date, session,
            specialty_id: specialtyId || null,
            surgical_consultant: consultant || null,
          })
          .select("id").single();
        if (error) throw error;
        return data.id;
      }
    },
    onSuccess: () => {
      toast.success("List saved");
      refetch();
      qc.invalidateQueries({ queryKey: ["theatre-sessions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: assigns, refetch: refetchAssigns } = useQuery({
    queryKey: ["assigns", theatreId, date, session, ts?.id],
    enabled: !!ts?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,role_on_list,supervisor_id")
        .eq("theatre_session_id", ts!.id);
      if (error) throw error;
      return data;
    },
  });

  const [newStaff, setNewStaff] = useState<string>("");
  const [newRole, setNewRole] = useState<RotaRole>("solo");

  // Live validation for the candidate being added
  const candidateIssues: Issue[] = newStaff
    ? validateAssignment({
        candidateStaffId: newStaff,
        role: newRole,
        date,
        session,
        weekDates,
        weekAssignments,
        contextAssignments,
        profiles: staff,
        jobPlans,
        leave,
        fixedSessions,
        rules,
      })
    : [];
  const blocking = candidateIssues.some((i) => i.severity === "error");

  // Validation summary per existing assignment in this cell
  const issuesFor = (staffId: string, role: RotaRole) =>
    validateAssignment({
      candidateStaffId: staffId,
      role,
      date,
      session,
      weekDates,
      // exclude the current assignment so it doesn't clash with itself
      weekAssignments: weekAssignments.filter(
        (a) => !(a.staff_id === staffId && a.session_date === date && a.session === session),
      ),
      contextAssignments: contextAssignments.filter(
        (a) => !(a.staff_id === staffId && a.session_date === date && a.session === session),
      ),
      profiles: staff,
      jobPlans,
      leave,
      fixedSessions,
      rules,
    });

  const addAssign = useMutation({
    mutationFn: async () => {
      if (!ts?.id) throw new Error("Save the list first");
      if (!newStaff) throw new Error("Pick a staff member");
      if (blocking) throw new Error("Resolve blocking validation errors first.");
      const { error } = await supabase.from("rota_assignments").insert({
        staff_id: newStaff,
        session, session_date: date,
        theatre_session_id: ts.id,
        role_on_list: newRole,
      });
      if (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new Error("This staff member is already booked for this date and session.");
        }
        throw error;
      }
    },
    onSuccess: () => {
      setNewStaff("");
      refetchAssigns();
      qc.invalidateQueries({ queryKey: ["assignments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeAssign = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("rota_assignments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      refetchAssigns();
      qc.invalidateQueries({ queryKey: ["assignments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dateLabel = new Date(date).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long",
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{theatreName} — {session.toUpperCase()}</DialogTitle>
          <DialogDescription>{dateLabel}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border p-3 space-y-3">
            <div className="text-sm font-medium">Surgical list</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Specialty</Label>
                <Select value={specialtyId} onValueChange={setSpecialtyId}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    {specialties?.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Surgical consultant</Label>
                <Input
                  value={consultant}
                  onChange={(e) => setConsultant(e.target.value)}
                  placeholder="e.g. Mr Smith"
                />
              </div>
            </div>
            <Button size="sm" onClick={() => saveSession.mutate()} disabled={saveSession.isPending}>
              {ts ? "Update list" : "Create list"}
            </Button>
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <div className="text-sm font-medium">Anaesthetic assignments</div>
            {!ts ? (
              <p className="text-xs text-muted-foreground">Create the list first to add staff.</p>
            ) : (
              <>
                {assigns?.length ? (
                  <ul className="divide-y rounded border">
                    {assigns.map((a) => {
                      const iss = issuesFor(a.staff_id, a.role_on_list as RotaRole);
                      const worst = worstSeverity(iss);
                      return (
                        <li key={a.id} className="flex items-start gap-2 p-2 text-sm">
                          <Badge variant="outline">{a.role_on_list}</Badge>
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span>{staff.find((s) => s.id === a.staff_id)?.full_name ?? "—"}</span>
                              {worst && <SeverityIcon severity={worst} />}
                            </div>
                            {iss.length > 0 && (
                              <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                                {iss.map((i, idx) => (
                                  <li key={idx} className={cn(
                                    i.severity === "error" && "text-destructive",
                                    i.severity === "warning" && "text-amber-600 dark:text-amber-400",
                                  )}>
                                    • {i.message}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <Button size="icon" variant="ghost" onClick={() => removeAssign.mutate(a.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No staff assigned.</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={newStaff} onValueChange={setNewStaff}>
                    <SelectTrigger className="h-9 min-w-[14rem]">
                      <SelectValue placeholder="Pick staff…" />
                    </SelectTrigger>
                    <SelectContent>
                      {staff
                        .filter((s) => !assigns?.some((a) => a.staff_id === s.id))
                        .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.full_name} {s.grade ? `(${s.grade})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={newRole} onValueChange={(v) => setNewRole(v as RotaRole)}>
                    <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(["solo", "supervised", "supervising", "on_call", "non_clinical", "teaching", "admin_session"] as RotaRole[]).map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    onClick={() => addAssign.mutate()}
                    disabled={addAssign.isPending || blocking}
                    variant={blocking ? "destructive" : "default"}
                  >
                    <Plus className="mr-1 h-4 w-4" />Assign
                  </Button>
                </div>
                {newStaff && candidateIssues.length > 0 && (
                  <div className="rounded-md border bg-muted/30 p-2 space-y-1">
                    <div className="text-xs font-medium flex items-center gap-1.5">
                      <SeverityIcon severity={worstSeverity(candidateIssues) ?? "info"} />
                      Validation
                    </div>
                    <ul className="space-y-0.5 text-[11px]">
                      {candidateIssues.map((i, idx) => (
                        <li key={idx} className={cn(
                          "flex items-start gap-1.5",
                          i.severity === "error" && "text-destructive",
                          i.severity === "warning" && "text-amber-600 dark:text-amber-400",
                          i.severity === "info" && "text-muted-foreground",
                        )}>
                          <span>•</span><span>{i.message}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SeverityIcon({ severity }: { severity: "error" | "warning" | "info" }) {
  if (severity === "error") return <ShieldAlert className="h-3.5 w-3.5 text-destructive" />;
  if (severity === "warning") return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
  return <Info className="h-3.5 w-3.5 text-muted-foreground" />;
}
