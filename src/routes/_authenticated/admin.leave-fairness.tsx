import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageLoading } from "@/components/loading";
import {
  Scale,
  AlertTriangle,
  Clock,
  Star,
  Plus,
} from "lucide-react";
import { computeFairnessMetrics, gini } from "@/lib/leave-fairness";
import type { LeaveRow } from "@/features/leave/entitlement-ledger";
import { ToilLedgerDialog } from "@/components/leave/ToilLedgerDialog";

export const Route = createFileRoute("/_authenticated/admin/leave-fairness")({
  head: () => ({
    meta: [
      { title: "Leave fairness — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Rolling 12-month leave fairness: denial rates, prime-date share, SLA compliance and Gini across staff.",
      },
    ],
  }),
  component: LeaveFairnessPage,
});

interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string | null;
  grade: string | null;
  active: boolean | null;
}

function LeaveFairnessPage() {
  const { hasRole, loading } = useAuth();
  const [q, setQ] = useState("");
  const [toilFor, setToilFor] = useState<{ id: string; name: string | null } | null>(
    null,
  );

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-leave-fairness"],
    queryFn: async () => {
      const [profRes, leaveRes, allowRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id,full_name,email,grade,active")
          .eq("active", true),
        supabase
          .from("leave_requests")
          .select(
            "id,staff_id,type,status,start_date,end_date,half_day_start,half_day_end,created_at,decided_at",
          )
          .range(0, 19999),
        supabase.from("leave_allowances").select("staff_id,sla_target_days"),
      ]);
      if (profRes.error) throw profRes.error;
      if (leaveRes.error) throw leaveRes.error;
      if (allowRes.error) throw allowRes.error;
      return {
        profiles: (profRes.data ?? []) as ProfileRow[],
        leave: (leaveRes.data ?? []) as (LeaveRow & { staff_id: string })[],
        allowances: allowRes.data ?? [],
      };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const slaByStaff = new Map<string, number>();
    for (const a of data.allowances) {
      const prev = slaByStaff.get(a.staff_id) ?? Infinity;
      if (a.sla_target_days < prev) slaByStaff.set(a.staff_id, a.sla_target_days);
    }
    return data.profiles
      .map((p) => {
        const staffRows = data.leave.filter((r) => r.staff_id === p.id);
        const metrics = computeFairnessMetrics({
          rows: staffRows,
          slaTargetDays: slaByStaff.get(p.id) ?? 14,
        });
        return {
          id: p.id,
          name: p.full_name || p.email || "Unknown",
          grade: p.grade,
          metrics,
        };
      })
      .filter(
        (r) =>
          r.metrics.approvedCount +
            r.metrics.deniedCount +
            r.metrics.pendingCount >
          0,
      )
      .sort((a, b) => b.metrics.denialRate - a.metrics.denialRate);
  }, [data]);

  const filteredRows = rows.filter((r) =>
    q ? r.name.toLowerCase().includes(q.toLowerCase()) : true,
  );

  const totalBreaches = rows.reduce((n, r) => n + r.metrics.slaBreachCount, 0);
  const totalDenied = rows.reduce((n, r) => n + r.metrics.deniedCount, 0);
  const totalPrime = rows.reduce((n, r) => n + r.metrics.primeDateDays, 0);
  const primeGini = gini(rows.map((r) => r.metrics.primeDateDays));

  const denialReasonTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      for (const [k, v] of Object.entries(r.metrics.denialReasons)) {
        out[k] = (out[k] ?? 0) + v;
      }
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave fairness"
        description="Rolling 12-month leave metrics per doctor — denial rate, prime-date share (bank holidays + Christmas/NY window), and SLA compliance vs the per-staff target."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Staff with leave activity" value={rows.length} icon={Scale} />
        <StatCard label="Denials (12m)" value={totalDenied} icon={AlertTriangle} />
        <StatCard label="SLA breaches" value={totalBreaches} icon={Clock} />
        <StatCard
          label="Prime-date Gini"
          value={primeGini.toFixed(2)}
          icon={Star}
        />
      </div>

      {denialReasonTotals.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Denial reasons — league</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2 text-sm">
              {denialReasonTotals.map(([k, v]) => (
                <Badge key={k} variant="secondary" className="capitalize">
                  {k}: {v}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name…"
              className="max-w-xs"
            />
            <div className="ml-auto text-xs text-muted-foreground">
              Prime-date total across all staff:{" "}
              <span className="font-medium">{totalPrime.toFixed(1)} d</span>
            </div>
          </div>

          {isLoading ? (
            <PageLoading />
          ) : filteredRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No leave activity in the last 12 months.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Staff</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                  <TableHead className="text-right">Denied</TableHead>
                  <TableHead className="text-right">Denial rate</TableHead>
                  <TableHead className="text-right">Prime-date d</TableHead>
                  <TableHead className="text-right">Prime share</TableHead>
                  <TableHead className="text-right">Median decision</TableHead>
                  <TableHead className="text-right">SLA breach</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-xs capitalize text-muted-foreground">
                      {r.grade ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">{r.metrics.approvedCount}</TableCell>
                    <TableCell className="text-right">{r.metrics.deniedCount}</TableCell>
                    <TableCell className="text-right">
                      {(r.metrics.denialRate * 100).toFixed(0)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {r.metrics.primeDateDays.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      {(r.metrics.primeDateShare * 100).toFixed(0)}%
                    </TableCell>
                    <TableCell className="text-right">
                      {r.metrics.medianDecisionHours === null
                        ? "—"
                        : `${r.metrics.medianDecisionHours.toFixed(0)}h`}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.metrics.slaBreachCount > 0 ? (
                        <Badge variant="destructive">{r.metrics.slaBreachCount}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setToilFor({ id: r.id, name: r.name })}
                      >
                        <Plus className="h-3 w-3 mr-1" /> TOIL
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {toilFor && (
        <ToilLedgerDialog
          open={!!toilFor}
          onOpenChange={(o) => !o && setToilFor(null)}
          onSaved={() => refetch()}
          staffId={toilFor.id}
          staffName={toilFor.name}
        />
      )}
    </div>
  );
}
