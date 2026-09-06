import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatCard } from "@/components/stat-card";
import { Activity, AlertTriangle, CalendarClock, Moon, Stethoscope } from "lucide-react";
import {
  getIcuConsultantEvidence,
  type IcuConsultantEvidence,
} from "@/features/analytics/icu-evidence.functions";
import { formatDateWithWeekdayGB } from "@/lib/utils";

/**
 * Appraisal evidence block for a consultant / SAS doctor's profile page:
 * their intensive-care days, sessions, on-calls and the PAs behind them
 * over a window they can set (default the last 12 months, i.e. one
 * appraisal year), plus any place where the rota and CLWRota disagree.
 *
 * Reuses the same server function as the full ICU evidence page so the
 * numbers on the profile can never drift from the audit page.
 */

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isoMonthsAgo(months: number) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const SESSION_LABEL: Record<string, string> = {
  am: "AM",
  pm: "PM",
  eve: "Evening",
  night: "Night",
};

export function IcuAppraisalCard({ staffId }: { staffId: string }) {
  const [from, setFrom] = useState(() => isoMonthsAgo(12));
  const [to, setTo] = useState(() => todayIso());
  const fetchEvidence = useServerFn(getIcuConsultantEvidence);

  const valid = ISO_RE.test(from) && ISO_RE.test(to) && from <= to;

  const { data, isLoading, error } = useQuery<IcuConsultantEvidence>({
    queryKey: ["icu-appraisal-card", staffId, from, to],
    enabled: valid,
    queryFn: () => fetchEvidence({ data: { staffId, startIso: from, endIso: to } }),
  });

  const tally = data?.tally ?? null;
  const recent = useMemo(() => (data?.sessions ?? []).slice(-6).reverse(), [data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Stethoscope className="h-4 w-4 text-primary" /> Intensive care — appraisal evidence
        </CardTitle>
        <CardDescription className="text-xs">
          Intensive care days, on-calls and PAs from CLWRota for the chosen period, ready to
          attach to appraisal or revalidation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="icu-appraisal-from" className="text-xs">From</Label>
            <Input
              id="icu-appraisal-from"
              type="date"
              className="h-8 w-[10.5rem]"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="icu-appraisal-to" className="text-xs">To</Label>
            <Input
              id="icu-appraisal-to"
              type="date"
              className="h-8 w-[10.5rem]"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFrom(isoMonthsAgo(12));
              setTo(todayIso());
            }}
          >
            Last 12 months
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFrom(isoMonthsAgo(60));
              setTo(todayIso());
            }}
          >
            Last 5 years
          </Button>
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <Link to="/admin/icu-evidence" search={{ staff: staffId, from, to }}>
              Full ICU record
            </Link>
          </Button>
        </div>

        {!valid ? (
          <p className="text-xs text-destructive">Choose a start date on or before the end date.</p>
        ) : isLoading ? (
          <p className="text-xs text-muted-foreground">Loading intensive care record…</p>
        ) : error ? (
          <p className="text-xs text-destructive">
            {error instanceof Error ? error.message : "Could not load the intensive care record."}
          </p>
        ) : !tally ? (
          <p className="text-xs text-muted-foreground">
            No intensive care sessions recorded between {formatDateWithWeekdayGB(from)} and{" "}
            {formatDateWithWeekdayGB(to)}.
          </p>
        ) : (
          <div className="space-y-4" data-testid="icu-appraisal-summary">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="ICU days"
                value={tally.days}
                hint={`${tally.sessions} daytime session${tally.sessions === 1 ? "" : "s"}`}
                icon={CalendarClock}
                tone="info"
              />
              <StatCard
                label="On-calls"
                value={tally.onCalls}
                hint={`${tally.weekendDays} weekend day${tally.weekendDays === 1 ? "" : "s"}`}
                icon={Moon}
              />
              <StatCard
                label="Total PAs"
                value={tally.totalPas}
                hint={`${tally.plannedPas} job-planned · ${tally.extraPas} extra`}
                icon={Activity}
                tone="success"
              />
              <StatCard
                label="PAs from CLWRota"
                value={tally.clwrotaPas}
                hint={`${tally.estimatedPas} estimated from rota rules`}
                icon={Activity}
              />
            </div>

            {data && data.discrepancies.length > 0 ? (
              <div className="rounded-md border border-warning/40 bg-warning-muted/40 p-3 text-xs">
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                  {data.discrepancies.length} session
                  {data.discrepancies.length === 1 ? "" : "s"} need checking against CLWRota
                </p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                  {data.discrepancies.slice(0, 3).map((d, i) => (
                    <li key={`${d.sessionDate}-${d.session}-${i}`}>
                      {formatDateWithWeekdayGB(d.sessionDate)} · {SESSION_LABEL[d.session] ?? d.session}{" "}
                      — {d.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {recent.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {recent.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {formatDateWithWeekdayGB(s.sessionDate)} ·{" "}
                      {SESSION_LABEL[s.session] ?? s.session}
                      {s.placeName ? ` · ${s.placeName}` : ""}
                    </span>
                    <Badge variant={s.paCredit == null ? "outline" : "secondary"} className="shrink-0">
                      {s.paCredit == null ? "PA estimated" : `${s.paCredit} PA`}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
