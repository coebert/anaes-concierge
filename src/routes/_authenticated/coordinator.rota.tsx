import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { parseDateLocal, toISODateLocal, formatDateWithWeekdayGB } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { type Profile, type RotaRules } from "@/lib/rota-validation";
import { RotaWeekGrid } from "@/features/coordinator-rota/RotaWeekGrid";
import { CellDialog } from "@/features/coordinator-rota/CellDialog";
import { CompetencyBlockersPanel } from "@/features/coordinator-rota/CompetencyBlockersPanel";
import { usePreferenceMatchFilter } from "@/features/coordinator-rota/use-preference-match-filter";
import {
  preferenceMatches,
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

    if (weekSpecialties.length === 0) {
      return { matching: total, total, hasLists: false };
    }

    let matching = 0;
    for (const s of applicable) {
      const pp = practiceById.get(s.id);
      const specs = specByStaff.get(s.id);
      const ok = weekSpecialties.some((sp) =>
        preferenceMatches({
          staffId: s.id,
          grade: s.grade,
          specialtyId: sp.id,
          specialtyName: sp.name,
          practicePref: pp,
          specialtyPref: specs?.get(sp.id),
        }),
      );
      if (ok) matching++;
    }
    return { matching, total, hasLists: true };
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
                aria-label="Only show staff whose preferences match required coverage"
              />
              <span className="text-muted-foreground">
                {matchOnly ? "matches only" : "all staff"}
              </span>
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
