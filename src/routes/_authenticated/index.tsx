import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CalendarDays, ClipboardList, GraduationCap, MessageSquare,
  Building2, Users, Briefcase, SlidersHorizontal, Grid3x3,
  CalendarRange, ArrowRight, Stethoscope,
} from "lucide-react";
import { computeProgress } from "@/lib/competency-utils";

export const Route = createFileRoute("/_authenticated/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { hasRole, grade, loading } = useAuth();
  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (hasRole("admin")) return <AdminDashboard />;
  if (grade === "trainee") return <TraineeDashboard />;
  return <ConsultantSasDashboard />;
}

/* ---------- Shared header ---------- */
function Header({ subtitle }: { subtitle: string }) {
  const { user, fullName, roles, grade } = useAuth();
  const roleLabel = roles.includes("admin")
    ? "Admin"
    : roles.includes("rota_coordinator")
    ? "Coordinator"
    : grade === "trainee"
    ? "Trainee"
    : grade === "consultant"
    ? "Consultant"
    : grade === "sas"
    ? "SAS doctor"
    : "Staff";

  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back{fullName ? `, ${fullName.split(" ")[0]}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">
          {user?.email} · {subtitle}
        </p>
      </div>
      <Badge variant="secondary">{roleLabel} · Salisbury DGH</Badge>
    </header>
  );
}

/* ---------- ADMIN ---------- */
function AdminDashboard() {
  const { data } = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: async () => {
      const [staff, pendingLeave, theatres, trainees] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("active", true),
        supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("theatres").select("id", { count: "exact", head: true }).eq("active", true),
        supabase.from("profiles").select("id", { count: "exact", head: true }).eq("active", true).eq("grade", "trainee"),
      ]);
      return {
        staff: staff.count ?? 0,
        pendingLeave: pendingLeave.count ?? 0,
        theatres: theatres.count ?? 0,
        trainees: trainees.count ?? 0,
      };
    },
  });

  return (
    <div className="space-y-6">
      <Header subtitle="Administrator workspace" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active staff" value={data?.staff ?? "—"} icon={Users} />
        <Stat label="Pending leave" value={data?.pendingLeave ?? "—"} icon={ClipboardList} />
        <Stat label="Trainees" value={data?.trainees ?? "—"} icon={GraduationCap} />
        <Stat label="Theatres" value={data?.theatres ?? "—"} icon={Building2} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Configuration
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard to="/coordinator/rota" icon={CalendarRange}
            title="Rota editor" body="Assign staff to theatre sessions with live rule validation." />
          <ActionCard to="/coordinator/leave" icon={ClipboardList}
            title="Approve leave" body="Review and decide pending leave requests." />
          <ActionCard to="/admin/job-plans" icon={Briefcase}
            title="Job plans" body="Configure PAs, LTFT and weekly fixed sessions." />
          <ActionCard to="/admin/rules" icon={SlidersHorizontal}
            title="Working rules" body="Safety constraints and PA conversion rules." />
          <ActionCard to="/admin/theatre-grid" icon={Grid3x3}
            title="Theatre grid" body="AM/PM theatre sessions by day with specialty links." />
          <ActionCard to="/admin/staff" icon={Users}
            title="Staff" body="Manage profiles, grades and roles." />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Overview
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard to="/calendar" icon={CalendarDays}
            title="Global calendar" body="Full theatre grid view by day, week or month." />
          <ActionCard to="/trainees" icon={GraduationCap}
            title="Trainee progress" body="Subspecialty exposure against curriculum targets." />
          <ActionCard to="/chat" icon={MessageSquare}
            title="AI assistant" body="Ask plain-English questions about rotas and leave." />
        </div>
      </section>
    </div>
  );
}

/* ---------- CONSULTANT / SAS ---------- */
function ConsultantSasDashboard() {
  const { user } = useAuth();
  const { data } = useQuery({
    enabled: !!user?.id,
    queryKey: ["consultant-dashboard", user?.id],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const in14 = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
      const [upcoming, pendingLeave, jobPlan] = await Promise.all([
        supabase
          .from("rota_assignments")
          .select("id", { count: "exact", head: true })
          .eq("staff_id", user!.id)
          .gte("session_date", today)
          .lte("session_date", in14),
        supabase
          .from("leave_requests")
          .select("id", { count: "exact", head: true })
          .eq("staff_id", user!.id)
          .eq("status", "pending"),
        supabase
          .from("job_plans")
          .select("total_pas,dcc_pas,spa_pas,ltft_percentage")
          .eq("staff_id", user!.id)
          .maybeSingle(),
      ]);
      return {
        upcoming: upcoming.count ?? 0,
        pendingLeave: pendingLeave.count ?? 0,
        jobPlan: jobPlan.data ?? null,
      };
    },
  });

  return (
    <div className="space-y-6">
      <Header subtitle="Your clinical workspace" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions next 14 days" value={data?.upcoming ?? "—"} icon={CalendarRange} />
        <Stat label="Pending leave" value={data?.pendingLeave ?? "—"} icon={ClipboardList} />
        <Stat label="Total PAs" value={data?.jobPlan?.total_pas ?? "—"} icon={Briefcase} />
        <Stat label="LTFT %" value={data?.jobPlan?.ltft_percent ?? "—"} icon={Stethoscope} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ActionCard to="/me" icon={CalendarRange}
          title="My rota" body="Your upcoming theatre, on-call and SPA sessions." />
        <ActionCard to="/calendar" icon={CalendarDays}
          title="Global calendar" body="See the full department theatre grid." />
        <ActionCard to="/leave" icon={ClipboardList}
          title="Leave" body="Request annual, study or compassionate leave." />
        <ActionCard to="/chat" icon={MessageSquare}
          title="AI assistant" body="Ask about your rota, swaps or job plan." />
      </div>
    </div>
  );
}

/* ---------- TRAINEE ---------- */
function TraineeDashboard() {
  const { user } = useAuth();
  const { data } = useQuery({
    enabled: !!user?.id,
    queryKey: ["trainee-dashboard", user?.id],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const in14 = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
      const [{ count: upcoming }, { count: pendingLeave }, targets, specs, assignments] =
        await Promise.all([
          supabase.from("rota_assignments").select("id", { count: "exact", head: true })
            .eq("staff_id", user!.id).gte("session_date", today).lte("session_date", in14),
          supabase.from("leave_requests").select("id", { count: "exact", head: true })
            .eq("staff_id", user!.id).eq("status", "pending"),
          supabase.from("trainee_targets").select("*").eq("staff_id", user!.id),
          supabase.from("specialties").select("id,name"),
          supabase
            .from("rota_assignments")
            .select("specialty_id,session_date")
            .eq("staff_id", user!.id)
            .lte("session_date", today),
        ]);
      const progress = computeProgress(
        (targets.data ?? []) as never,
        (assignments.data ?? []) as never,
        (specs.data ?? []) as never,
      );
      return {
        upcoming: upcoming ?? 0,
        pendingLeave: pendingLeave ?? 0,
        progress: progress.slice(0, 4),
      };
    },
  });

  return (
    <div className="space-y-6">
      <Header subtitle="Your training workspace" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Sessions next 14 days" value={data?.upcoming ?? "—"} icon={CalendarRange} />
        <Stat label="Pending leave" value={data?.pendingLeave ?? "—"} icon={ClipboardList} />
        <Stat label="Tracked specialties" value={data?.progress.length ?? "—"} icon={GraduationCap} />
      </div>

      {data?.progress && data.progress.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Curriculum progress</CardTitle>
            <CardDescription>Snapshot of your top tracked subspecialties.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.progress.map((p) => (
              <div key={p.specialtyId}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span>{p.specialtyName}</span>
                  <span className="text-muted-foreground">
                    {p.completed}/{p.target}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.min(100, (p.completed / Math.max(1, p.target)) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="pt-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/trainees">View full progress <ArrowRight className="ml-1 h-3 w-3" /></Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ActionCard to="/me" icon={CalendarRange}
          title="My rota" body="Your upcoming sessions and supervisors." />
        <ActionCard to="/trainees" icon={GraduationCap}
          title="Trainee progress" body="Detailed subspecialty exposure tracker." />
        <ActionCard to="/leave" icon={ClipboardList}
          title="Leave" body="Request study, annual or compassionate leave." />
        <ActionCard to="/chat" icon={MessageSquare}
          title="AI assistant" body="Ask about rotas, supervisors and curriculum." />
      </div>
    </div>
  );
}

/* ---------- Building blocks ---------- */
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

function ActionCard({
  to, icon: Icon, title, body,
}: { to: string; icon: typeof Users; title: string; body: string }) {
  return (
    <Link to={to} className="group">
      <Card className="h-full transition-colors group-hover:border-primary/40">
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </div>
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
