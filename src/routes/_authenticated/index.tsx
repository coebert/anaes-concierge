import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CalendarDays, ClipboardList, GraduationCap, MessageSquare,
  Briefcase, CalendarRange, Stethoscope, Activity, AlertTriangle,
  RefreshCw, ShieldAlert, Users,
} from "lucide-react";
import { todayISO, addDaysISO, formatDateGB } from "@/lib/utils";
import { SummaryDashboard } from "@/components/summary-dashboard";

export const Route = createFileRoute("/_authenticated/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { hasRole, grade, loading } = useAuth();
  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (hasRole("admin") || hasRole("rota_coordinator")) return <AuditDashboard />;
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

/* ---------- AUDIT DASHBOARD (admin + coordinator) ---------- */
function AuditDashboard() {
  const today = todayISO();
  const in90 = addDaysISO(90);

  const { data } = useQuery({
    queryKey: ["audit-dashboard"],
    queryFn: async () => {
      const [trainees, leaveSoon, sync, rotaRows] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true })
          .eq("active", true).eq("grade", "trainee"),
        supabase.from("leave_requests").select("id", { count: "exact", head: true })
          .in("status", ["approved", "pending"])
          .lte("start_date", in90).gte("end_date", today),
        supabase.from("clwrota_sync_state").select("last_sync_at, last_status, last_error")
          .eq("id", 1).maybeSingle(),
        supabase.from("rota_assignments").select("id", { count: "exact", head: true })
          .gte("session_date", today).lte("session_date", in90),
      ]);
      return {
        trainees: trainees.count ?? 0,
        leaveSoon: leaveSoon.count ?? 0,
        rotaRows: rotaRows.count ?? 0,
        sync: sync.data ?? null,
      };
    },
  });

  const syncOk = data?.sync?.last_status?.includes("success") ?? false;
  const syncWarning = data?.sync && !syncOk;

  return (
    <div className="space-y-6">
      <Header subtitle="Audit workspace — synced from CLWRota" />

      {/* Sync freshness banner */}
      <Card className={syncWarning ? "border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20" : ""}>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <div className={`flex h-9 w-9 items-center justify-center rounded-md ${syncWarning ? "bg-amber-500/15 text-amber-600" : "bg-emerald-500/10 text-emerald-600"}`}>
              {syncWarning ? <AlertTriangle className="h-5 w-5" /> : <RefreshCw className="h-5 w-5" />}
            </div>
            <div>
              <div className="text-sm font-medium">
                {data?.sync?.last_sync_at
                  ? `Last sync: ${formatDateGB(data.sync.last_sync_at)}`
                  : "No sync recorded yet"}
              </div>
              <div className="text-xs text-muted-foreground">
                Status: {data?.sync?.last_status ?? "—"}
                {data?.sync?.last_error ? ` · ${data.sync.last_error.slice(0, 80)}` : ""}
              </div>
            </div>
          </div>
          <Link to="/admin/settings" className="text-xs font-medium text-primary hover:underline">
            Sync settings →
          </Link>
        </CardContent>
      </Card>

      <SummaryDashboard />

      {/* Audit pillars */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Audit pillars
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <PillarCard
            to="/trainees"
            icon={GraduationCap}
            title="Trainee experience"
            body="Specialty breadth, solo/supervised mix, named supervisor exposure, and training-list displacement against curriculum targets."
            stat={`${data?.trainees ?? "—"} active trainees`}
          />
          <PillarCard
            to="/leave/forecast"
            icon={ClipboardList}
            title="Leave pressure"
            body="Heatmap of approved + pending leave across the calendar; predict surge weeks and recurring hot spots."
            stat={`${data?.leaveSoon ?? "—"} leave items next 90d`}
          />
          <PillarCard
            to="/robustness"
            icon={ShieldAlert}
            title="Rota robustness"
            body="Coverage headroom per session; what-if simulator for sickness scenarios and trainee displacement."
            stat="Forward-looking risk report"
          />

        </div>
      </section>

      {/* At-a-glance */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          At-a-glance
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Synced rota items (next 90d)" value={data?.rotaRows ?? "—"} icon={Activity} />
          <Stat label="Active trainees" value={data?.trainees ?? "—"} icon={GraduationCap} />
          <Stat label="Leave next 90d" value={data?.leaveSoon ?? "—"} icon={ClipboardList} />
          <Stat label="Sync status" value={syncOk ? "Healthy" : "Check"} icon={RefreshCw} />
        </div>
      </section>

      {/* Coordinator tools (de-emphasised) */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Coordinator tools
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ActionCard to="/coordinator/rota" icon={CalendarRange}
            title="Rota editor" body="Manual edits and AI-assisted candidate suggestions." />
          <ActionCard to="/coordinator/leave" icon={ClipboardList}
            title="Approve leave" body="Review and decide pending leave requests." />
          <ActionCard to="/chat" icon={MessageSquare}
            title="AI assistant" body="Plain-English questions about rotas, leave and training." />
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
      const today = todayISO();
      const in14 = addDaysISO(14);
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
        <Stat label={<GlossaryTerm>LTFT</GlossaryTerm>} value={data?.jobPlan?.ltft_percentage ?? "—"} icon={Stethoscope} />
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
      const today = todayISO();
      const in14 = addDaysISO(14);
      const [upcoming, pendingLeave, pastLogged, profile] = await Promise.all([
        supabase.from("rota_assignments").select("id", { count: "exact", head: true })
          .eq("staff_id", user!.id).gte("session_date", today).lte("session_date", in14),
        supabase.from("leave_requests").select("id", { count: "exact", head: true })
          .eq("staff_id", user!.id).eq("status", "pending"),
        supabase.from("rota_assignments").select("id", { count: "exact", head: true })
          .eq("staff_id", user!.id).lte("session_date", today)
          .in("role_on_list", ["solo", "supervised"]),
        supabase.from("profiles").select("training_level").eq("id", user!.id).maybeSingle(),
      ]);
      return {
        upcoming: upcoming.count ?? 0,
        pendingLeave: pendingLeave.count ?? 0,
        pastLogged: pastLogged.count ?? 0,
        trainingLevel: profile.data?.training_level ?? null,
      };
    },
  });

  return (
    <div className="space-y-6">
      <Header subtitle="Your training workspace" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions next 14 days" value={data?.upcoming ?? "—"} icon={CalendarRange} />
        <Stat label="Pending leave" value={data?.pendingLeave ?? "—"} icon={ClipboardList} />
        <Stat label="Sessions logged" value={data?.pastLogged ?? "—"} icon={GraduationCap} />
        <Stat label="Training level" value={data?.trainingLevel ?? "—"} icon={Stethoscope} />
      </div>

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

function PillarCard({
  to, icon: Icon, title, body, stat,
}: { to: string; icon: typeof Users; title: string; body: string; stat: string }) {
  return (
    <Link to={to} className="group">
      <Card className="h-full transition-all group-hover:border-primary/60 group-hover:shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription className="text-xs">{stat}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

