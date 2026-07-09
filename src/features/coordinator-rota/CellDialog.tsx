import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
import { Plus, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  evaluatePreference, preferenceMatches, isPreferred, prefersNotTo, compareStaffByPreference,
  detectListCoverageRequirements,
  type StaffPracticePref, type StaffSpecialtyPref,
} from "./preferences";
import { usePreferenceMatchFilter } from "./use-preference-match-filter";
import { toast } from "sonner";
import { cn, formatDateLongGB } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import {
  validateAssignment, worstSeverity,
  type Issue, type Profile, type RotaRules,
} from "@/lib/rota-validation";
import { checkCustomRuleViolations } from "@/features/rules/custom-rules.functions";
import {
  evaluateCompetency,
  type Competency,
  type CompetencyRequirement,
  type StaffCompetency,
} from "@/features/competencies/competencies";
import { useServerFn } from "@tanstack/react-start";
import { CompetencyMismatchTooltip } from "./CompetencyMismatchTooltip";
import {
  SeverityIcon,
  type SessionHalf,
  type RotaRole,
  type WeekAssignment,
  type ContextAssignment,
  type JobPlanRow,
  type LeaveRow,
  type FixedSessionRow,
} from "./types";

export function CellDialog({
  theatreId, theatreName, date, session, onOpenChange, staff,
  weekDates, weekAssignments, contextAssignments, jobPlans, leave, fixedSessions, rules,
}: {
  theatreId: string; theatreName: string; date: string; session: SessionHalf;
  onOpenChange: (o: boolean) => void;
  staff: Profile[];
  weekDates: string[];
  weekAssignments: WeekAssignment[];
  contextAssignments: ContextAssignment[];
  jobPlans: JobPlanRow[];
  leave: LeaveRow[];
  fixedSessions: FixedSessionRow[];
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

  const { data: rawAssigns, refetch: refetchAssigns } = useQuery({
    queryKey: ["assigns", theatreId, date, session, ts?.id],
    enabled: !!ts?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,role_on_list,supervisor_id,locally_modified,clwrota_external_id")
        .eq("theatre_session_id", ts!.id);
      if (error) throw error;
      return data;
    },
  });

  const gradeRank = (g: string | null | undefined) =>
    g === "consultant" ? 0 : g === "sas" ? 1 : g === "trainee" ? 2 : 3;
  const staffByIdLocal = (id: string) => staff.find((s) => s.id === id);
  const assigns = useMemo(
    () =>
      [...(rawAssigns ?? [])].sort(
        (a, b) =>
          gradeRank(staffByIdLocal(a.staff_id)?.grade) -
          gradeRank(staffByIdLocal(b.staff_id)?.grade),
      ),
    [rawAssigns, staff],
  );

  // Competency register data — used to emit soft warnings when the candidate
  // staff member is not signed off for the specialty of this list.
  const { data: competencyRows } = useQuery({
    queryKey: ["competencies-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("competencies")
        .select("id,code,name,description,category,applies_to_grades,active,sort_order")
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as Competency[];
    },
  });
  const { data: competencyRequirements } = useQuery({
    queryKey: ["specialty-competency-requirements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialty_competency_requirements")
        .select("id,specialty_id,competency_id,requirement,applies_to_role");
      if (error) throw error;
      return (data ?? []) as CompetencyRequirement[];
    },
  });
  const { data: staffHoldings } = useQuery({
    queryKey: ["staff-competencies-all-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_competencies")
        .select("id,staff_id,competency_id,level,granted_at,expires_at,revoked_at,notes");
      if (error) throw error;
      return (data ?? []) as StaffCompetency[];
    },
  });

  const { data: practicePrefs } = useQuery({
    queryKey: ["staff-practice-prefs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_practice_preferences")
        .select("staff_id,covers_obstetrics,covers_paediatrics,covers_cleft_palate");
      if (error) throw error;
      return (data ?? []) as StaffPracticePref[];
    },
  });
  const { data: specialtyPrefs } = useQuery({
    queryKey: ["staff-specialty-prefs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_specialty_preferences")
        .select("staff_id,specialty_id,preference");
      if (error) throw error;
      return (data ?? []) as StaffSpecialtyPref[];
    },
  });
  const practiceByStaff = useMemo(() => {
    const m = new Map<string, StaffPracticePref>();
    for (const p of practicePrefs ?? []) m.set(p.staff_id, p);
    return m;
  }, [practicePrefs]);
  const specialtyPrefByStaff = useMemo(() => {
    const m = new Map<string, Map<string, StaffSpecialtyPref>>();
    for (const p of specialtyPrefs ?? []) {
      let inner = m.get(p.staff_id);
      if (!inner) { inner = new Map(); m.set(p.staff_id, inner); }
      inner.set(p.specialty_id, p);
    }
    return m;
  }, [specialtyPrefs]);
  const currentSpecialtyName = specialties?.find((s) => s.id === specialtyId)?.name ?? null;
  const coverageReq = detectListCoverageRequirements(currentSpecialtyName);

  const prefInputFor = (staffId: string) => {
    const sp = staff.find((s) => s.id === staffId);
    return {
      staffId,
      grade: sp?.grade ?? null,
      specialtyId: specialtyId || null,
      specialtyName: currentSpecialtyName,
      practicePref: practiceByStaff.get(staffId),
      specialtyPref: specialtyPrefByStaff.get(staffId)?.get(specialtyId ?? ""),
    };
  };

  const [filterToMatching, setFilterToMatching] = usePreferenceMatchFilter();

  const updateAssign = useMutation({
    mutationFn: async (vars: { id: string; staff_id: string; role_on_list: RotaRole }) => {
      const { error } = await supabase
        .from("rota_assignments")
        .update({
          staff_id: vars.staff_id,
          role_on_list: vars.role_on_list,
          locally_modified: true,
        })
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Assignment updated");
      refetchAssigns();
      qc.invalidateQueries({ queryKey: ["assignments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [newStaff, setNewStaff] = useState<string>("");
  const [newRole, setNewRole] = useState<RotaRole>("solo");

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

  const checkRules = useServerFn(checkCustomRuleViolations);
  const [customIssues, setCustomIssues] = useState<Issue[]>([]);
  useEffect(() => {
    if (!newStaff) { setCustomIssues([]); return; }
    let cancelled = false;
    const ctx = contextAssignments
      .filter((a) => a.staff_id === newStaff)
      .map((a) => ({
        session_date: a.session_date,
        session: a.session,
        role_on_list: a.role_on_list as string,
      }));
    const t = setTimeout(async () => {
      try {
        const res = await checkRules({
          data: {
            staffId: newStaff,
            date,
            session,
            role: newRole,
            contextAssignments: ctx,
          },
        });
        if (cancelled) return;
        setCustomIssues(
          (res.violations ?? []).map((v) => ({
            severity: "warning" as const,
            message: `Custom rule — ${v.summary}: ${v.reason} (Rule: "${v.ruleText}")`,
          })),
        );
      } catch {
        if (!cancelled) setCustomIssues([]);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newStaff, newRole, date, session]);

  // Soft warnings from the competency register for the candidate being added.
  const candidateCompetencyIssues: Issue[] = newStaff && specialtyId
    ? evaluateCompetency({
        staffId: newStaff,
        specialtyId,
        role: newRole,
        onDate: date,
        requirements: competencyRequirements ?? [],
        staffCompetencies: staffHoldings ?? [],
        competencies: competencyRows ?? [],
      })
    : [];

  const candidatePreferenceIssues: Issue[] = newStaff
    ? evaluatePreference(prefInputFor(newStaff))
    : [];

  const allCandidateIssues = [
    ...candidateIssues,
    ...customIssues,
    ...candidateCompetencyIssues,
    ...candidatePreferenceIssues,
  ];

  const competencyIssuesFor = (staffId: string, role: RotaRole): Issue[] =>
    specialtyId
      ? evaluateCompetency({
          staffId, specialtyId, role, onDate: date,
          requirements: competencyRequirements ?? [],
          staffCompetencies: staffHoldings ?? [],
          competencies: competencyRows ?? [],
        })
      : [];

  const issuesFor = (staffId: string, role: RotaRole) => [
    ...validateAssignment({
      candidateStaffId: staffId,
      role,
      date,
      session,
      weekDates,
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
    }),
    ...competencyIssuesFor(staffId, role),
    ...evaluatePreference(prefInputFor(staffId)),
  ];

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

  const dateLabel = formatDateLongGB(date);

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
                          <Select
                            value={a.role_on_list}
                            onValueChange={(v) => updateAssign.mutate({
                              id: a.id, staff_id: a.staff_id, role_on_list: v as RotaRole,
                            })}
                          >
                            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {(["solo", "supervised", "supervising", "on_call", "non_clinical", "teaching", "admin_session"] as RotaRole[]).map((r) => (
                                <SelectItem key={r} value={r}>{r}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <div className="flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <Select
                                value={a.staff_id}
                                onValueChange={(v) => updateAssign.mutate({
                                  id: a.id, staff_id: v, role_on_list: a.role_on_list as RotaRole,
                                })}
                              >
                                <SelectTrigger className="h-7 min-w-[12rem] text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {staff
                                    .filter((s) => s.id === a.staff_id || !assigns?.some((x) => x.staff_id === s.id))
                                    .sort((a, b) => compareBySurname(a.full_name, b.full_name))
                                    .map((s) => (
                                      <SelectItem key={s.id} value={s.id}>
                                        {s.full_name} {s.grade ? `(${s.grade})` : ""}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                              {(() => {
                                const sp = staffByIdLocal(a.staff_id);
                                if (!sp) return null;
                                const isConsultant = sp.grade === "consultant";
                                const isTrainee = sp.grade === "trainee";
                                const highlightTrainee = isTrainee && a.role_on_list === "solo";
                                return (
                                  <span
                                    className={cn(
                                      "text-[11px]",
                                      isConsultant && "font-bold",
                                      highlightTrainee && "text-blue-600 dark:text-blue-400",
                                    )}
                                  >
                                    {sp.full_name}
                                    {isTrainee ? ` (${sp.training_level || "Level unknown"})` : ""}
                                  </span>
                                );
                              })()}
                              {worst && <SeverityIcon severity={worst} />}
                              {a.locally_modified && a.clwrota_external_id && (
                                <Badge variant="secondary" className="px-1 py-0 text-[9px]" title="Locked: this row was edited locally and will not be overwritten by CLWRota sync.">
                                  locked
                                </Badge>
                              )}
                            </div>
                            {iss.length > 0 && (
                              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                                {iss.map((i, idx) => (
                                  <li key={idx} className={cn(
                                    "flex items-center gap-1",
                                    i.severity === "error" && "text-destructive",
                                    i.severity === "warning" && "text-warning",
                                  )}>
                                    <span>• {i.message}</span>
                                  </li>
                                ))}
                                {specialtyId && (
                                  <li className="flex items-center gap-1 text-muted-foreground">
                                    <CompetencyMismatchTooltip
                                      staffId={a.staff_id}
                                      staffName={staffByIdLocal(a.staff_id)?.full_name}
                                      specialtyId={specialtyId}
                                      specialtyName={specialties?.find((s) => s.id === specialtyId)?.name}
                                      role={a.role_on_list}
                                      onDate={date}
                                      competencies={competencyRows ?? []}
                                      requirements={competencyRequirements ?? []}
                                      staffCompetencies={staffHoldings ?? []}
                                    />
                                    <span className="text-[10px]">Competency details</span>
                                  </li>
                                )}
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
                {specialtyId && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <div className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1">
                      <span aria-hidden className="text-amber-500">★</span>
                      <span className="font-medium">Match preferences</span>
                      <Switch
                        checked={filterToMatching}
                        onCheckedChange={setFilterToMatching}
                        aria-label="Only show staff who match this list's preferences"
                      />
                      <span className="text-muted-foreground">
                        {filterToMatching ? "showing matches only" : "showing all"}
                      </span>
                    </div>
                    {coverageReq.needsObstetrics && (
                      <Badge variant="outline">requires obstetrics cover</Badge>
                    )}
                    {coverageReq.needsPaediatrics && (
                      <Badge variant="outline">requires paediatrics cover</Badge>
                    )}
                    {coverageReq.needsCleft && (
                      <Badge variant="outline">requires cleft palate cover</Badge>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={newStaff} onValueChange={setNewStaff}>
                    <SelectTrigger className="h-9 min-w-[14rem]">
                      <SelectValue placeholder="Pick staff…" />
                    </SelectTrigger>
                    <SelectContent>
                      {staff
                        .filter((s) => !assigns?.some((a) => a.staff_id === s.id))
                        .sort((a, b) =>
                          filterToMatching
                            ? compareStaffByPreference<Profile>(
                                a,
                                b,
                                (s) => prefInputFor(s.id),
                                (x, y) => compareBySurname(x.full_name, y.full_name),
                              )
                            : compareBySurname(a.full_name, b.full_name),
                        )



                        .map((s) => {
                          const pi = prefInputFor(s.id);
                          const preferred = isPreferred(pi);
                          const matches = preferenceMatches(pi);
                          const preferNot = prefersNotTo(pi);
                          const scopedToPrefs =
                            !!specialtyId &&
                            (s.grade === "consultant" || s.grade === "sas");
                          const reasons: string[] = [];
                          if (scopedToPrefs) {
                            const sPref =
                              specialtyPrefByStaff.get(s.id)?.get(specialtyId)?.preference ??
                              "willing";
                            if (sPref === "none") reasons.push("does not cover specialty");
                            if (sPref === "prefer_not_to") reasons.push("would rather not");
                            const pp = practiceByStaff.get(s.id);
                            if (coverageReq.needsObstetrics && !pp?.covers_obstetrics)
                              reasons.push("no obstetrics");
                            if (coverageReq.needsPaediatrics && !pp?.covers_paediatrics)
                              reasons.push("no paeds");
                            if (coverageReq.needsCleft && !pp?.covers_cleft_palate)
                              reasons.push("no cleft");
                          }
                          return (
                            <SelectItem
                              key={s.id}
                              value={s.id}
                              className={cn(
                                preferred &&
                                  "bg-emerald-500/10 data-[highlighted]:bg-emerald-500/20 font-medium",
                                !matches &&
                                  "text-muted-foreground data-[highlighted]:bg-destructive/10",
                                matches && preferNot && "text-muted-foreground",
                              )}
                            >
                              <span className="flex items-center gap-1.5">
                                {filterToMatching && (
                                  <span
                                    aria-label={
                                      preferred
                                        ? "Preferred"
                                        : preferNot
                                          ? "Would rather not, but able"
                                          : matches
                                            ? "Matches preferences"
                                            : "Does not match preferences"
                                    }
                                    className={cn(
                                      "inline-flex h-4 w-4 items-center justify-center text-xs font-bold tabular-nums",
                                      preferred && "text-amber-500",
                                      !preferred && matches && !preferNot && "text-emerald-600 dark:text-emerald-400",
                                      matches && preferNot && "text-amber-600 dark:text-amber-400",
                                      !matches && "text-destructive",
                                    )}
                                  >
                                    {preferred ? "★" : preferNot ? "~" : matches ? "✓" : "!"}
                                  </span>
                                )}
                                {!filterToMatching && preferred && (
                                  <span aria-label="Preferred" className="text-amber-500">★</span>
                                )}

                                <span>
                                  {s.full_name}
                                  {s.grade ? ` (${s.grade})` : ""}
                                </span>
                                {preferred && (
                                  <span className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                                    preferred
                                  </span>
                                )}
                                {matches && preferNot && (
                                  <span
                                    className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400"
                                    title="Soft preference — this doctor would rather not cover this list, but is still able to if needed. Not an exclusion."
                                  >
                                    would rather not (soft)
                                  </span>
                                )}
                                {!matches && reasons.length > 0 && (
                                  <span className="text-[10px] uppercase tracking-wide text-destructive">
                                    · {reasons.join(", ")}
                                  </span>
                                )}
                              </span>
                            </SelectItem>
                          );
                        })}
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
                {newStaff && allCandidateIssues.length > 0 && (
                  <div className="rounded-md border bg-muted/30 p-2 space-y-1">
                    <div className="text-xs font-medium flex items-center gap-1.5">
                      <SeverityIcon severity={worstSeverity(allCandidateIssues) ?? "info"} />
                      Validation
                      {specialtyId && newStaff && (
                        <CompetencyMismatchTooltip
                          staffId={newStaff}
                          staffName={staff.find((s) => s.id === newStaff)?.full_name}
                          specialtyId={specialtyId}
                          specialtyName={specialties?.find((s) => s.id === specialtyId)?.name}
                          role={newRole}
                          onDate={date}
                          competencies={competencyRows ?? []}
                          requirements={competencyRequirements ?? []}
                          staffCompetencies={staffHoldings ?? []}
                        />
                      )}
                    </div>
                    <ul className="space-y-0.5 text-[11px]">
                      {allCandidateIssues.map((i, idx) => (
                        <li key={idx} className={cn(
                          "flex items-start gap-1.5",
                          i.severity === "error" && "text-destructive",
                          i.severity === "warning" && "text-warning",
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
