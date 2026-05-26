import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatDateGB, getSurname, todayISO } from "@/lib/utils";
import {
  buildConsultantSessionSet,
  isSoloTraineeAssignment,
  type SoloProfile,
} from "@/lib/solo-stats";
import { computeTraineeMetrics } from "@/lib/trainee-metrics";
import { TraineeMetricsCard } from "@/components/trainee-metrics-card";
import {
  Users, GraduationCap, Stethoscope, UserCheck, UserX,
  CalendarDays, AlertTriangle, Clock, XCircle, ListChecks,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, Legend,
} from "recharts";

type TraineeBucket = "all" | "junior" | "senior";
const BUCKET_LABEL: Record<TraineeBucket, string> = {
  all: "All trainees",
  junior: "CT2–ST4",
  senior: "ST5–ST8+",
};

function traineeBucket(level: string | null | undefined): TraineeBucket | null {
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

export const Route = createFileRoute("/_authenticated/admin/dashboard")({
  component: AdminDashboardPage,
});

type Grade = "consultant" | "sas" | "trainee";
const GRADES: Grade[] = ["consultant", "sas", "trainee"];
const GRADE_LABEL: Record<Grade, string> = {
  consultant: "Consultants",
  sas: "SAS doctors",
  trainee: "Trainees",
};

const LEAVE_TYPES = ["annual", "sick", "parental", "study", "compassionate", "other"] as const;
type LeaveType = typeof LEAVE_TYPES[number];
const LEAVE_LABEL: Record<LeaveType, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  parental: "Parental leave",
  study: "Study leave",
  compassionate: "Compassionate",
  other: "Other",
};


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

  const [bucket, setBucket] = useState<TraineeBucket>("all");

  const { data: soloMonthly, isLoading: soloLoading } = useQuery({
    queryKey: ["admin-dashboard-solo-monthly"],
    queryFn: async () => {
      // Last 12 full months including current month
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
      const startISO = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
      const endISO = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;

      const [profilesRes, assignmentsRes] = await Promise.all([
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
          .lte("session_date", endISO),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (assignmentsRes.error) throw assignmentsRes.error;

      const months: string[] = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      return {
        profiles: profilesRes.data ?? [],
        assignments: assignmentsRes.data ?? [],
        months,
      };
    },
  });

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
      soloMonthly.profiles.map((p) => [p.id, { id: p.id, grade: p.grade ?? null }]),
    );
    const consultantOnSession = buildConsultantSessionSet(
      soloMonthly.assignments,
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

    for (const a of soloMonthly.assignments) {
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

    const traineeRows = Array.from(perTrainee.entries())
      .map(([id, v]) => {
        const t = traineeIds.get(id)!;
        return {
          id,
          full_name: t.full_name,
          level: t.level,
          solo: v.solo,
          total: v.total,
          pct: v.total > 0 ? Math.round((v.solo / v.total) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.pct - a.pct);

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
    // AM/PM list, role = solo, no supervisor, and no consultant sharing
    // the same theatre_session_id.
    const consultantSessionsToday = new Set<string>();
    for (const a of data.assignments) {
      if (!a.theatre_session_id) continue;
      const p = profilesById.get(a.staff_id);
      if (p?.grade === "consultant") consultantSessionsToday.add(a.theatre_session_id);
    }
    const traineeSolo = data.assignments
      .filter((a) => {
        if (a.duty_type !== "theatre") return false;
        if (a.session !== "am" && a.session !== "pm") return false;
        if (a.role_on_list !== "solo") return false;
        if (a.supervisor_id) return false;
        const p = profilesById.get(a.staff_id);
        if (!p || p.grade !== "trainee") return false;
        // Require a theatre_session_id so we can verify no consultant is on it.
        if (!a.theatre_session_id) return false;
        if (consultantSessionsToday.has(a.theatre_session_id)) return false;
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

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rota dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Daily overview of assignments, leave and availability — {formatDateGB(date)}
          </p>
        </div>
        <div className="flex items-end gap-2">
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
        </div>
      </header>

      {isLoading || !summary ? (
        <div className="text-sm text-muted-foreground">Loading overview…</div>
      ) : (
        <>
          {/* Top-line totals */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Active staff" value={summary.totalActive} icon={Users} />
            <Stat label="Assigned to work" value={summary.totalAssigned} icon={UserCheck} />
            <Stat label="On leave" value={summary.totalOnLeave} icon={UserX} />
            <Stat label="Available" value={summary.totalAvailable} icon={CalendarDays} />
          </div>

          {/* Activity metrics */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Activity (rolling)
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <DualStat
                label="Late rota changes (within 24h of session)"
                icon={Clock}
                d7={activity?.lateRota.d7}
                d30={activity?.lateRota.d30}
              />
              <DualStat
                label="Leave requests rejected"
                icon={XCircle}
                d7={activity?.rejected.d7}
                d30={activity?.rejected.d30}
              />
              <DualStat
                label="Placed on reserve leave list"
                icon={ListChecks}
                d7={activity?.reserve.d7}
                d30={activity?.reserve.d30}
              />
            </div>
          </section>


          {/* Assigned + available by grade */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              By grade
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              {GRADES.map((g) => {
                const assigned = summary.assignedByGrade[g];
                const available = summary.availableByGrade[g];
                const onLeave = Object.values(summary.leaveByGradeType[g]).reduce((a, b) => a + b, 0);
                return (
                  <Card key={g}>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-base">
                        {g === "trainee" ? <GraduationCap className="h-4 w-4" /> : <Stethoscope className="h-4 w-4" />}
                        {GRADE_LABEL[g]}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Assigned</span>
                        <Badge>{assigned}</Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">On leave</span>
                        <Badge variant="secondary">{onLeave}</Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Available</span>
                        <Badge variant="outline">{available.length}</Badge>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          {/* Leave breakdown */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Leave by type
            </h2>
            <Card>
              <CardContent className="p-0">
                <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
                  {LEAVE_TYPES.map((t) => {
                    const total = GRADES.reduce((a, g) => a + summary.leaveByGradeType[g][t], 0);
                    return (
                      <div key={t} className="bg-card p-4">
                        <div className="mb-1 text-xs uppercase text-muted-foreground">{LEAVE_LABEL[t]}</div>
                        <div className="mb-2 text-2xl font-semibold">{total}</div>
                        <div className="flex flex-wrap gap-1 text-xs">
                          {GRADES.map((g) => (
                            <Badge key={g} variant="outline">
                              {GRADE_LABEL[g].split(" ")[0]}: {summary.leaveByGradeType[g][t]}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Trainees solo */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Trainees working solo
            </h2>
            <Card>
              <CardContent className="p-4">
                {summary.traineeSolo.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No trainees flagged as solo on this date.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <span className="font-medium">{summary.traineeSolo.length} trainee(s) solo today</span>
                    </div>
                    <ul className="divide-y rounded-md border">
                      {summary.traineeSolo.map((p) => (
                        <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                          <span>{p.full_name || "—"}</span>
                          {p.training_level && <Badge variant="secondary">{p.training_level}</Badge>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          {/* Solo trainee lists — monthly */}
          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                  Solo trainee lists — last 12 months
                </h2>
                {soloStats && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {soloStats.totalSolo} solo of {soloStats.totalLists} daytime theatre lists
                    {soloStats.totalLists > 0 && (
                      <> ({Math.round((soloStats.totalSolo / soloStats.totalLists) * 1000) / 10}%)</>
                    )} · {BUCKET_LABEL[bucket]}
                  </p>
                )}
              </div>
              <div className="w-48">
                <label className="mb-1 block text-xs text-muted-foreground">Training grade</label>
                <Select value={bucket} onValueChange={(v) => setBucket(v as TraineeBucket)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All trainees</SelectItem>
                    <SelectItem value="junior">CT2–ST4</SelectItem>
                    <SelectItem value="senior">ST5–ST8+</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {soloLoading || !soloStats ? (
              <div className="text-sm text-muted-foreground">Loading solo trainee data…</div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Solo lists per month</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={soloStats.chart} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                          <Tooltip
                            formatter={(value: number, name: string) => {
                              const label = name === "soloLists" ? "Solo lists" : name === "totalLists" ? "Total daytime lists" : name;
                              return [value, label];
                            }}
                          />
                          <Legend formatter={(v: string) => (v === "soloLists" ? "Solo" : "Total daytime")} />
                          <Bar dataKey="totalLists" fill="hsl(var(--muted-foreground))" opacity={0.35} />
                          <Bar dataKey="soloLists" fill="hsl(var(--primary))" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Avg % solo of trainee daytime lists</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={soloStats.chart} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                          <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                          <Tooltip formatter={(v: number) => [`${v}%`, "Avg % solo"]} />
                          <Line type="monotone" dataKey="avgPctSolo" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card className="lg:col-span-2">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Per-trainee summary (12 months)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {soloStats.traineeRows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No data for this grade bucket.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="text-left text-xs uppercase text-muted-foreground">
                            <tr>
                              <th className="py-2 pr-3">Trainee</th>
                              <th className="py-2 pr-3">Level</th>
                              <th className="py-2 pr-3 text-right">Solo</th>
                              <th className="py-2 pr-3 text-right">Daytime lists</th>
                              <th className="py-2 pr-3 text-right">% solo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {soloStats.traineeRows.map((r) => (
                              <tr key={r.id} className="border-t">
                                <td className="py-1.5 pr-3">{r.full_name || "—"}</td>
                                <td className="py-1.5 pr-3 text-muted-foreground">{r.level || "—"}</td>
                                <td className="py-1.5 pr-3 text-right">{r.solo}</td>
                                <td className="py-1.5 pr-3 text-right">{r.total}</td>
                                <td className="py-1.5 pr-3 text-right font-medium">{r.pct}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
            {soloStats && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Debug: solo detection per assignment</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Showing first 300 trainee assignments with intermediate values used to compute solo.
                  </p>
                </CardHeader>
                <CardContent>
                  <details>
                    <summary className="cursor-pointer text-sm">Show / hide ({soloStats.debugRows.length} rows)</summary>
                    <div className="mt-2 max-h-[500px] overflow-auto">
                      <table className="w-full text-xs font-mono">
                        <thead className="text-left uppercase text-muted-foreground sticky top-0 bg-background">
                          <tr>
                            <th className="py-1 pr-2">Trainee</th>
                            <th className="py-1 pr-2">Date</th>
                            <th className="py-1 pr-2">Sess</th>
                            <th className="py-1 pr-2">role_on_list</th>
                            <th className="py-1 pr-2">theatre_session_id</th>
                            <th className="py-1 pr-2">hasConsultant</th>
                            <th className="py-1 pr-2">supervisor_id</th>
                            <th className="py-1 pr-2">supIsCons</th>
                            <th className="py-1 pr-2">isSolo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {soloStats.debugRows.slice(0, 300).map((r, i) => (
                            <tr key={i} className="border-t">
                              <td className="py-1 pr-2">{r.trainee || "—"}</td>
                              <td className="py-1 pr-2">{r.date}</td>
                              <td className="py-1 pr-2">{r.session}</td>
                              <td className="py-1 pr-2">{r.role}</td>
                              <td className="py-1 pr-2">{r.theatre_session_id ? r.theatre_session_id.slice(0, 8) : "—"}</td>
                              <td className="py-1 pr-2">{String(r.hasConsultant)}</td>
                              <td className="py-1 pr-2">{r.supervisor_id ? r.supervisor_id.slice(0, 8) : "—"}</td>
                              <td className="py-1 pr-2">{String(r.supervisorIsConsultant)}</td>
                              <td className="py-1 pr-2 font-bold">{String(r.isSolo)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </CardContent>
              </Card>
            )}
          </section>




          {/* Available list */}
          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Available to assign
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              {GRADES.map((g) => (
                <Card key={g}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">
                      {GRADE_LABEL[g]} ({summary.availableByGrade[g].length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {summary.availableByGrade[g].length === 0 ? (
                      <p className="text-sm text-muted-foreground">None available.</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {summary.availableByGrade[g].map((p) => (
                          <li key={p.id} className="flex items-center justify-between">
                            <span>{p.full_name || "—"}</span>
                            {p.training_level && (
                              <Badge variant="outline" className="text-xs">{p.training_level}</Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DualStat({
  label, icon: Icon, d7, d30,
}: { label: string; icon: typeof Users; d7?: number; d30?: number }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 flex items-baseline gap-4">
            <div>
              <div className="text-xl font-semibold">{d7 ?? "—"}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last 7d</div>
            </div>
            <div>
              <div className="text-xl font-semibold">{d30 ?? "—"}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Last 30d</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label, value, icon: Icon,
}: { label: string; value: number | string; icon: typeof Users }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
