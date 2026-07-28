import {
  Activity,
  AlertTriangle,
  BookOpen,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX,
  ClipboardList,
  Clock,
  GraduationCap,
  Grid3x3,
  HeartPulse,
  Home,
  LayoutDashboard,
  LineChart,
  MessageSquare,
  Scale,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  UserCircle,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type AppRole = "admin" | "rota_coordinator" | "staff";

/**
 * Navigation groups are ordered top→bottom. The visual model is three
 * audience-driven bands:
 *   1. "For me"     — things any signed-in user does with their own data
 *   2. Shared tools — rota, leave admin, assistant (coord + admin surface)
 *   3. Admin        — subdivided into Staff / Robustness / Analytics /
 *                     Compliance / Setup, so the previous 17-item
 *                     "Audits & robustness" bucket is now three focused
 *                     groups.
 * Items flagged `rare: true` are tucked behind a "More" expander so the
 * sidebar isn't visually dominated by seldom-used setup screens.
 */
export type NavGroupId =
  | "mine"
  | "rota"
  | "leave_admin"
  | "assistant"
  | "staff"
  | "robustness"
  | "analytics"
  | "compliance"
  | "setup"
  // Legacy: kept so old tests / callers that filter on the old value still
  // compile. No items reference it any more.
  | "audits"
  | "home"
  | "leave"
  | "account";

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** If set, the item is only visible to users with one of these roles. */
  roles?: AppRole[];
  /** If true, also visible when the user's grade is "trainee". */
  traineeOrAdmin?: boolean;
  /** Keywords improve command-palette matching. */
  keywords?: string[];
  /**
   * If true, the item is hidden inside a "More" expander at the bottom of
   * its group. It stays fully searchable via the ⌘K command palette.
   */
  rare?: boolean;
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  defaultOpen?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  { id: "mine", label: "For me", defaultOpen: true },
  { id: "rota", label: "Rota", defaultOpen: true },
  { id: "leave_admin", label: "Leave admin", defaultOpen: true },
  { id: "assistant", label: "Assistant", defaultOpen: true },
  { id: "staff", label: "Admin · Staff", defaultOpen: false },
  { id: "robustness", label: "Admin · Robustness", defaultOpen: false },
  { id: "analytics", label: "Admin · Analytics", defaultOpen: false },
  { id: "compliance", label: "Admin · Compliance", defaultOpen: false },
  { id: "setup", label: "Admin · Setup", defaultOpen: false },
];

export const NAV_ITEMS: NavItem[] = [
  // ── For me ─────────────────────────────────────────────────────────────
  { id: "home", label: "Home", to: "/", icon: Home, group: "mine",
    keywords: ["dashboard", "overview", "start"] },
  { id: "rota-me", label: "My rota", to: "/me", icon: CalendarRange, group: "mine",
    keywords: ["profile", "schedule"] },
  { id: "leave-mine", label: "My leave", to: "/leave",
    icon: ClipboardList, group: "mine" },
  { id: "leave-entitlements", label: "My entitlements", to: "/leave/entitlements",
    icon: ClipboardList, group: "mine",
    keywords: ["allowance", "TOIL", "carry over", "study leave", "SPA"] },
  { id: "leave-calendar", label: "Global calendar", to: "/calendar",
    icon: CalendarDays, group: "mine" },
  { id: "my-competencies", label: "My competencies", to: "/me/competencies",
    icon: ShieldCheck, group: "mine", traineeOrAdmin: true,
    keywords: ["competency", "sign-off", "ARCP", "progress", "eligibility", "supervisor"] },
  { id: "exceptions-mine", label: "My exception reports", to: "/exceptions",
    icon: AlertTriangle, group: "mine", traineeOrAdmin: true,
    keywords: ["exception", "TCS", "hours", "safety", "guardian"] },
  { id: "wellbeing-mine", label: "My wellbeing", to: "/wellbeing",
    icon: HeartPulse, group: "mine",
    keywords: ["burnout", "score", "retention", "attrition"] },
  { id: "pulse", label: "Wellbeing pulse", to: "/pulse",
    icon: MessageSquare, group: "mine",
    keywords: ["survey", "check-in", "wellbeing"] },
  { id: "recognition", label: "Recognition", to: "/recognition",
    icon: Sparkles, group: "mine",
    keywords: ["kudos", "thanks", "peer"] },
  { id: "account", label: "My account", to: "/account",
    icon: UserCircle, group: "mine",
    keywords: ["settings", "password", "passkeys", "profile"] },

  // ── Rota (shared) ──────────────────────────────────────────────────────
  { id: "rota-theatre", label: "Theatre rota", to: "/coordinator/rota",
    icon: CalendarRange, group: "rota", roles: ["admin", "rota_coordinator"],
    keywords: ["editor", "weekly", "lists"] },
  { id: "rota-grid", label: "Theatre grid", to: "/admin/theatre-grid",
    icon: Grid3x3, group: "rota", roles: ["admin"],
    keywords: ["sessions", "am", "pm"] },
  { id: "rota-duties", label: "Duties & on-call", to: "/coordinator/duties",
    icon: Stethoscope, group: "rota", roles: ["admin", "rota_coordinator"] },
  { id: "rota-gaps", label: "Rota gaps", to: "/admin/rota-gaps",
    icon: CalendarX, group: "rota", roles: ["admin"] },
  { id: "glossary", label: "Glossary", to: "/glossary", icon: BookOpen, group: "rota",
    keywords: ["terms", "abbreviations", "definitions", "SPA", "NHH", "DCC"] },

  // ── Leave admin ────────────────────────────────────────────────────────
  { id: "leave-approve", label: "Approve leave", to: "/coordinator/leave",
    icon: ClipboardList, group: "leave_admin", roles: ["admin", "rota_coordinator"] },
  { id: "leave-forecast", label: "Leave forecast", to: "/leave/forecast",
    icon: Activity, group: "leave_admin", roles: ["admin", "rota_coordinator"] },

  // ── Assistant ──────────────────────────────────────────────────────────
  { id: "coordinator-inbox", label: "Coordinator inbox", to: "/admin/inbox",
    icon: ClipboardList, group: "assistant", roles: ["admin", "rota_coordinator"],
    keywords: ["inbox", "pending", "leave", "exception", "RTW", "return to work", "expiry", "competency", "urgent"] },
  { id: "chat", label: "AI assistant", to: "/chat",
    icon: MessageSquare, group: "assistant", roles: ["admin", "rota_coordinator"] },

  // ── Admin · Staff ──────────────────────────────────────────────────────
  { id: "setup-staff", label: "Staff", to: "/admin/staff",
    icon: Users, group: "staff", roles: ["admin"] },
  { id: "setup-jobplans", label: "Job plans", to: "/admin/job-plans",
    icon: Briefcase, group: "staff", roles: ["admin"] },
  { id: "staff-working-patterns", label: "Working patterns",
    to: "/staff/working-patterns", icon: Users, group: "staff",
    roles: ["admin", "rota_coordinator"],
    keywords: ["consultant", "pattern", "on-call", "SAG", "private", "SPA", "days worked"] },
  { id: "absence", label: "Absence (Bradford)", to: "/admin/absence",
    icon: HeartPulse, group: "staff", roles: ["admin", "rota_coordinator"],
    keywords: ["absence", "bradford", "sickness", "leave", "sick leave", "attendance"] },
  { id: "leave-fairness", label: "Leave fairness", to: "/admin/leave-fairness",
    icon: Scale, group: "staff", roles: ["admin", "rota_coordinator"],
    keywords: ["leave", "fairness", "gini", "equity", "allocation", "annual leave"] },
  { id: "wellbeing-admin", label: "Wellbeing & attrition", to: "/admin/wellbeing",
    icon: HeartPulse, group: "staff", roles: ["admin"],
    keywords: ["wellbeing", "burnout", "attrition", "retention", "risk", "score"] },
  { id: "competencies", label: "Competency register", to: "/admin/competencies",
    icon: ShieldCheck, group: "staff", roles: ["admin"],
    keywords: ["competency", "credential", "sign-off", "cardiac", "paeds", "airway", "MTP", "HALO"] },
  { id: "practice-preferences", label: "Practice preferences", to: "/admin/practice-preferences",
    icon: ShieldCheck, group: "staff", roles: ["admin"],
    keywords: ["preferences", "obstetrics", "paediatrics", "cleft palate", "specialty", "consultant", "SAS", "covers"] },
  { id: "supervision", label: "Educational supervision", to: "/admin/supervision",
    icon: GraduationCap, group: "staff", roles: ["admin", "rota_coordinator"],
    keywords: ["ARCP", "trainee", "supervisor", "educational", "readiness", "logbook"] },

  // ── Admin · Robustness ────────────────────────────────────────────────
  { id: "robustness", label: "Robustness overview", to: "/robustness",
    icon: ShieldCheck, group: "robustness", roles: ["admin", "rota_coordinator"] },
  { id: "robustness-consultant", label: "Consultant feasibility",
    to: "/robustness/consultant-feasibility", icon: ShieldCheck, group: "robustness",
    roles: ["admin", "rota_coordinator"] },
  { id: "robustness-list", label: "List feasibility", to: "/robustness/list-feasibility",
    icon: ShieldCheck, group: "robustness", roles: ["admin", "rota_coordinator"] },
  { id: "robustness-simulate", label: "Simulator", to: "/robustness/simulate",
    icon: ShieldCheck, group: "robustness", roles: ["admin", "rota_coordinator"] },
  { id: "last-minute-changes", label: "Last minute changes",
    to: "/robustness/last-minute-changes", icon: Clock, group: "robustness",
    roles: ["admin", "rota_coordinator"],
    keywords: ["last minute", "late", "48 hours", "rota change", "trainee move"] },

  // ── Admin · Analytics ─────────────────────────────────────────────────
  { id: "hr-analytics", label: "HR analytics pack", to: "/admin/analytics",
    icon: LineChart, group: "analytics", roles: ["admin"],
    keywords: ["fairness", "gini", "denial", "seasonality", "handover", "new starter", "trainee exposure", "on-call inequality", "short notice"] },
  { id: "weekend-workload", label: "Weekend workload (job plan)",
    to: "/admin/weekend-workload",
    icon: CalendarClock, group: "analytics", roles: ["admin"],
    keywords: ["weekend", "saturday", "sunday", "job plan", "workload", "permanent", "consultant", "sas"] },
  { id: "pulse-admin", label: "Pulse surveys", to: "/admin/pulse",
    icon: MessageSquare, group: "analytics", roles: ["admin"],
    keywords: ["pulse", "survey", "wellbeing", "cycle"] },
  { id: "audit-ai", label: "AI audit assistant", to: "/admin/audit-tool",
    icon: Sparkles, group: "analytics", roles: ["admin"] },
  { id: "tutorials-audit", label: "Tutorials", to: "/admin/tutorials",
    icon: GraduationCap, group: "analytics", roles: ["admin", "rota_coordinator"],
    keywords: ["tutorial", "tutorials", "lecture", "teaching", "departmental teaching", "consultant", "sas"] },
  { id: "audit-data", label: "Rota source data", to: "/admin/dashboard",
    icon: LayoutDashboard, group: "analytics", roles: ["admin"],
    keywords: ["raw", "ingest", "clwrota"] },

  // ── Admin · Compliance ────────────────────────────────────────────────
  { id: "tcs", label: "TCS 2016 audit", to: "/admin/tcs-audit",
    icon: ShieldCheck, group: "compliance", roles: ["admin"] },
  { id: "exceptions-admin", label: "Exception reports (Guardian)", to: "/admin/exceptions",
    icon: ShieldAlert, group: "compliance", roles: ["admin"],
    keywords: ["guardian", "safe working", "exception", "SLA"] },
  { id: "consultant-audits", label: "Consultant audits", to: "/robustness/consultant-audits",
    icon: Stethoscope, group: "compliance", roles: ["admin", "rota_coordinator"],
    keywords: ["SPA", "SAG", "non-SAG", "NHH", "consultant"] },
  { id: "poac-audit", label: "POAC audit", to: "/robustness/poac-audit",
    icon: ClipboardList, group: "compliance", roles: ["admin", "rota_coordinator"],
    keywords: ["POAC", "POAU", "preassessment", "additional"] },
  { id: "trainees", label: "Trainee audit", to: "/trainees",
    icon: GraduationCap, group: "compliance", traineeOrAdmin: true,
    keywords: ["trainee", "ARCP"] },

  // ── Admin · Setup ─────────────────────────────────────────────────────
  { id: "setup-theatres", label: "Theatres", to: "/admin/theatres",
    icon: Building2, group: "setup", roles: ["admin"] },
  { id: "setup-duty-map", label: "Duty mappings", to: "/admin/duty-mappings",
    icon: Wrench, group: "setup", roles: ["admin"] },
  { id: "setup-rules", label: "Working rules", to: "/admin/rules",
    icon: SlidersHorizontal, group: "setup", roles: ["admin"] },
  { id: "setup-access", label: "Access requests", to: "/admin/access-requests",
    icon: UserPlus, group: "setup", roles: ["admin"] },
  { id: "setup-clwrota-status", label: "CLWRota sync", to: "/admin/clwrota-status",
    icon: Activity, group: "setup", roles: ["admin"],
    keywords: ["clwrota", "sync", "status"] },
  { id: "setup-settings", label: "Settings", to: "/admin/settings",
    icon: Settings, group: "setup", roles: ["admin"] },
  // Rarely-used setup items — tucked behind "More" but still ⌘K searchable.
  { id: "setup-theatre-aliases", label: "Theatre name aliases", to: "/admin/theatre-aliases",
    icon: Building2, group: "setup", roles: ["admin"], rare: true },
  { id: "setup-duty-cat", label: "Duty categories", to: "/admin/duty-categories",
    icon: Wrench, group: "setup", roles: ["admin"], rare: true },
  { id: "setup-clwrota", label: "CLWRota sync metrics", to: "/admin/clwrota-metrics",
    icon: LineChart, group: "setup", roles: ["admin"], rare: true,
    keywords: ["clwrota", "metrics"] },
  { id: "setup-clwrota-steps", label: "CLWRota step status", to: "/admin/clwrota-step-status",
    icon: Activity, group: "setup", roles: ["admin"], rare: true,
    keywords: ["clwrota", "steps"] },
];

export function filterNavForUser(opts: {
  hasRole: (r: AppRole) => boolean;
  grade?: string | null;
}): NavItem[] {
  const isAdmin = opts.hasRole("admin");
  const isTrainee = opts.grade === "trainee";
  return NAV_ITEMS.filter((item) => {
    if (item.traineeOrAdmin && !(isAdmin || isTrainee)) return false;
    if (item.roles && !item.roles.some((r) => opts.hasRole(r))) return false;
    return true;
  });
}

export function groupNav(items: NavItem[]): Map<NavGroupId, NavItem[]> {
  const m = new Map<NavGroupId, NavItem[]>();
  for (const g of NAV_GROUPS) m.set(g.id, []);
  for (const item of items) {
    let arr = m.get(item.group);
    if (!arr) {
      arr = [];
      m.set(item.group, arr);
    }
    arr.push(item);
  }
  return m;
}
