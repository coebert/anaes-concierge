import { PageHeader } from "@/components/page-header";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatDateGB, todayISO } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import {
  buildConsultantSessionSet,
  isSoloTraineeAssignment,
  type SoloProfile,
} from "@/lib/solo-stats";
import { chunkIds } from "@/lib/supabase-chunked";
import { computeTraineeMetrics, isJuniorTraineeLevel } from "@/features/trainees/trainee-metrics";
import { isIcuBlockOnly } from "@/features/audit/trainee-audit";
import { computeProgress } from "@/lib/competency-utils";
import { TraineeMetricsCard } from "@/components/trainee-metrics-card";
import { CalendarCoverageCard } from "@/components/calendar-coverage-card";
import {
  Users, GraduationCap, Stethoscope, UserCheck, UserX,
  CalendarDays, AlertTriangle, Clock, XCircle, ListChecks,
  ChevronDown, ChevronRight,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, Legend,
} from "recharts";

import {
  BUCKET_LABEL,
  GRADES,
  GRADE_LABEL,
  LEAVE_LABEL,
  LEAVE_TYPES,
  traineeBucket,
  type Grade,
  type LeaveType,
  type TraineeBucket,
} from "@/features/admin/dashboard-helpers";
import { DualStat, Stat } from "./-admin-dashboard-stats";
import { DashboardBody } from "@/features/admin-dashboard/DashboardBody";
import { PageLoading } from "@/components/loading";

export const Route = createFileRoute("/_authenticated/admin/dashboard")({
  component: AdminDashboardPage,
});


function AdminDashboardPage() {
  const { hasRole, loading } = useAuth();
  const [date, setDate] = useState(todayISO());

  const { data, isLoading } = useQuery({
    queryKey: ["admin-dashboard-overview", date],
    queryFn: async () => {
      const [profilesRes, assignmentsRes, leaveRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, grade, training_level, active, rotation_end_date")
          .eq("active", true),
        supabase
          .from("rota_assignments")
          .select("id, staff_id, role_on_list, session, supervisor_id, theatre_session_id, duty_type")
          .eq("session_date", date),
        supabase
          .from("leave_requests")
          .select("id, staff_id, type, status, start_date, end_date")
          .eq("status", "approved")
          .lte("start_date", date)
          .gte("end_date", date),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (assignmentsRes.error) throw assignmentsRes.error;
      if (leaveRes.error) throw leaveRes.error;
      return {
        profiles: profilesRes.data ?? [],
        assignments: assignmentsRes.data ?? [],
        leave: leaveRes.data ?? [],
      };
    },
  });

  const { data: activity } = useQuery({
    queryKey: ["admin-dashboard-activity"],
    queryFn: async () => {
      const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
      const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      const [late7, late30, rejected7, rejected30, reserve7, reserve30] = await Promise.all([
        supabase.from("rota_change_log").select("id", { count: "exact", head: true }).gte("changed_at", since7),
        supabase.from("rota_change_log").select("id", { count: "exact", head: true }).gte("changed_at", since30),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("status", "rejected").gte("decided_at", since7),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("status", "rejected").gte("decided_at", since30),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).not("reserve_listed_at", "is", null).gte("reserve_listed_at", since7),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).not("reserve_listed_at", "is", null).gte("reserve_listed_at", since30),
      ]);
      return {
        lateRota: { d7: late7.count ?? 0, d30: late30.count ?? 0 },
        rejected:  { d7: rejected7.count ?? 0, d30: rejected30.count ?? 0 },
        reserve:   { d7: reserve7.count ?? 0, d30: reserve30.count ?? 0 },
      };
    },
  });

  const { data: annualLeaveStats } = useQuery({
    queryKey: ["admin-dashboard-annual-leave-monthly"],
    queryFn: async () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const startISO = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
      const endISO = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

      const [profilesRes, allowRes, leaveRes] = await Promise.all([
        supabase.from("profiles").select("id, grade, active").in("grade", ["consultant", "trainee"]).eq("active", true),
        supabase.from("leave_allowances").select("staff_id, annual_days"),
        supabase
          .from("leave_requests")
          .select("staff_id, start_date, end_date, half_day_start, half_day_end")
          .eq("status", "approved")
          .eq("type", "annual")
          .lte("start_date", endISO)
          .gte("end_date", startISO),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (allowRes.error) throw allowRes.error;
      if (leaveRes.error) throw leaveRes.error;

      const months: { key: string; label: string; year: number; month: number }[] = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        months.push({
          key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
          label: d.toLocaleString("en-GB", { month: "short", year: "2-digit" }),
          year: d.getFullYear(),
          month: d.getMonth(),
        });
      }

      const gradeById = new Map<string, "consultant" | "trainee">();
      for (const p of profilesRes.data ?? []) {
        if (p.grade === "consultant" || p.grade === "trainee") gradeById.set(p.id, p.grade);
      }
      const allowanceById = new Map<string, number>();
      for (const a of allowRes.data ?? []) {
        if (a.annual_days && Number(a.annual_days) > 0) allowanceById.set(a.staff_id, Number(a.annual_days));
      }

      // days taken per staff per month (weekdays only, with half-day handling)
      const daysTaken = new Map<string, Map<string, number>>(); // staffId -> monthKey -> days
      for (const l of leaveRes.data ?? []) {
        if (!gradeById.has(l.staff_id)) continue;
        const s = new Date(l.start_date + "T00:00:00Z");
        const e = new Date(l.end_date + "T00:00:00Z");
        for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) continue;
          const iso = d.toISOString().slice(0, 10);
          let inc = 1;
          if (iso === l.start_date && l.half_day_start) inc -= 0.5;
          if (iso === l.end_date && l.half_day_end) inc -= 0.5;
          if (inc <= 0) continue;
          const mk = iso.slice(0, 7);
          let inner = daysTaken.get(l.staff_id);
          if (!inner) { inner = new Map(); daysTaken.set(l.staff_id, inner); }
          inner.set(mk, (inner.get(mk) ?? 0) + inc);
        }
      }

      const chart = months.map((m) => {
        const acc: Record<"consultant" | "trainee", { sumPct: number; n: number }> = {
          consultant: { sumPct: 0, n: 0 },
          trainee: { sumPct: 0, n: 0 },
        };
        for (const [staffId, grade] of gradeById) {
          const allowance = allowanceById.get(staffId);
          if (!allowance) continue;
          const taken = daysTaken.get(staffId)?.get(m.key) ?? 0;
          acc[grade].sumPct += (taken / allowance) * 100;
          acc[grade].n += 1;
        }
        return {
          label: m.label,
          consultantPct: acc.consultant.n > 0 ? Math.round((acc.consultant.sumPct / acc.consultant.n) * 10) / 10 : 0,
          traineePct: acc.trainee.n > 0 ? Math.round((acc.trainee.sumPct / acc.trainee.n) * 10) / 10 : 0,
        };
      });

      const avg = (key: "consultantPct" | "traineePct") => {
        const vals = chart.map((r) => r[key]);
        return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
      };

      return {
        chart,
        consultantAvg: avg("consultantPct"),
        traineeAvg: avg("traineePct"),
        consultantsTracked: Array.from(gradeById.entries()).filter(([id, g]) => g === "consultant" && allowanceById.has(id)).length,
        traineesTracked: Array.from(gradeById.entries()).filter(([id, g]) => g === "trainee" && allowanceById.has(id)).length,
      };
    },
  });

  const [bucket, setBucket] = useState<TraineeBucket>("all");
  const [showOnlyActive, setShowOnlyActive] = useState(false);
  const [expandedTrainee, setExpandedTrainee] = useState<string | null>(null);

  const { data: soloMonthly, isLoading: soloLoading } = useQuery({
    queryKey: ["admin-dashboard-solo-monthly"],
    queryFn: async () => {
      // Last 12 full months including current month
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
      const startISO = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
      const endISO = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

      const [profilesRes, theatreRes, allRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, grade, training_level"),
        supabase
          .from("rota_assignments")
          .select("staff_id, role_on_list, session, session_date, duty_type, supervisor_id, theatre_session_id")
          .eq("duty_type", "theatre")
          .in("session", ["am", "pm"])
          .not("theatre_session_id", "is", null)
          .gte("session_date", startISO)
          .lte("session_date", endISO)
          // The 12-month trainee summary regularly exceeds the backend's
          // default 1,000-row page cap. Without an explicit range, later rows
          // are dropped and some trainees appear to have zero matched lists.
          .range(0, 49999),
        supabase
          .from("rota_assignments")
          .select("staff_id, duty_type, session_date")
          .gte("session_date", startISO)
          .lte("session_date", endISO)
          .range(0, 49999),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (theatreRes.error) throw theatreRes.error;
      if (allRes.error) throw allRes.error;

      const months: string[] = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      return {
        profiles: profilesRes.data ?? [],
        theatreAssignments: theatreRes.data ?? [],
        allAssignments: allRes.data ?? [],
        months,
      };
    },
  });

  const { data: traineeMetricsData, isLoading: traineeMetricsLoading } = useQuery({
    queryKey: ["admin-dashboard-trainee-metrics"],
    queryFn: async () => {
      const today = todayISO();
      const { data: trainees, error: e1 } = await supabase
        .from("profiles")
        .select("id, full_name, training_level, start_date, rotation_end_date")
        .eq("grade", "trainee")
        .eq("active", true)
        .order("full_name");
      if (e1) throw e1;
      const ids = (trainees ?? []).map((t) => t.id);
      if (!ids.length) {
        return { trainees: [], assignmentsByStaff: new Map(), futureByStaff: new Map<string, Array<{ duty_type: string | null; session_date: string }>>(), tsSpecMap: new Map<string, string | null>(), specNameMap: new Map<string, string>(), supervisorSessionIds: new Set<string>() };
      }
      const [{ data: assignments, error: e2 }, { data: specs, error: e3 }, { data: futureRows, error: eFuture }] = await Promise.all([
        supabase
          .from("rota_assignments")
          .select("staff_id, role_on_list, session, duty_type, theatre_session_id, session_date")
          .in("staff_id", ids)
          .lte("session_date", today)
          .range(0, 49999),
        supabase.from("specialties").select("id, name"),
        supabase
          .from("rota_assignments")
          .select("staff_id, duty_type, session_date")
          .in("staff_id", ids)
          .gt("session_date", today)
          .range(0, 49999),
      ]);
      if (e2) throw e2;
      if (e3) throw e3;
      if (eFuture) throw eFuture;
      const tsIds = Array.from(
        new Set((assignments ?? []).map((a) => a.theatre_session_id).filter(Boolean) as string[]),
      );
      const tsSpecMap = new Map<string, string | null>();
      // Sessions where a consultant/SAS doctor is ALSO rostered — used to
      // reclassify trainee "solo" rows on the same session as "supervised".
      // Without this, the dashboard's solo counts are inflated by import-time
      // defaults (clwrota sets role_on_list='solo' when it can't pin a
      // supervisor) and disagree with the /trainees overview + detail pages.
      const supervisorSessionIds = new Set<string>();
      if (tsIds.length) {
        // Chunked `.in()` lookup — see src/lib/supabase-chunked.ts. Across all
        // active trainees the distinct theatre-session ID set easily exceeds
        // the PostgREST URL length limit; a single .in() request silently
        // truncates and leaves sessions without a specialty.
        const results = await Promise.all(
          chunkIds(tsIds).map((c) =>
            supabase.from("theatre_sessions").select("id, specialty_id").in("id", c).range(0, 49999),
          ),
        );
        for (const { data: ts, error: e4 } of results) {
          if (e4) throw e4;
          for (const t of ts ?? []) tsSpecMap.set(t.id, t.specialty_id ?? null);
        }
        const supResults = await Promise.all(
          chunkIds(tsIds).map((c) =>
            supabase
              .from("rota_assignments")
              .select(
                "theatre_session_id,staff_id,profiles!rota_assignments_staff_id_fkey!inner(grade)",
              )
              .in("theatre_session_id", c)
              .in("profiles.grade", ["consultant", "sas"])
              .range(0, 49999),
          ),
        );
        for (const { data: tsAssigns, error: e5 } of supResults) {
          if (e5) throw e5;
          for (const r of (tsAssigns ?? []) as Array<{ theatre_session_id: string | null }>) {
            if (r.theatre_session_id) supervisorSessionIds.add(r.theatre_session_id);
          }
        }
      }
      const specNameMap = new Map((specs ?? []).map((s) => [s.id, s.name]));
      const assignmentsByStaff = new Map<string, typeof assignments>();
      for (const a of assignments ?? []) {
        const arr = assignmentsByStaff.get(a.staff_id) ?? [];
        arr.push(a);
        assignmentsByStaff.set(a.staff_id, arr);
      }
      const futureByStaff = new Map<string, Array<{ duty_type: string | null; session_date: string }>>();
      for (const a of futureRows ?? []) {
        const arr = futureByStaff.get(a.staff_id) ?? [];
        arr.push({ duty_type: a.duty_type, session_date: a.session_date });
        futureByStaff.set(a.staff_id, arr);
      }
      return { trainees: trainees ?? [], assignmentsByStaff, futureByStaff, tsSpecMap, specNameMap, supervisorSessionIds };
    },
  });

  const { data: traineeTargets } = useQuery({
    queryKey: ["admin-dashboard-trainee-targets"],
    queryFn: async () => {
      const [{ data: targets, error: e1 }, { data: specs, error: e2 }] = await Promise.all([
        supabase.from("trainee_targets").select("*"),
        supabase.from("specialties").select("id, name"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const specMap = new Map((specs ?? []).map((s) => [s.id, s.name]));
      return { targets: targets ?? [], specMap };
    },
  });

  const { data: rotaRules } = useQuery({
    queryKey: ["rota-rules-thresholds"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rota_rules")
        .select("trainee_at_risk_pct, trainee_behind_pct")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      const row = (data ?? {}) as { trainee_at_risk_pct?: number; trainee_behind_pct?: number };
      return {
        atRiskPct: Number(row.trainee_at_risk_pct ?? 50),
        behindPct: Number(row.trainee_behind_pct ?? 75),
      };
    },
  });
  const atRiskPct = rotaRules?.atRiskPct ?? 50;
  const behindPct = rotaRules?.behindPct ?? 75;


  // Per-trainee progress against curriculum targets (12-month window from traineeMetricsData)
  const progressByStaff = useMemo(() => {
    const out = new Map<
      string,
      {
        overall: number | null;
        unmet: number;
        totalTargets: number;
        progress: ReturnType<typeof computeProgress>;
      }
    >();
    if (!traineeMetricsData || !traineeTargets) return out;
    for (const t of traineeMetricsData.trainees) {
      const targetsForLevel = traineeTargets.targets.filter(
        (tg) => tg.training_level === t.training_level,
      );
      if (!targetsForLevel.length) {
        out.set(t.id, { overall: null, unmet: 0, totalTargets: 0, progress: [] });
        continue;
      }
      const enriched = targetsForLevel.map((tg) => ({
        specialty_id: tg.specialty_id,
        specialty_name: traineeTargets.specMap.get(tg.specialty_id) ?? "Unknown",
        required_solo: tg.required_solo,
        required_supervised: tg.required_supervised,
        required_sessions: tg.required_sessions,
      }));
      const assigns = (traineeMetricsData.assignmentsByStaff.get(t.id) ?? []).map(
        (a: { theatre_session_id: string | null; role_on_list: string }) => ({
          specialty_id: a.theatre_session_id
            ? traineeMetricsData.tsSpecMap.get(a.theatre_session_id) ?? null
            : null,
          role_on_list: a.role_on_list,
        }),
      );
      const progress = computeProgress(enriched, assigns);
      const overall = Math.round(progress.reduce((s, p) => s + p.percent, 0) / progress.length);
      const unmet = progress.filter((p) => p.percent < 100).length;
      out.set(t.id, { overall, unmet, totalTargets: progress.length, progress });
    }
    return out;
  }, [traineeMetricsData, traineeTargets]);

  const traineeMetricRows = useMemo(() => {
    if (!traineeMetricsData) return [];
    return traineeMetricsData.trainees
      .map((t) => {
        const icuOnly = isIcuBlockOnly(
          traineeMetricsData.futureByStaff.get(t.id) ?? [],
          todayISO(),
          (t as { rotation_end_date?: string | null }).rotation_end_date ?? null,
        );
        return {
          trainee: t,
          icuOnly,
          metrics: computeTraineeMetrics(
            traineeMetricsData.assignmentsByStaff.get(t.id) ?? [],
            t.start_date,
            traineeMetricsData.tsSpecMap,
            traineeMetricsData.specNameMap,
            Date.now(),
            (t as { rotation_end_date?: string | null }).rotation_end_date ?? null,
            icuOnly,
            isJuniorTraineeLevel((t as { training_level?: string | null }).training_level),
            traineeMetricsData.supervisorSessionIds,
          ),
        };
      })
      .sort((a, b) => compareBySurname(a.trainee.full_name, b.trainee.full_name));
  }, [traineeMetricsData]);


  const soloStats = useMemo(() => {
    if (!soloMonthly) return null;
    const traineeIds = new Map<string, { full_name: string | null; bucket: TraineeBucket | null; level: string | null }>();
    const gradeById = new Map<string, string | null>();
    for (const p of soloMonthly.profiles) {
      gradeById.set(p.id, p.grade ?? null);
      if (p.grade === "trainee") {
        traineeIds.set(p.id, {
          full_name: p.full_name,
          bucket: traineeBucket(p.training_level),
          level: p.training_level,
        });
      }
    }

    const profilesById = new Map<string, SoloProfile>(
      soloMonthly.profiles.map((p) => [
        p.id,
        { id: p.id, grade: p.grade ?? null, training_level: p.training_level ?? null },
      ]),
    );
    const consultantOnSession = buildConsultantSessionSet(
      soloMonthly.theatreAssignments,
      profilesById,
    );

    const inBucket = (b: TraineeBucket | null) =>
      bucket === "all" ? b !== null : b === bucket;

    const monthAgg = new Map<string, { solo: number; total: number }>();
    soloMonthly.months.forEach((m) => monthAgg.set(m, { solo: 0, total: 0 }));

    const perTrainee = new Map<string, { solo: number; total: number }>();
    const perMonthTrainee = new Map<string, Map<string, { solo: number; total: number }>>();
    soloMonthly.months.forEach((m) => perMonthTrainee.set(m, new Map()));

    const debugRows: Array<{
      trainee: string | null;
      date: string;
      session: string;
      role: string;
      theatre_session_id: string | null;
      hasConsultant: boolean;
      supervisor_id: string | null;
      supervisorIsConsultant: boolean;
      isSolo: boolean;
    }> = [];

    for (const a of soloMonthly.theatreAssignments) {
      const t = traineeIds.get(a.staff_id);
      if (!t || !inBucket(t.bucket)) continue;
      const monthKey = a.session_date.slice(0, 7);
      const ma = monthAgg.get(monthKey);
      if (!ma) continue;
      ma.total += 1;
      const hasConsultant = a.theatre_session_id ? consultantOnSession.has(a.theatre_session_id) : false;
      const supervisorIsConsultant = a.supervisor_id ? gradeById.get(a.supervisor_id) === "consultant" : false;
      const isSolo = isSoloTraineeAssignment(a, consultantOnSession, profilesById);
      if (isSolo) ma.solo += 1;

      debugRows.push({
        trainee: t.full_name,
        date: a.session_date,
        session: a.session,
        role: a.role_on_list,
        theatre_session_id: a.theatre_session_id ?? null,
        hasConsultant,
        supervisor_id: a.supervisor_id ?? null,
        supervisorIsConsultant,
        isSolo,
      });

      const pt = perTrainee.get(a.staff_id) ?? { solo: 0, total: 0 };
      pt.total += 1;
      if (isSolo) pt.solo += 1;
      perTrainee.set(a.staff_id, pt);

      const pmt = perMonthTrainee.get(monthKey)!;
      const pmtRow = pmt.get(a.staff_id) ?? { solo: 0, total: 0 };
      pmtRow.total += 1;
      if (isSolo) pmtRow.solo += 1;
      pmt.set(a.staff_id, pmtRow);
    }


    const chart = soloMonthly.months.map((m) => {
      const ma = monthAgg.get(m)!;
      const pmt = perMonthTrainee.get(m)!;
      // average of per-trainee % (only counting trainees with at least 1 list that month)
      let pctSum = 0;
      let n = 0;
      for (const row of pmt.values()) {
        if (row.total > 0) {
          pctSum += (row.solo / row.total) * 100;
          n += 1;
        }
      }
      const avgPct = n > 0 ? pctSum / n : 0;
      const [yyyy, mm] = m.split("-");
      const label = new Date(parseInt(yyyy), parseInt(mm) - 1, 1).toLocaleString("en-GB", { month: "short", year: "2-digit" });
      return {
        month: m,
        label,
        soloLists: ma.solo,
        totalLists: ma.total,
        avgPctSolo: Math.round(avgPct * 10) / 10,
      };
    });

    const perTraineeOnCall = new Map<string, { onCall: number; total: number }>();
    for (const a of soloMonthly.allAssignments) {
      const t = traineeIds.get(a.staff_id);
      if (!t || !inBucket(t.bucket)) continue;
      const pt = perTraineeOnCall.get(a.staff_id) ?? { onCall: 0, total: 0 };
      pt.total += 1;
      if (a.duty_type !== "theatre") pt.onCall += 1;
      perTraineeOnCall.set(a.staff_id, pt);
    }

    const traineeRows = Array.from(traineeIds.entries())
      .filter(([, t]) => inBucket(t.bucket))
      .map(([id, t]) => {
        const v = perTrainee.get(id) ?? { solo: 0, total: 0 };
        const oc = perTraineeOnCall.get(id) ?? { onCall: 0, total: 0 };
        return {
          id,
          full_name: t.full_name,
          level: t.level,
          solo: v.solo,
          total: v.total,
          pct: v.total > 0 ? Math.round((v.solo / v.total) * 1000) / 10 : 0,
          onCall: oc.onCall,
          totalAll: oc.total,
          onCallPct: oc.total > 0 ? Math.round((oc.onCall / oc.total) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => {
        // Inactive trainees (zero daytime lists) go to the bottom
        if (a.total === 0 && b.total > 0) return 1;
        if (a.total > 0 && b.total === 0) return -1;
        return b.pct - a.pct || compareBySurname(a.full_name, b.full_name);
      });

    const totalSolo = chart.reduce((s, r) => s + r.soloLists, 0);
    const totalLists = chart.reduce((s, r) => s + r.totalLists, 0);

    return { chart, traineeRows, totalSolo, totalLists, debugRows };
  }, [soloMonthly, bucket]);

  const summary = useMemo(() => {
    if (!data) return null;
    const profilesById = new Map(data.profiles.map((p) => [p.id, p]));

    // active staff valid on this date (exclude trainees past rotation end)
    const validProfiles = data.profiles.filter((p) => {
      if (p.grade === "trainee" && p.rotation_end_date && p.rotation_end_date < date) return false;
      return true;
    });

    const assignedIds = new Set(data.assignments.map((a) => a.staff_id));
    const leaveByStaff = new Map<string, LeaveType>();
    for (const l of data.leave) leaveByStaff.set(l.staff_id, l.type as LeaveType);

    const byGrade = (g: Grade) => validProfiles.filter((p) => p.grade === g);

    const assignedByGrade: Record<Grade, number> = { consultant: 0, sas: 0, trainee: 0 };
    const availableByGrade: Record<Grade, { id: string; full_name: string | null; training_level: string | null }[]> = {
      consultant: [], sas: [], trainee: [],
    };
    const leaveByGradeType: Record<Grade, Record<LeaveType, number>> = {
      consultant: { annual: 0, sick: 0, parental: 0, study: 0, compassionate: 0, other: 0 },
      sas:        { annual: 0, sick: 0, parental: 0, study: 0, compassionate: 0, other: 0 },
      trainee:    { annual: 0, sick: 0, parental: 0, study: 0, compassionate: 0, other: 0 },
    };

    for (const g of GRADES) {
      for (const p of byGrade(g)) {
        if (leaveByStaff.has(p.id)) {
          const t = leaveByStaff.get(p.id)!;
          leaveByGradeType[g][t] = (leaveByGradeType[g][t] ?? 0) + 1;
        } else if (assignedIds.has(p.id)) {
          assignedByGrade[g] += 1;
        } else {
          availableByGrade[g].push({
            id: p.id, full_name: p.full_name, training_level: p.training_level,
          });
        }
      }
    }

    // Trainees genuinely working solo today: must be assigned to a theatre
    // AM/PM list, role = solo, no supervisor, and no consultant OR SAS
    // doctor sharing the same theatre_session_id.
    const supervisorSessionsToday = new Set<string>();
    for (const a of data.assignments) {
      if (!a.theatre_session_id) continue;
      const p = profilesById.get(a.staff_id);
      if (p?.grade === "consultant" || p?.grade === "sas") {
        supervisorSessionsToday.add(a.theatre_session_id);
      }
    }
    const traineeSolo = data.assignments
      .filter((a) => {
        if (a.duty_type !== "theatre") return false;
        if (a.session !== "am" && a.session !== "pm") return false;
        if (a.role_on_list !== "solo") return false;
        if (a.supervisor_id) return false;
        const p = profilesById.get(a.staff_id);
        if (!p || p.grade !== "trainee") return false;
        // Require a theatre_session_id so we can verify no supervisor is on it.
        if (!a.theatre_session_id) return false;
        if (supervisorSessionsToday.has(a.theatre_session_id)) return false;
        return true;
      })
      .map((a) => profilesById.get(a.staff_id)!)
      .filter((p): p is NonNullable<typeof p> => !!p);

    const totalAssigned = Object.values(assignedByGrade).reduce((a, b) => a + b, 0);
    const totalOnLeave = Array.from(leaveByStaff.keys())
      .filter((id) => {
        const p = profilesById.get(id);
        return p && (p.grade === "consultant" || p.grade === "sas" || p.grade === "trainee");
      }).length;
    const totalAvailable = Object.values(availableByGrade).reduce((a, b) => a + b.length, 0);

    return {
      assignedByGrade,
      availableByGrade,
      leaveByGradeType,
      traineeSolo,
      totalAssigned,
      totalOnLeave,
      totalAvailable,
      totalActive: validProfiles.filter((p) => GRADES.includes(p.grade as Grade)).length,
    };
  }, [data, date]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rota audit data"
        description={`Daily overview of assignments, leave and availability — ${formatDateGB(date)}`}
        actions={
          <>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Date</label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-44"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => setDate(todayISO())}>
              Today
            </Button>
          </>
        }
      />

      {isLoading || !summary ? (
        <div className="text-sm text-muted-foreground">Loading overview…</div>
      ) : (
        <DashboardBody
          summary={summary}
          activity={activity}
          annualLeaveStats={annualLeaveStats}
          soloStats={soloStats}
          soloLoading={soloLoading}
          bucket={bucket}
          setBucket={setBucket}
          showOnlyActive={showOnlyActive}
          setShowOnlyActive={setShowOnlyActive}
          expandedTrainee={expandedTrainee}
          setExpandedTrainee={setExpandedTrainee}
          progressByStaff={progressByStaff}
          atRiskPct={atRiskPct}
          behindPct={behindPct}
          traineeMetricsLoading={traineeMetricsLoading}
          traineeMetricRows={traineeMetricRows}
        />
      )}
    </div>
  );
}

