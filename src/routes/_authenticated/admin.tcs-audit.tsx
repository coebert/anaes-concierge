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
import { formatDateGB } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
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
      const todayISO = today.toISOString().slice(0, 10);
      const since =
        lookback === "all"
          ? null
          : new Date(today.getTime() - parseInt(lookback) * 86400_000).toISOString().slice(0, 10);

      const { data: trainees, error: e1 } = await supabase
        .from("profiles")
        .select("id, full_name, training_level, start_date, rotation_end_date, ltft_days_off")
        .eq("grade", "trainee")
        .eq("active", true)
        .order("full_name");
      if (e1) throw e1;
      const ids = (trainees ?? []).map((t) => t.id);
      if (!ids.length) return { trainees: [], assignmentsByStaff: new Map<string, AuditAssignment[]>(), leaveByStaff: new Map<string, Set<string>>(), todayISO, sinceISO: since };

      // Fetch in pages of 1000 to avoid Supabase's default row cap silently
      // truncating high-volume trainees (a single .range(0, 9999) request
      // can still be capped server-side).
      const PAGE = 1000;
      const all: Array<{ staff_id: string; session_date: string; session: string; duty_type: string; role_on_list: string }> = [];
      let offset = 0;
      // Loop until a page returns fewer than PAGE rows.
      while (true) {
        let q = supabase
          .from("rota_assignments")
          .select("staff_id, session_date, session, duty_type, role_on_list")
          .in("staff_id", ids)
          .order("session_date", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (since) q = q.gte("session_date", since);
        const { data: page, error: e2 } = await q;
        if (e2) throw e2;
        const rows = page ?? [];
        all.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
        if (offset > 50_000) break; // hard safety stop
      }

      // Pull approved leave so the audit can (a) bridge "consecutive days"
      // runs across leave days and (b) exclude leave days from the WTD
      // averaging denominator. Pending / cancelled requests are ignored.
      let leaveQ = supabase
        .from("leave_requests")
        .select("staff_id, start_date, end_date, status")
        .in("staff_id", ids)
        .eq("status", "approved");
      if (since) leaveQ = leaveQ.gte("end_date", since);
      const { data: leaveRows, error: e3 } = await leaveQ;
      if (e3) throw e3;
      const leaveByStaff = new Map<string, Set<string>>();
      for (const lr of leaveRows ?? []) {
        let set = leaveByStaff.get(lr.staff_id);
        if (!set) {
          set = new Set();
          leaveByStaff.set(lr.staff_id, set);
        }
        // Expand inclusive date range to a set of YYYY-MM-DD strings.
        const start = new Date(lr.start_date + "T00:00:00Z").getTime();
        const end = new Date(lr.end_date + "T00:00:00Z").getTime();
        for (let t = start; t <= end; t += 86_400_000) {
          set.add(new Date(t).toISOString().slice(0, 10));
        }
      }

      const map = new Map<string, AuditAssignment[]>();
      for (const a of all) {
        const arr = map.get(a.staff_id) ?? [];
        arr.push({
          session_date: a.session_date,
          session: a.session as AuditAssignment["session"],
          duty_type: a.duty_type,
          role_on_list: a.role_on_list,
        });
        map.set(a.staff_id, arr);
      }
      return { trainees: trainees ?? [], assignmentsByStaff: map, leaveByStaff, todayISO, sinceISO: since };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const todayISO = data.todayISO;
    return data.trainees
      .map((t) => {
        const all = data.assignmentsByStaff.get(t.id) ?? [];
        // Clamp the audit window to the trainee's actual rotation dates so
        // we don't report "no data" for trainees who haven't started yet
        // (start_date in the future) or whose rotation has ended.
        const startISO = t.start_date ?? null;
        const endISO = t.rotation_end_date ?? null;
        const inRotation = all.filter((a) => {
          if (startISO && a.session_date < startISO) return false;
          if (endISO && a.session_date > endISO) return false;
          return true;
        });
        let reason: "not_started" | "rotation_ended" | "no_sync" | null = null;
        if (inRotation.length === 0) {
          if (startISO && startISO > todayISO) reason = "not_started";
          else if (endISO && endISO < todayISO) reason = "rotation_ended";
          else reason = "no_sync";
        }
        // Reference window for R1 averaging: the user-selected lookback
        // (or rotation start if 'all') clamped to the rotation window and
        // to today. This stops a sparse dataset / leave block from
        // artificially deflating the WTD average.
        const lookbackStart = data.sinceISO ?? startISO ?? todayISO;
        const refStart = [startISO ?? lookbackStart, lookbackStart]
          .filter(Boolean)
          .sort()
          .reverse()[0]; // later of the two
        const refEnd = [endISO ?? todayISO, todayISO].sort()[0]; // earlier of the two
        const leaveDates = data.leaveByStaff.get(t.id) ?? new Set<string>();
        const ltftDaysOff = Array.isArray(t.ltft_days_off) ? t.ltft_days_off.map(Number) : [];
        return {
          trainee: t,
          audit: auditTcs2016(inRotation, {
            windowStartISO: refStart,
            windowEndISO: refEnd,
            leaveDates,
            ltftDaysOff,
          }),
          reason,
          startISO,
          endISO,
        };
      })
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
        return compareBySurname(a.trainee.full_name, b.trainee.full_name);
      });
  }, [data, filter]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!hasRole("admin")) return <Navigate to="/" />;

  const compliantCount = rows.filter((r) => r.audit.overall === "compliant" && !r.reason).length;
  const breachCount = rows.filter((r) => r.audit.overall === "non_compliant").length;
  const noDataCount = rows.filter((r) => r.reason === "no_sync").length;
  const preRotationCount = rows.filter((r) => r.reason === "not_started" || r.reason === "rotation_ended").length;

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
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat icon={ShieldCheck} tone="ok" label="Compliant" value={compliantCount} />
            <Stat icon={ShieldAlert} tone="bad" label="Non-compliant" value={breachCount} />
            <Stat icon={HelpCircle} tone="muted" label="No rota synced" value={noDataCount} />
            <Stat icon={HelpCircle} tone="muted" label="Pre/post rotation" value={preRotationCount} />
          </div>

          {rows.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No trainees on record.</CardContent></Card>
          ) : (
            <div className="space-y-4">
              {rows.map(({ trainee, audit, reason, startISO, endISO }) => (
                <Card key={trainee.id}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base">
                        {trainee.full_name || "—"}{" "}
                        {trainee.training_level && (
                          <Badge variant="secondary" className="ml-2">{trainee.training_level}</Badge>
                        )}
                        {audit.ltftFraction < 1 && (
                          <Badge variant="outline" className="ml-2">
                            LTFT {(audit.ltftFraction * 100).toFixed(0)}%
                          </Badge>
                        )}
                      </CardTitle>
                      <OverallBadge overall={audit.overall} reason={reason} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {audit.totalShifts} shift(s) · {audit.totalHours} h ·{" "}
                      {audit.windowStart && audit.windowEnd
                        ? `${formatDateGB(audit.windowStart)} → ${formatDateGB(audit.windowEnd)}`
                        : reason === "not_started" && startISO
                          ? `rotation starts ${formatDateGB(startISO)}`
                          : reason === "rotation_ended" && endISO
                            ? `rotation ended ${formatDateGB(endISO)}`
                            : "no rota data synced for this trainee"}
                      {audit.requestedWindowStart && audit.requestedWindowEnd && audit.windowStart && audit.windowEnd &&
                        (audit.requestedWindowStart !== audit.windowStart || audit.requestedWindowEnd !== audit.windowEnd) && (
                          <span className="ml-1 italic">
                            (audit window {formatDateGB(audit.requestedWindowStart)} → {formatDateGB(audit.requestedWindowEnd)} — clamped to shift data)
                          </span>
                        )}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {reason ? (
                      <ReasonBanner reason={reason} startISO={startISO} endISO={endISO} />
                    ) : (
                      <>
                        <div className="grid gap-2 md:grid-cols-2">
                          {audit.rules.map((r) => (
                            <RuleCard key={r.id} rule={r} />
                          ))}
                        </div>
                        <AllSessionsDrilldown audit={audit} />
                      </>
                    )}
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

type ReasonCode = "not_started" | "rotation_ended" | "no_sync" | null;

function OverallBadge({
  overall,
  reason,
}: {
  overall: "compliant" | "non_compliant" | "insufficient_data";
  reason?: ReasonCode;
}) {
  if (overall === "compliant")
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">Compliant</Badge>;
  if (overall === "non_compliant")
    return <Badge variant="destructive">Non-compliant</Badge>;
  if (reason === "not_started") return <Badge variant="outline">Pre-rotation</Badge>;
  if (reason === "rotation_ended") return <Badge variant="outline">Rotation ended</Badge>;
  if (reason === "no_sync") return <Badge variant="outline">No rota synced</Badge>;
  return <Badge variant="outline">Insufficient data</Badge>;
}

function ReasonBanner({
  reason,
  startISO,
  endISO,
}: {
  reason: Exclude<ReasonCode, null>;
  startISO: string | null;
  endISO: string | null;
}) {
  const msg =
    reason === "not_started"
      ? `This trainee's rotation has not started yet${startISO ? ` (starts ${formatDateGB(startISO)})` : ""}. The audit will run once they begin.`
      : reason === "rotation_ended"
        ? `This trainee's rotation ended${endISO ? ` on ${formatDateGB(endISO)}` : ""}, before the selected reference period. Widen the reference period to audit their past rota.`
        : "No rota assignments have been synced for this trainee within the reference period. Check the CLWRota sync or the trainee's rota source.";
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4" />
        <span>{msg}</span>
      </div>
    </div>
  );
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

const SESSION_LABEL: Record<ShiftSummary["session"], string> = {
  am: "AM (08:00–13:00)",
  pm: "PM (13:00–18:00)",
  eve: "Eve (18:00–21:00)",
  night: "Night (21:00–08:00 +1)",
};

function ShiftRow({ s }: { s: ShiftSummary }) {
  const tags: string[] = [];
  if (s.isNight) tags.push("night");
  if (s.isLong) tags.push("long >10h");
  if (s.isWeekend) tags.push("weekend");
  return (
    <li className="grid grid-cols-[110px_140px_1fr_auto] items-center gap-2 border-b py-1 text-xs last:border-b-0">
      <span className="font-mono">{formatDateGB(s.date)}</span>
      <span className="text-muted-foreground">{SESSION_LABEL[s.session]}</span>
      <span className="truncate" title={s.duty_type}>{s.duty_type || "—"}</span>
      <span className="flex items-center gap-1">
        <span className="tabular-nums">{s.hours} h</span>
        {tags.map((t) => (
          <Badge key={t} variant="outline" className="px-1 py-0 text-[10px]">{t}</Badge>
        ))}
      </span>
    </li>
  );
}

function RuleCard({ rule }: { rule: RuleResult }) {
  const [open, setOpen] = useState(false);
  const hasEvidence = !!rule.evidence && rule.evidence.shifts.length > 0;
  return (
    <div className="rounded-md border p-2 text-sm">
      <div className="flex items-start gap-2">
        <RuleIcon status={rule.status} />
        <div className="flex-1">
          <div className="font-medium">{rule.label}</div>
          <div className="text-xs text-muted-foreground">{rule.detail}</div>
          {rule.breaches && rule.breaches.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs text-destructive">
              {rule.breaches.map((b, i) => (
                <li key={i}>{b.note}</li>
              ))}
            </ul>
          )}
          {hasEvidence && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {open ? "Hide" : "Show"} sessions used ({rule.evidence!.shifts.length})
            </button>
          )}
        </div>
      </div>
      {open && hasEvidence && (
        <div className="mt-2 rounded-md bg-muted/40 p-2">
          {rule.evidence!.windowStart && rule.evidence!.windowEnd && (
            <div className="mb-1 text-[11px] text-muted-foreground">
              Window: {formatDateGB(rule.evidence!.windowStart)} → {formatDateGB(rule.evidence!.windowEnd)}
            </div>
          )}
          {rule.evidence!.notes && rule.evidence!.notes.length > 0 && (
            <ul className="mb-2 list-disc pl-4 text-[11px] text-muted-foreground">
              {rule.evidence!.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <ul className="max-h-64 overflow-y-auto">
            {rule.evidence!.shifts.map((s, i) => (
              <ShiftRow key={`${s.date}-${s.session}-${i}`} s={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AllSessionsDrilldown({ audit }: { audit: AuditResult }) {
  const [open, setOpen] = useState(false);
  if (audit.shifts.length === 0) return null;
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? "Hide" : "Show"} all {audit.shifts.length} session(s) used in this audit
      </button>
      {open && (
        <ul className="mt-2 max-h-80 overflow-y-auto px-1">
          {audit.shifts.map((s, i) => (
            <ShiftRow key={`${s.date}-${s.session}-${i}`} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
