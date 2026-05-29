import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  CalendarDays,
  LayoutDashboard,
  CalendarRange,
  GraduationCap,
  MessageSquare,
  Settings,
  LogOut,
  Stethoscope,
  ClipboardList,
  Users,
  Building2,
  Briefcase,
  SlidersHorizontal,
  ShieldCheck,
  Grid3x3,
  UserPlus,
  UserCircle,
  Activity,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles?: Array<"admin" | "rota_coordinator" | "staff">;
  traineeOnly?: boolean;
}

// Primary nav: audit-first. The app exists to surface insights from synced
// CLWRota data — trainee experience, leave pressure, rota robustness.
const NAV: NavItem[] = [
  { to: "/", label: "Audit dashboard", icon: LayoutDashboard },
  { to: "/trainees", label: "Trainee audit", icon: GraduationCap, traineeOnly: true },
  { to: "/leave", label: "Leave", icon: ClipboardList },
  { to: "/calendar", label: "Global calendar", icon: CalendarDays },
  { to: "/me", label: "My rota", icon: CalendarRange },
  { to: "/account", label: "My account", icon: UserCircle },
];

// Coordinator tools: AI-assisted rota writing, custom rules, manual editor.
// Kept available but de-emphasised — the app's primary purpose is auditing
// existing CLWRota data, not generating new rotas.
const COORDINATOR_NAV: NavItem[] = [
  { to: "/coordinator/rota", label: "Rota editor", icon: CalendarRange, roles: ["admin", "rota_coordinator"] },
  { to: "/coordinator/duties", label: "Duties & on-call", icon: Stethoscope, roles: ["admin", "rota_coordinator"] },
  { to: "/coordinator/leave", label: "Approve leave", icon: ClipboardList, roles: ["admin", "rota_coordinator"] },
  { to: "/chat", label: "AI assistant", icon: MessageSquare, roles: ["admin", "rota_coordinator"] },
  { to: "/admin/rules", label: "Working rules", icon: SlidersHorizontal, roles: ["admin"] },
];

const ADMIN_NAV: NavItem[] = [
  { to: "/admin/dashboard", label: "Rota audit data", icon: Activity, roles: ["admin"] },
  { to: "/admin/tcs-audit", label: "TCS 2016 audit", icon: ShieldCheck, roles: ["admin"] },
  { to: "/admin/staff", label: "Staff", icon: Users, roles: ["admin"] },
  { to: "/admin/access-requests", label: "Access requests", icon: UserPlus, roles: ["admin"] },
  { to: "/admin/job-plans", label: "Job plans", icon: Briefcase, roles: ["admin"] },
  { to: "/admin/theatres", label: "Theatres", icon: Building2, roles: ["admin"] },
  { to: "/admin/theatre-grid", label: "Theatre grid", icon: Grid3x3, roles: ["admin"] },
  { to: "/admin/settings", label: "Settings", icon: Settings, roles: ["admin"] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut, user, roles, hasRole, grade } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const handleSignOut = async () => {
    await signOut();
    void navigate({ to: "/login" });
  };

  const isAdmin = hasRole("admin");
  const visibleMain = NAV.filter(
    (i) => !i.traineeOnly || isAdmin || grade === "trainee",
  );
  const visibleCoord = COORDINATOR_NAV.filter(
    (i) => !i.roles || i.roles.some((r) => hasRole(r)),
  );
  const visibleAdmin = ADMIN_NAV.filter(
    (i) => !i.roles || i.roles.some((r) => hasRole(r)),
  );

  const roleLabel = isAdmin
    ? "Admin"
    : roles.includes("rota_coordinator")
    ? "Coordinator"
    : grade === "trainee"
    ? "Trainee"
    : grade === "consultant"
    ? "Consultant"
    : grade === "sas"
    ? "SAS"
    : "Staff";

  return (
    <div className="flex min-h-screen bg-muted/30">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex items-center gap-2 border-b px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Stethoscope className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Anaesthetics Audit</div>
            <div className="truncate text-xs text-muted-foreground">Salisbury DGH</div>
          </div>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-2 py-4 text-sm">
          <NavSection items={visibleMain} currentPath={location.pathname} />

          {visibleCoord.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Wrench className="h-3 w-3" />
                Coordinator tools
              </div>
              <NavSection items={visibleCoord} currentPath={location.pathname} />
            </div>
          )}

          {visibleAdmin.length > 0 && (
            <div className="space-y-1">
              <div className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Administration
              </div>
              <NavSection items={visibleAdmin} currentPath={location.pathname} />
            </div>
          )}
        </nav>

        <div className="space-y-2 border-t p-3 text-sm">
          <div className="px-1">
            <div className="truncate font-medium">{user?.email}</div>
            <div className="text-xs text-muted-foreground">{roleLabel}</div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="mx-auto max-w-7xl p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}


function NavSection({ items, currentPath }: { items: NavItem[]; currentPath: string }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const Icon = item.icon;
        const active =
          item.to === "/"
            ? currentPath === "/"
            : currentPath === item.to || currentPath.startsWith(item.to + "/");
        return (
          <li key={item.to}>
            <Link
              to={item.to}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
