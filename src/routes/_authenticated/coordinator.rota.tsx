import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { parseDateLocal, toISODateLocal, formatDateWithWeekdayGB } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { type Profile, type RotaRules } from "@/lib/rota-validation";
import { RotaWeekGrid } from "@/features/coordinator-rota/RotaWeekGrid";
import { CellDialog } from "@/features/coordinator-rota/CellDialog";
import { CompetencyBlockersPanel } from "@/features/coordinator-rota/CompetencyBlockersPanel";
import { usePreferenceMatchFilter } from "@/features/coordinator-rota/use-preference-match-filter";
import {
  preferenceMatches,
  isPreferred,
  type StaffPracticePref,
  type StaffSpecialtyPref,
} from "@/features/coordinator-rota/preferences";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

import type {
  SessionHalf, RotaRole, WeekAssignment, ContextAssignment,
} from "@/features/coordinator-rota/types";

const DEFAULT_RULES: RotaRules = {
  sessions_per_pa: 1,
  max_sessions_per_week: 10,
  max_consecutive_days: 7,
  honour_fixed_sessions: true,
  allow_back_to_back_oncall: false,
};

export const Route = createFileRoute("/_authenticated/coordinator/rota")({
  head: () => ({ meta: [{ title: "Coordinator — Rota — Salisbury Anaesthetics Rota" }] }),
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

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
function iso(d: Date) { return toISODateLocal(d); }
function fmt(d: Date) {
  // British DD/MM/YYYY with weekday context, e.g. "Mon 26/05/2026".
  return formatDateWithWeekdayGB(d);
}

function RotaGridPage() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
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
        .select("id,theatre_id,session,session_date,surgical_consultant,specialty_id,is_non_sag")
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

  const { data: assignments } = useQuery({
    queryKey: ["assignments", startIso, endIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,theatre_session_id,role_on_list,supervisor_id")
        .eq("duty_type", "theatre")
        .in("session", ["am", "pm"])
        .gte("session_date", startIso)
        .lte("session_date", endIso);
      if (error) throw error;
      return (data ?? []) as WeekAssignment[];
    },
  });

  const ctxStartIso = iso(addDays(days[0], -21));
  const ctxEndIso = iso(addDays(days[days.length - 1], 21));
  const { data: contextAssignments } = useQuery({
    queryKey: ["assignments-context", ctxStartIso, ctxEndIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_assignments")
        .select("id,staff_id,session,session_date,theatre_session_id,role_on_list")
        .eq("duty_type", "theatre")
        .in("session", ["am", "pm"])
        .gte("session_date", ctxStartIso)
        .lte("session_date", ctxEndIso);
      if (error) throw error;
      return (data ?? []) as ContextAssignment[];
    },
  });

  const { data: staff } = useQuery({
    queryKey: ["staff-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,training_level,rotation_end_date,ltft_days_off")
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

  const [matchOnly, setMatchOnly] = usePreferenceMatchFilter();

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

  // Count consultants/SAS who would match at least one list scheduled this week.
  const matchStats = useMemo(() => {
    const applicable = (staff ?? []).filter(
      (s) => s.grade === "consultant" || s.grade === "sas",
    );
    const total = applicable.length;

    // Distinct specialties present on this week's sessions.
    const weekSpecialtyIds = new Set<string>();
    for (const ts of theatreSessions ?? []) {
      if (ts.specialty_id) weekSpecialtyIds.add(ts.specialty_id);
    }
    const weekSpecialties = (specialtiesList ?? []).filter((sp) =>
      weekSpecialtyIds.has(sp.id),
    );

    const practiceById = new Map<string, StaffPracticePref>();
    for (const p of practicePrefs ?? []) practiceById.set(p.staff_id, p);

    const specByStaff = new Map<string, Map<string, StaffSpecialtyPref>>();
    for (const p of specialtyPrefs ?? []) {
      let m = specByStaff.get(p.staff_id);
      if (!m) { m = new Map(); specByStaff.set(p.staff_id, m); }
      m.set(p.specialty_id, p);
    }

    const specialtyNames = weekSpecialties
      .map((sp) => sp.name)
      .sort((a, b) => a.localeCompare(b));

    if (weekSpecialties.length === 0) {
      return {
        matching: total,
        preferred: 0,
        total,
        hasLists: false,
        specialtyNames,
        perSpecialty: [] as Array<{ name: string; preferred: number; matching: number }>,
      };
    }

    let matching = 0;
    let preferred = 0;

    // Per-specialty tallies.
    const perSpecialtyCounts = new Map<string, { preferred: number; matching: number }>();
    for (const sp of weekSpecialties) {
      perSpecialtyCounts.set(sp.id, { preferred: 0, matching: 0 });
    }

    for (const s of applicable) {
      const pp = practiceById.get(s.id);
      const specs = specByStaff.get(s.id);
      let anyMatch = false;
      let anyPreferred = false;
      for (const sp of weekSpecialties) {
        const input = {
          staffId: s.id,
          grade: s.grade,
          specialtyId: sp.id,
          specialtyName: sp.name,
          practicePref: pp,
          specialtyPref: specs?.get(sp.id),
        };
        const isPref = isPreferred(input);
        const isMatch = preferenceMatches(input);
        if (isPref) anyPreferred = true;
        if (isMatch) anyMatch = true;
        const bucket = perSpecialtyCounts.get(sp.id)!;
        if (isPref) bucket.preferred++;
        if (isMatch) bucket.matching++;
      }
      if (anyMatch) matching++;
      if (anyPreferred) preferred++;
    }

    const perSpecialty = weekSpecialties
      .map((sp) => ({
        name: sp.name,
        preferred: perSpecialtyCounts.get(sp.id)!.preferred,
        matching: perSpecialtyCounts.get(sp.id)!.matching,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { matching, preferred, total, hasLists: true, specialtyNames, perSpecialty };
  }, [staff, theatreSessions, specialtiesList, practicePrefs, specialtyPrefs]);





  return (
    <div className="space-y-4">
      <PageHeader
        title="Rota editor"
        description={`Week of ${fmt(days[0])} — click any cell to set the surgical list and assign anaesthetists.`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setWeekStart(addDays(weekStart, -7))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date" value={iso(weekStart)}
              onChange={(e) => {
                const d = parseDateLocal(e.target.value);
                if (d) setWeekStart(startOfWeek(d));
              }}
              className="h-8 w-40"
            />
            <Button variant="outline" size="sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              This week
            </Button>
            <div className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-xs">
              <span aria-hidden className="text-amber-500">★</span>
              <Label htmlFor="rota-pref-match" className="text-xs font-medium cursor-pointer">
                Match preferences
              </Label>
              <Switch
                id="rota-pref-match"
                checked={matchOnly}
                onCheckedChange={setMatchOnly}
                aria-label="Sort the staff dropdown by preference match (preferred first, then matching, then warnings)"
              />
              <span className="text-muted-foreground">
                {matchOnly ? "sorted by match" : "alphabetical"}
              </span>

              <span
                className="ml-1 inline-flex items-center gap-1 rounded bg-background px-1.5 py-0.5 font-medium tabular-nums text-foreground border border-border"
                title={
                  matchStats.hasLists
                    ? `${matchStats.preferred} preferred, ${matchStats.matching} matching (of ${matchStats.total} consultants / SAS) for at least one list scheduled this week.\n\nSpecialties requiring cover this week:\n• ${matchStats.specialtyNames.join("\n• ")}`
                    : "No lists scheduled this week yet — all consultants / SAS count as matching."
                }
              >
                <span className="text-amber-500" aria-hidden>★</span>
                <span aria-label={`${matchStats.preferred} preferred`}>
                  {matchStats.preferred}
                </span>
                <span className="text-muted-foreground" aria-hidden>·</span>
                <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>✓</span>
                <span aria-label={`${matchStats.matching} matching of ${matchStats.total}`}>
                  {matchStats.matching}/{matchStats.total}
                </span>
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-background"
                    aria-label="Dropdown legend"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="end" className="w-64 p-3 text-xs">
                  <p className="mb-2 font-semibold">Staff dropdown legend</p>
                  <ul className="space-y-1.5">
                    <li className="flex items-start gap-2">
                      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center font-bold text-amber-500">★</span>
                      <span>
                        <span className="font-medium">Preferred</span> — actively enjoys / requests this specialty.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center font-bold text-emerald-600 dark:text-emerald-400">✓</span>
                      <span>
                        <span className="font-medium">Matches</span> — covers the required specialty and any obs / paeds / cleft flags.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center font-bold text-destructive">!</span>
                      <span>
                        <span className="font-medium">Warning</span> — missing a required coverage or marked as not covering the specialty.
                      </span>
                    </li>
                  </ul>
                  <p className="mt-2 text-muted-foreground">
                    Icons appear next to each name in the assignment dropdown when <span className="font-medium">Match preferences</span> is on.
                  </p>
                </PopoverContent>
              </Popover>


            </div>
          </>
        }
      />

      <CompetencyBlockersPanel
        assignments={assignments ?? []}
        theatreSessions={theatreSessions ?? []}
        theatres={theatres ?? []}
        staff={(staff ?? []).map((s) => ({ id: s.id, full_name: s.full_name }))}
        onSelectCell={setCellOpen}
      />

      <RotaWeekGrid
        days={days}
        theatres={theatres}
        theatreSessions={theatreSessions}
        assignments={assignments}
        staff={staff}
        specialtiesList={specialtiesList}
        onCellClick={setCellOpen}
      />


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
