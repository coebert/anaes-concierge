import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageLoading } from "@/components/loading";
import { formatDateWithWeekdayGB } from "@/lib/utils";
import {
  computeEntitlementLedger,
  type AllowanceRow,
  type LeaveRow,
  type EntitlementLine,
} from "@/features/leave/entitlement-ledger";
import { Clock, CalendarClock, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/leave/entitlements")({
  head: () => ({
    meta: [
      { title: "My leave entitlements — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Full ledger of leave allowances, taken, pending and remaining including TOIL balance.",
      },
    ],
  }),
  component: EntitlementsPage,
});

function EntitlementsPage() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    enabled: !!user,
    queryKey: ["my-entitlements", user?.id],
    queryFn: async () => {
      const [allowRes, profRes, leaveRes, ledgerRes] = await Promise.all([
        supabase.from("leave_allowances").select("*").eq("staff_id", user!.id),
        supabase
          .from("profiles")
          .select("start_date,left_at,full_name")
          .eq("id", user!.id)
          .single(),
        supabase
          .from("leave_requests")
          .select(
            "id,type,status,start_date,end_date,half_day_start,half_day_end,created_at,decided_at",
          )
          .eq("staff_id", user!.id)
          .range(0, 4999),
        supabase
          .from("leave_ledger_entries")
          .select("entry_date,kind,hours,reason,created_at")
          .eq("staff_id", user!.id)
          .order("entry_date", { ascending: false })
          .range(0, 499),
      ]);
      if (allowRes.error) throw allowRes.error;
      if (profRes.error) throw profRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (ledgerRes.error) throw ledgerRes.error;
      return {
        allowances: (allowRes.data ?? []) as AllowanceRow[],
        profile: profRes.data,
        leave: (leaveRes.data ?? []) as LeaveRow[],
        ledger: ledgerRes.data ?? [],
      };
    },
  });

  const years = useMemo(
    () =>
      (data?.allowances ?? [])
        .map((a) => a.leave_year_start)
        .sort((a, b) => b.localeCompare(a)),
    [data],
  );
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const activeYear = selectedYear ?? years[0] ?? null;

  const allowance = data?.allowances.find((a) => a.leave_year_start === activeYear);

  const lines: EntitlementLine[] = useMemo(() => {
    if (!allowance || !data) return [];
    return computeEntitlementLedger(
      allowance,
      { start_date: data.profile?.start_date, left_at: data.profile?.left_at },
      data.leave,
      (data.ledger as { entry_date: string; kind: "accrual" | "spend" | "adjustment"; hours: number }[]) ?? [],
    );
  }, [allowance, data]);

  const pendingRequests = useMemo(
    () => (data?.leave ?? []).filter((r) => r.status === "pending"),
    [data],
  );

  const slaTarget = allowance?.sla_target_days ?? 14;

  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My leave entitlements"
        description="Every leave category on one page — with pro-rating for LTFT and mid-year starts, carry-over, and your TOIL balance."
      />

      {!allowance ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No leave allowance has been recorded for you yet. Ask an admin to set
            up an allowance record so entitlements can be shown.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm text-muted-foreground">Leave year starting</div>
            <Select
              value={activeYear ?? undefined}
              onValueChange={(v) => setSelectedYear(v)}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={y}>
                    {formatDateWithWeekdayGB(y)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="secondary" className="ml-auto">
              LTFT fraction: {allowance.ltft_fraction.toFixed(3)}
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {lines.map((line) => (
              <EntitlementCard key={line.type} line={line} />
            ))}
          </div>

          {pendingRequests.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarClock className="h-4 w-4" />
                  Pending requests — SLA target {slaTarget} days
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pendingRequests.map((r) => {
                  const ageDays = r.created_at
                    ? Math.floor(
                        (Date.now() - new Date(r.created_at).getTime()) / 86_400_000,
                      )
                    : 0;
                  const breached = ageDays > slaTarget;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between rounded-md border p-2 text-sm"
                    >
                      <div>
                        <div className="font-medium capitalize">{r.type}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateWithWeekdayGB(r.start_date)} →{" "}
                          {formatDateWithWeekdayGB(r.end_date)}
                        </div>
                      </div>
                      <Badge variant={breached ? "destructive" : "secondary"}>
                        {breached ? (
                          <span className="inline-flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" /> SLA {ageDays}d
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" /> {ageDays}d waiting
                          </span>
                        )}
                      </Badge>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {data && data.ledger.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">TOIL ledger — recent entries</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-sm">
                  {data.ledger.slice(0, 20).map((l, i) => (
                    <div key={i} className="flex items-center gap-3 border-b py-1 last:border-none">
                      <div className="w-28 shrink-0 text-xs text-muted-foreground">
                        {formatDateWithWeekdayGB(l.entry_date)}
                      </div>
                      <Badge variant="outline" className="capitalize">{l.kind}</Badge>
                      <div className={l.kind === "spend" ? "text-destructive" : ""}>
                        {l.kind === "spend" ? "−" : "+"}
                        {Number(l.hours).toFixed(2)} h
                      </div>
                      <div className="ml-auto truncate text-xs text-muted-foreground">
                        {(l as { reason?: string | null }).reason ?? ""}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function EntitlementCard({ line }: { line: EntitlementLine }) {
  const isToil = line.type === "toil";
  const total = line.prorated + line.carryOver;
  const used = line.taken + line.pending;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>{line.label}</span>
          {isToil ? (
            <Badge variant="secondary">{line.remaining.toFixed(2)} h</Badge>
          ) : (
            <Badge variant={line.remaining < 0 ? "destructive" : "secondary"}>
              {line.remaining.toFixed(1)} / {total.toFixed(1)} d
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!isToil && (
          <>
            <Progress value={pct} />
            <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
              <Stat label="Entitle" value={line.prorated.toFixed(1)} />
              <Stat label="Carry" value={line.carryOver.toFixed(1)} />
              <Stat label="Taken" value={line.taken.toFixed(1)} />
              <Stat label="Pending" value={line.pending.toFixed(1)} />
            </div>
          </>
        )}
        {isToil && (
          <div className="text-xs text-muted-foreground">
            Balance is the sum of accruals minus spends across all TOIL ledger entries.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}
