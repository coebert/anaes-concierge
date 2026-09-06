import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Activity, AlertTriangle, CalendarDays, HeartPulse, Moon } from "lucide-react";
import {
  appraisalYearLabel,
  appraisalYearOf,
  appraisalYearRange,
  buildAppraisalYear,
} from "@/features/analytics/appraisal-year";
import type {
  SpecialtyPaRules,
  SpecialtyRow,
  SpecialtyTally,
} from "@/features/analytics/specialty-workload";

const searchSchema = z.object({
  year: fallback(z.number(), 0).default(0),
  staff: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/admin/appraisal-year")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({
    meta: [
      { title: "Appraisal year — clinical work evidence" },
      {
        name: "description",
        content:
          "One appraisal year of a doctor's rota work: intensive care and other clinical activity, days, sessions, on-calls, programmed activities and any evidence gaps.",
      },
      { property: "og:title", content: "Appraisal year evidence" },
      {
        property: "og:description",
        content:
          "April to March totals for intensive care and all other clinical work, with evidence gaps flagged.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AppraisalYearPage,
});

const PAGE_SIZE = 1000;

const DEFAULT_RULES: SpecialtyPaRules = {
  sessions_per_pa: 1,
  oncall_pa_credit: 1.5,
  weekend_pa_credit: 3,
};

const MONTH_LABEL = (m: string) => {
  const [y, mm] = m.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(mm) - 1]} ${y?.slice(2)}`;
};

type AssignmentRow = {
  staff_id: string | null;
  session_date: string | null;
  session: string | null;
  duty_type: string | null;
  extra_type: string | null;
  pa_credit: number | null;
  attending_consultant_ids: string[] | null;
  theatre_session_id: string | null;
};

function AppraisalYearPage() {
  const { hasRole, user, grade, loading } = useAuth();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const isCoordinator = hasRole("admin") || hasRole("rota_coordinator");
  const currentYear = appraisalYearOf(new Date().toISOString().slice(0, 10));
  const year = search.year >= 2015 && search.year <= currentYear + 1 ? search.year : currentYear;
  const staffId = isCoordinator ? search.staff || user?.id || "" : user?.id || "";
  const { from, to } = appraisalYearRange(year);

  const [openArea, setOpenArea] = useState<string | null>(null);

  const { data: staffList } = useQuery({
    queryKey: ["appraisal-year-staff"],
    enabled: isCoordinator,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade")
        .in("grade", ["consultant", "sas"])
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["appraisal-year", staffId, year],
    enabled: Boolean(staffId),
    queryFn: async () => {
      const { data: rulesRow } = await supabase
        .from("rota_rules")
        .select("sessions_per_pa,oncall_pa_credit,weekend_pa_credit")
        .limit(1)
        .maybeSingle();

      const rules: SpecialtyPaRules = {
        sessions_per_pa: Number(rulesRow?.sessions_per_pa ?? DEFAULT_RULES.sessions_per_pa),
        oncall_pa_credit: Number(rulesRow?.oncall_pa_credit ?? DEFAULT_RULES.oncall_pa_credit),
        weekend_pa_credit: Number(rulesRow?.weekend_pa_credit ?? DEFAULT_RULES.weekend_pa_credit),
      };

      const { data: profile } = await supabase
        .from("profiles")
        .select("id,full_name,grade")
        .eq("id", staffId)
        .maybeSingle();

      const raw: AssignmentRow[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data: page, error } = await supabase
          .from("rota_assignments")
          .select(
            "staff_id,session_date,session,duty_type,extra_type,pa_credit,attending_consultant_ids,theatre_session_id",
          )
          .gte("session_date", from)
          .lte("session_date", to)
          .or(`staff_id.eq.${staffId},attending_consultant_ids.cs.{${staffId}}`)
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        raw.push(...((page ?? []) as unknown as AssignmentRow[]));
        if (!page || page.length < PAGE_SIZE) break;
      }

      const sessionIds = Array.from(
        new Set(raw.map((r) => r.theatre_session_id).filter((v): v is string => Boolean(v))),
      );
      const specialtyBySession = new Map<string, string>();
      for (let i = 0; i < sessionIds.length; i += 300) {
        const { data: sessions, error } = await supabase
          .from("theatre_sessions")
          .select("id,specialties(name)")
          .in("id", sessionIds.slice(i, i + 300));
        if (error) throw error;
        for (const s of (sessions ?? []) as unknown as Array<{
          id: string;
          specialties: { name: string } | { name: string }[] | null;
        }>) {
          const sp = Array.isArray(s.specialties) ? s.specialties[0] : s.specialties;
          if (sp?.name) specialtyBySession.set(s.id, sp.name);
        }
      }

      const rows: SpecialtyRow[] = raw.map((r) => ({
        staff_id: r.staff_id,
        session_date: r.session_date,
        session: r.session,
        duty_type: r.duty_type,
        extra_type: r.extra_type,
        pa_credit: r.pa_credit,
        attending_consultant_ids: r.attending_consultant_ids,
        specialty_name: r.theatre_session_id
          ? specialtyBySession.get(r.theatre_session_id) ?? null
          : null,
      }));

      return { rows, rules, profile };
    },
  });

  const summary = useMemo(
    () => (data && staffId ? buildAppraisalYear(staffId, year, data.rows, data.rules) : null),
    [data, staffId, year],
  );

  if (loading) return <PageLoading />;
  if (!isCoordinator && grade !== "consultant" && grade !== "sas") return <Navigate to="/" />;

  const maxMonth = summary
    ? Math.max(1, ...summary.months.map((m) => m.sessions + m.onCalls))
    : 1;

  const yearOptions = Array.from({ length: 6 }, (_, i) => currentYear - i);

  const areaTable = (rows: SpecialtyTally[], emptyText: string) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Area</TableHead>
          <TableHead className="text-right">Days</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead className="text-right">On-calls</TableHead>
          <TableHead className="text-right">Weekend days</TableHead>
          <TableHead className="text-right">PAs</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
              {emptyText}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((t) => (
            <Fragment key={t.area}>
              <TableRow>
                <TableCell className="font-medium">{t.area}</TableCell>
                <TableCell className="text-right tabular-nums">{t.days}</TableCell>
                <TableCell className="text-right tabular-nums">{t.sessions}</TableCell>
                <TableCell className="text-right tabular-nums">{t.onCalls}</TableCell>
                <TableCell className="text-right tabular-nums">{t.weekendDays}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {t.totalPas.toFixed(1)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpenArea(openArea === t.area ? null : t.area)}
                  >
                    {openArea === t.area ? "Hide dates" : "Dates"}
                  </Button>
                </TableCell>
              </TableRow>
              {openArea === t.area ? (
                <TableRow>
                  <TableCell colSpan={7} className="bg-muted/40">
                    <div className="flex flex-wrap gap-1.5">
                      {t.dates.map((d) => (
                        <Badge key={d} variant="secondary" className="tabular-nums">
                          {d}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </>
          ))
        )}
      </TableBody>
    </Table>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appraisal year"
        description="One April-to-March year of rota work, ready to take to appraisal: intensive care alongside every other kind of clinical work, with the sessions, on-calls and programmed activities behind the totals — and anything missing flagged."
      />

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>Appraisal year</Label>
            <Select
              value={String(year)}
              onValueChange={(v) => navigate({ search: { year: Number(v), staff: search.staff } })}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {appraisalYearLabel(y)} (Apr–Mar)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isCoordinator ? (
            <div className="space-y-1">
              <Label>Doctor</Label>
              <Select
                value={staffId}
                onValueChange={(v) => navigate({ search: { year, staff: v } })}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder="Choose a doctor" />
                </SelectTrigger>
                <SelectContent>
                  {(staffList ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground ml-auto">
            {from} to {to}
            {data?.profile?.full_name ? ` · ${data.profile.full_name}` : ""}
          </p>
        </CardContent>
      </Card>

      {!staffId ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Choose a doctor to see their appraisal year.
          </CardContent>
        </Card>
      ) : isLoading || !summary ? (
        <PageLoading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Days worked" value={summary.overall.days} icon={CalendarDays} />
            <StatCard label="Sessions" value={summary.overall.sessions} icon={Activity} />
            <StatCard label="On-calls" value={summary.overall.onCalls} icon={Moon} />
            <StatCard
              label="Total PAs"
              value={summary.overall.totalPas.toFixed(1)}
              icon={Activity}
              tone="info"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card data-testid="appraisal-icu-summary">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HeartPulse className="h-4 w-4 text-rose-500" /> Intensive care
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt className="text-muted-foreground">Days</dt>
                  <dd className="text-right tabular-nums">{summary.icu.days}</dd>
                  <dt className="text-muted-foreground">Daytime sessions</dt>
                  <dd className="text-right tabular-nums">{summary.icu.sessions}</dd>
                  <dt className="text-muted-foreground">On-calls</dt>
                  <dd className="text-right tabular-nums">{summary.icu.onCalls}</dd>
                  <dt className="text-muted-foreground">Weekend days</dt>
                  <dd className="text-right tabular-nums">{summary.icu.weekendDays}</dd>
                  <dt className="font-medium">Total PAs</dt>
                  <dd className="text-right tabular-nums font-semibold">
                    {summary.icu.totalPas.toFixed(1)}
                  </dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  {summary.icu.clwrotaPas.toFixed(1)} recorded by CLWRota ·{" "}
                  {summary.icu.estimatedPas.toFixed(1)} estimated
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link to="/admin/icu-evidence" search={{ staff: staffId, from, to }}>
                    Full intensive care evidence
                  </Link>
                </Button>
              </CardContent>
            </Card>

            <Card data-testid="appraisal-other-summary">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">All other clinical work</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt className="text-muted-foreground">Days</dt>
                  <dd className="text-right tabular-nums">{summary.other.days}</dd>
                  <dt className="text-muted-foreground">Daytime sessions</dt>
                  <dd className="text-right tabular-nums">{summary.other.sessions}</dd>
                  <dt className="text-muted-foreground">On-calls</dt>
                  <dd className="text-right tabular-nums">{summary.other.onCalls}</dd>
                  <dt className="text-muted-foreground">Weekend days</dt>
                  <dd className="text-right tabular-nums">{summary.other.weekendDays}</dd>
                  <dt className="font-medium">Total PAs</dt>
                  <dd className="text-right tabular-nums font-semibold">
                    {summary.other.totalPas.toFixed(1)}
                  </dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  Job-planned {summary.other.plannedPas.toFixed(1)} · extra / locum /
                  WLI / SAG {summary.other.extraPas.toFixed(1)}
                </p>
              </CardContent>
            </Card>
          </div>

          {summary.gaps.length > 0 ? (
            <div className="space-y-2" data-testid="appraisal-gaps">
              {summary.gaps.map((g) => (
                <Alert key={g.kind} variant="default">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>{g.label}</AlertTitle>
                  <AlertDescription>{g.detail}</AlertDescription>
                </Alert>
              ))}
            </div>
          ) : (
            <Alert>
              <AlertTitle>No evidence gaps found</AlertTitle>
              <AlertDescription>
                Every month of this appraisal year has rota activity and a CLWRota record behind
                each session.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Month by month</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {summary.months.map((m) => {
                  const total = m.sessions + m.onCalls;
                  return (
                    <div
                      key={m.month}
                      className={`rounded-md border p-2 text-xs ${
                        total === 0 ? "border-dashed text-muted-foreground" : ""
                      }`}
                    >
                      <div className="font-medium">{MONTH_LABEL(m.month)}</div>
                      <div className="mt-1 h-1.5 rounded bg-muted">
                        <div
                          className="h-1.5 rounded bg-primary"
                          style={{ width: `${Math.round((total / maxMonth) * 100)}%` }}
                        />
                      </div>
                      <div className="mt-1 tabular-nums">
                        {m.sessions} sessions · {m.onCalls} on-calls
                      </div>
                      {m.icuSessions > 0 ? (
                        <div className="tabular-nums text-rose-600">{m.icuSessions} ICU</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Intensive care breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              {areaTable(summary.icuAreas, "No intensive care work recorded in this year.")}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Other clinical work by specialty and duty</CardTitle>
            </CardHeader>
            <CardContent>
              {areaTable(summary.otherAreas, "No other clinical work recorded in this year.")}
              <p className="mt-3 text-xs text-muted-foreground">
                PAs use CLWRota's own recorded value where there is one, otherwise the department
                rota rules ({data?.rules.sessions_per_pa} session(s) per PA,{" "}
                {data?.rules.oncall_pa_credit} PA per on-call, {data?.rules.weekend_pa_credit} PA
                per weekend day). A weekend day counts once — weekend credit replaces the session
                or on-call credit.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
