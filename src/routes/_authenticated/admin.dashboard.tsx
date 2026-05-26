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
import { formatDateGB, todayISO } from "@/lib/utils";
import {
  Users, GraduationCap, Stethoscope, UserCheck, UserX,
  CalendarDays, AlertTriangle, Clock, XCircle, ListChecks,
} from "lucide-react";

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
          .select("id, staff_id, role_on_list, session, supervisor_id")
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

    // Trainees working solo: role_on_list = 'solo' for a trainee profile
    const traineeSolo = data.assignments
      .filter((a) => a.role_on_list === "solo")
      .map((a) => profilesById.get(a.staff_id))
      .filter((p): p is NonNullable<typeof p> => !!p && p.grade === "trainee");

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
