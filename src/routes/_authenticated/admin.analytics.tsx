import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Scale,
  Clock,
  XCircle,
  GraduationCap,
  Users,
  Thermometer,
  ArrowRightLeft,
  AlertTriangle,
  CalendarClock,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/analytics")({
  head: () => ({
    meta: [
      { title: "HR analytics pack — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Eight HR analyses over rota, leave, sickness, exception and new-starter data: allocation fairness, short-notice changes, leave denials, trainee exposure, on-call inequality, sickness seasonality, handover risk, new-starter early warning.",
      },
    ],
  }),
  component: AnalyticsIndex,
});

const CARDS: Array<{
  to:
    | "/admin/analytics/allocation-fairness"
    | "/admin/analytics/short-notice"
    | "/admin/analytics/leave-denials"
    | "/admin/analytics/trainee-exposure"
    | "/admin/analytics/oncall-inequality"
    | "/admin/analytics/sickness-seasonality"
    | "/admin/analytics/handover-risk"
    | "/admin/analytics/new-starters";
  title: string;
  blurb: string;
  Icon: typeof Scale;
}> = [
  {
    to: "/admin/analytics/allocation-fairness",
    title: "1. Allocation fairness",
    blurb:
      "Per-doctor Gini across list types, weekends and on-calls over 12 months.",
    Icon: Scale,
  },
  {
    to: "/admin/analytics/short-notice",
    title: "2. Short-notice changes",
    blurb:
      "Who is disproportionately absorbing changes made ≤48h before a session.",
    Icon: Clock,
  },
  {
    to: "/admin/analytics/leave-denials",
    title: "3. Leave denials",
    blurb:
      "Denial-reason taxonomy inferred from decision notes, by month and grade.",
    Icon: XCircle,
  },
  {
    to: "/admin/analytics/trainee-exposure",
    title: "4. Trainee educational exposure",
    blurb:
      "Sessions delivered vs curriculum target per trainee — ARCP under-exposure alerts.",
    Icon: GraduationCap,
  },
  {
    to: "/admin/analytics/oncall-inequality",
    title: "5. On-call frequency inequality",
    blurb:
      "Consultant on-calls per WTE, banded by LTFT fraction; outlier flags.",
    Icon: Users,
  },
  {
    to: "/admin/analytics/sickness-seasonality",
    title: "6. Sickness seasonality",
    blurb:
      "Absence-days by month; Pearson correlation vs rota session density.",
    Icon: Thermometer,
  },
  {
    to: "/admin/analytics/handover-risk",
    title: "7. Handover-adjacency risk",
    blurb:
      "Back-to-back high-acuity sessions for the same consultant on the same day.",
    Icon: ArrowRightLeft,
  },
  {
    to: "/admin/analytics/new-starters",
    title: "8. New-starter early warning",
    blurb:
      "First-90-days sickness, exception reports and short-notice changes.",
    Icon: AlertTriangle,
  },
];

function AnalyticsIndex() {
  const { hasRole, loading } = useAuth();
  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="HR analytics pack"
        description="Analyses HR is likely to ask for tomorrow — computed over data the app already holds. Click any card for the detailed report."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(({ to, title, blurb, Icon }) => (
          <Link key={to} to={to} className="block">
            <Card className="h-full transition hover:border-primary">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <Icon className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">{title}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {blurb}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
