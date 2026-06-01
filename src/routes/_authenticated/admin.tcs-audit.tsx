import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { auditTcs2016, type AuditAssignment, type AuditResult, type RuleResult, type RuleStatus, type ShiftSummary } from "@/lib/tcs-2016-audit";
import { getSurname, formatDateGB } from "@/lib/utils";
import { CheckCircle2, AlertTriangle, HelpCircle, ShieldCheck, ShieldAlert, ChevronDown, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/tcs-audit")({
  component: TcsAuditPage,
});

type Lookback = "90" | "180" | "365" | "all";
const LOOKBACK_LABEL: Record<Lookback, string> = {
  "90": "Last 90 days",
  "180": "Last 6 months",
  "365": "Last 12 months",
  all: "All available",
};

function TcsAuditPage() {
  const { hasRole, loading } = useAuth();
  const [lookback, setLookback] = useState<Lookback>("180");
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["tcs-audit", lookback],
    queryFn: async () => {
      const today = new Date();
      const since =
        lookback === "all"
          ? null
          : new Date(today.getTime() - parseInt(lookback) * 86400_000).toISOString().slice(0, 10);

      const { data: trainees, error: e1 } = await supabase
        .from("profiles")
        .select("id, full_name, training_level")
        .eq("grade", "trainee")
        .eq("active", true)
        .order("full_name");
      if (e1) throw e1;
      const ids = (trainees ?? []).map((t) => t.id);
      if (!ids.length) return { trainees: [], assignmentsByStaff: new Map<string, AuditAssignment[]>() };

      let q = supabase
        .from("rota_assignments")
        .select("staff_id, session_date, session, duty_type, role_on_list")
        .in("staff_id", ids)
        .order("session_date", { ascending: true })
        .range(0, 9999);
      if (since) q = q.gte("session_date", since);
      const { data: assignments, error: e2 } = await q;
      if (e2) throw e2;

      const map = new Map<string, AuditAssignment[]>();
      for (const a of assignments ?? []) {
        const arr = map.get(a.staff_id) ?? [];
        arr.push({
          session_date: a.session_date,
          session: a.session as AuditAssignment["session"],
          duty_type: a.duty_type,
          role_on_list: a.role_on_list,
        });
        map.set(a.staff_id, arr);
      }
      return { trainees: trainees ?? [], assignmentsByStaff: map };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    return data.trainees
      .map((t) => ({
        trainee: t,
        audit: auditTcs2016(data.assignmentsByStaff.get(t.id) ?? []),
      }))
      .filter((r) => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return (
          r.trainee.full_name?.toLowerCase().includes(q) ||
          r.trainee.training_level?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Non-compliant first, then by surname
        const rank = (o: string) =>
          o === "non_compliant" ? 0 : o === "insufficient_data" ? 2 : 1;
        const diff = rank(a.audit.overall) - rank(b.audit.overall);
        if (diff !== 0) return diff;
        const aS = getSurname(a.trainee.full_name).toLowerCase();
        const bS = getSurname(b.trainee.full_name).toLowerCase();
        return aS < bS ? -1 : aS > bS ? 1 : 0;
      });
  }, [data, filter]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!hasRole("admin")) return <Navigate to="/" />;

  const compliantCount = rows.filter((r) => r.audit.overall === "compliant").length;
  const breachCount = rows.filter((r) => r.audit.overall === "non_compliant").length;
  const indetCount = rows.filter((r) => r.audit.overall === "insufficient_data").length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">TCS 2016 compliance audit</h1>
          <p className="text-sm text-muted-foreground">
            Checks each trainee's rota against the 2016 Junior Doctor Terms &amp; Conditions of Service.
            Session times are approximated from AM/PM/eve/night blocks where actual start/end times are not stored.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-44">
            <label className="mb-1 block text-xs text-muted-foreground">Reference period</label>
            <Select value={lookback} onValueChange={(v) => setLookback(v as Lookback)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(LOOKBACK_LABEL) as Lookback[]).map((k) => (
                  <SelectItem key={k} value={k}>{LOOKBACK_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="max-w-xs"
          />
        </div>
      </header>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Running audit…</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={ShieldCheck} tone="ok" label="Compliant" value={compliantCount} />
            <Stat icon={ShieldAlert} tone="bad" label="Non-compliant" value={breachCount} />
            <Stat icon={HelpCircle} tone="muted" label="Insufficient data" value={indetCount} />
          </div>

          {rows.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No trainees on record.</CardContent></Card>
          ) : (
            <div className="space-y-4">
              {rows.map(({ trainee, audit }) => (
                <Card key={trainee.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">
                        {trainee.full_name || "—"}{" "}
                        {trainee.training_level && (
                          <Badge variant="secondary" className="ml-2">{trainee.training_level}</Badge>
                        )}
                      </CardTitle>
                      <OverallBadge overall={audit.overall} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {audit.totalShifts} shift(s) · {audit.totalHours} h ·{" "}
                      {audit.windowStart && audit.windowEnd
                        ? `${formatDateGB(audit.windowStart)} → ${formatDateGB(audit.windowEnd)}`
                        : "no data"}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-2 md:grid-cols-2">
                      {audit.rules.map((r) => (
                        <RuleCard key={r.id} rule={r} />
                      ))}
                    </div>
                    <AllSessionsDrilldown audit={audit} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OverallBadge({ overall }: { overall: "compliant" | "non_compliant" | "insufficient_data" }) {
  if (overall === "compliant")
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Compliant</Badge>;
  if (overall === "non_compliant")
    return <Badge variant="destructive">Non-compliant</Badge>;
  return <Badge variant="outline">Insufficient data</Badge>;
}

function RuleIcon({ status }: { status: RuleStatus }) {
  if (status === "pass") return <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />;
  if (status === "fail") return <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />;
  if (status === "warn") return <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />;
  return <HelpCircle className="mt-0.5 h-4 w-4 text-muted-foreground" />;
}

function Stat({
  icon: Icon, tone, label, value,
}: {
  icon: typeof CheckCircle2;
  tone: "ok" | "bad" | "muted";
  label: string;
  value: number;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
      : tone === "bad"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-md ${toneClass}`}>
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
