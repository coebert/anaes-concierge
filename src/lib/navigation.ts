import {
  Activity,
  AlertTriangle,
  BookOpen,
  Briefcase,
  Building2,
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

export type NavGroupId =
  | "home"
  | "rota"
  | "leave"
  | "staff"
  | "audits"
  | "assistant"
  | "setup"
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
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  defaultOpen?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  { id: "home", label: "Home", defaultOpen: true },
  { id: "rota", label: "Rota", defaultOpen: true },
  { id: "leave", label: "Leave", defaultOpen: true },
  { id: "staff", label: "Staff", defaultOpen: true },
  { id: "audits", label: "Audits & robustness", defaultOpen: true },
  { id: "assistant", label: "Assistant", defaultOpen: true },
  { id: "setup", label: "Setup", defaultOpen: false },
  { id: "account", label: "Account", defaultOpen: true },
];

export const NAV_ITEMS: NavItem[] = [
  // Home
  { id: "home", label: "Home", to: "/", icon: Home, group: "home",
    keywords: ["dashboard", "overview", "start"] },
  { id: "coordinator-inbox", label: "Coordinator inbox", to: "/admin/inbox",
    icon: ClipboardList, group: "home", roles: ["admin", "rota_coordinator"],
    keywords: ["inbox", "pending", "leave", "exception", "RTW", "return to work", "expiry", "competency", "urgent"] },
  { id: "wellbeing-mine", label: "My wellbeing", to: "/wellbeing",
    icon: HeartPulse, group: "home",
    keywords: ["burnout", "score", "retention", "attrition"] },
  { id: "pulse", label: "Wellbeing pulse", to: "/pulse",
    icon: MessageSquare, group: "home",
    keywords: ["survey", "check-in", "wellbeing"] },
  { id: "recognition", label: "Recognition", to: "/recognition",
    icon: Sparkles, group: "home",
    keywords: ["kudos", "thanks", "peer"] },

  // Rota
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
  { id: "rota-me", label: "My rota", to: "/me", icon: CalendarRange, group: "rota" },
  { id: "glossary", label: "Glossary", to: "/glossary", icon: BookOpen, group: "rota",
    keywords: ["terms", "abbreviations", "definitions", "SPA", "NHH", "DCC"] },

  // Leave
  { id: "leave-mine", label: "My leave", to: "/leave", icon: ClipboardList, group: "leave" },
  { id: "leave-approve", label: "Approve leave", to: "/coordinator/leave",
    icon: ClipboardList, group: "leave", roles: ["admin", "rota_coordinator"] },
  { id: "leave-forecast", label: "Leave forecast", to: "/leave/forecast",
    icon: Activity, group: "leave", roles: ["admin", "rota_coordinator"] },
  { id: "leave-calendar", label: "Global calendar", to: "/calendar",
    icon: CalendarDays, group: "leave" },
  { id: "leave-entitlements", label: "My entitlements", to: "/leave/entitlements",
    icon: ClipboardList, group: "leave",
    keywords: ["allowance", "TOIL", "carry over", "study leave", "SPA"] },

  // Staff
  { id: "setup-staff", label: "Staff", to: "/admin/staff",
    icon: Users, group: "staff", roles: ["admin"] },
  { id: "setup-jobplans", label: "Job plans", to: "/admin/job-plans",
    icon: Briefcase, group: "staff", roles: ["admin"] },
  { id: "staff-working-patterns", label: "Working patterns",
    to: "/staff/working-patterns", icon: Users, group: "staff",
    roles: ["admin", "rota_coordinator"],
    keywords: ["consultant", "pattern", "on-call", "SAG", "private", "SPA", "days worked"] },
  { id: "competencies", label: "Competency register", to: "/admin/competencies",
    icon: ShieldCheck, group: "staff", roles: ["admin"],
    keywords: ["competency", "credential", "sign-off", "cardiac", "paeds", "airway", "MTP", "HALO"] },
  { id: "practice-preferences", label: "Practice preferences", to: "/admin/practice-preferences",
    icon: ShieldCheck, group: "staff", roles: ["admin"],
    keywords: ["preferences", "obstetrics", "paediatrics", "cleft palate", "specialty", "consultant", "SAS", "covers"] },
  { id: "my-competencies", label: "My competencies", to: "/me/competencies",
    icon: ShieldCheck, group: "staff", traineeOrAdmin: true,
    keywords: ["competency", "sign-off", "ARCP", "progress", "eligibility", "supervisor"] },
  { id: "supervision", label: "Educational supervision", to: "/admin/supervision",
    icon: GraduationCap, group: "staff", roles: ["admin", "rota_coordinator"],
    keywords: ["ARCP", "trainee", "supervisor", "educational", "readiness", "logbook"] },

  // Audits & robustness
  { id: "robustness", label: "Robustness overview", to: "/robustness",
    icon: ShieldCheck, group: "audits", roles: ["admin", "rota_coordinator"] },
  { id: "robustness-list", label: "List feasibility", to: "/robustness/list-feasibility",
    icon: ShieldCheck, group: "audits", roles: ["admin", "rota_coordinator"] },
  { id: "robustness-consultant", label: "Consultant feasibility",
    to: "/robustness/consultant-feasibility", icon: ShieldCheck, group: "audits",
    roles: ["admin", "rota_coordinator"] },
  { id: "robustness-simulate", label: "Simulator", to: "/robustness/simulate",
    icon: ShieldCheck, group: "audits", roles: ["admin", "rota_coordinator"] },
  { id: "consultant-audits", label: "Consultant audits", to: "/robustness/consultant-audits",
    icon: Stethoscope, group: "audits", roles: ["admin", "rota_coordinator"],
    keywords: ["SPA", "SAG", "non-SAG", "NHH", "consultant"] },
  { id: "poac-audit", label: "POAC audit", to: "/robustness/poac-audit",
    icon: ClipboardList, group: "audits", roles: ["admin", "rota_coordinator"],
    keywords: ["POAC", "POAU", "preassessment", "additional"] },
  { id: "last-minute-changes", label: "Last minute changes audit",
    to: "/robustness/last-minute-changes", icon: Clock, group: "audits",
    roles: ["admin", "rota_coordinator"],
    keywords: ["last minute", "late", "48 hours", "rota change", "trainee move"] },
  { id: "trainees", label: "Trainee audit", to: "/trainees",
    icon: GraduationCap, group: "audits", traineeOrAdmin: true,
    keywords: ["trainee", "ARCP"] },
  { id: "tcs", label: "TCS 2016 audit", to: "/admin/tcs-audit",
    icon: ShieldCheck, group: "audits", roles: ["admin"] },
  { id: "exceptions-mine", label: "My exception reports", to: "/exceptions",
    icon: AlertTriangle, group: "audits", traineeOrAdmin: true,
    keywords: ["exception", "TCS", "hours", "safety", "guardian"] },
  { id: "exceptions-admin", label: "Exception reports (Guardian)", to: "/admin/exceptions",
    icon: ShieldAlert, group: "audits", roles: ["admin"],
    keywords: ["guardian", "safe working", "exception", "SLA"] },
  { id: "absence", label: "Absence (Bradford)", to: "/admin/absence",
    icon: HeartPulse, group: "staff", roles: ["admin"],
    keywords: ["sickness", "bradford", "RTW", "return to work", "attendance"] },
  { id: "leave-fairness", label: "Leave fairness", to: "/admin/leave-fairness",
    icon: Scale, group: "staff", roles: ["admin"],
    keywords: ["denial", "SLA", "prime dates", "TOIL", "entitlement", "gini"] },
  { id: "wellbeing-admin", label: "Wellbeing & attrition", to: "/admin/wellbeing",
    icon: HeartPulse, group: "staff", roles: ["admin"],
    keywords: ["wellbeing", "attrition", "retention", "burnout"] },
  { id: "pulse-admin", label: "Pulse surveys", to: "/admin/pulse",
    icon: MessageSquare, group: "audits", roles: ["admin"],
    keywords: ["pulse", "survey", "wellbeing", "cycle"] },
  { id: "hr-analytics", label: "HR analytics pack", to: "/admin/analytics",
    icon: LineChart, group: "audits", roles: ["admin"],
    keywords: ["fairness", "gini", "denial", "seasonality", "handover", "new starter", "trainee exposure", "on-call inequality", "short notice"] },
  { id: "audit-data", label: "Rota source data", to: "/admin/dashboard",
    icon: LayoutDashboard, group: "audits", roles: ["admin"],
    keywords: ["raw", "ingest", "clwrota"] },
  { id: "audit-ai", label: "AI audit assistant", to: "/admin/audit-tool",
    icon: Sparkles, group: "audits", roles: ["admin"] },

  // Assistant
  { id: "chat", label: "AI assistant", to: "/chat",
    icon: MessageSquare, group: "assistant", roles: ["admin", "rota_coordinator"] },

  // Setup (admin)
  { id: "setup-theatres", label: "Theatres", to: "/admin/theatres",
    icon: Building2, group: "setup", roles: ["admin"] },
  { id: "setup-theatre-aliases", label: "Theatre name aliases", to: "/admin/theatre-aliases",
    icon: Building2, group: "setup", roles: ["admin"] },
  { id: "setup-duty-map", label: "Duty mappings", to: "/admin/duty-mappings",
    icon: Wrench, group: "setup", roles: ["admin"] },
  { id: "setup-duty-cat", label: "Duty categories", to: "/admin/duty-categories",
    icon: Wrench, group: "setup", roles: ["admin"] },
  { id: "setup-rules", label: "Working rules", to: "/admin/rules",
    icon: SlidersHorizontal, group: "setup", roles: ["admin"] },
  { id: "setup-access", label: "Access requests", to: "/admin/access-requests",
    icon: UserPlus, group: "setup", roles: ["admin"] },
  { id: "setup-clwrota", label: "CLWRota sync metrics", to: "/admin/clwrota-metrics",
    icon: LineChart, group: "setup", roles: ["admin"] },
  { id: "setup-clwrota-status", label: "CLWRota sync status", to: "/admin/clwrota-status",
    icon: Activity, group: "setup", roles: ["admin"] },
  { id: "setup-clwrota-steps", label: "CLWRota step status", to: "/admin/clwrota-step-status",
    icon: Activity, group: "setup", roles: ["admin"] },
  { id: "setup-settings", label: "Settings", to: "/admin/settings",
    icon: Settings, group: "setup", roles: ["admin"] },

  // Account
  { id: "account", label: "My account", to: "/account",
    icon: UserCircle, group: "account" },
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
    const arr = m.get(item.group);
    if (arr) arr.push(item);
  }
  return m;
}
