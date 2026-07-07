import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageLoading } from "@/components/loading";
import { StatCard } from "@/components/stat-card";
import { ShieldAlert, ShieldCheck, Clock, AlertTriangle } from "lucide-react";
import { ExceptionCard } from "@/components/exceptions/ExceptionCard";
import type { ExceptionReport, ExceptionStatus } from "@/features/exceptions/types";
import { compareBySurname } from "@/lib/name-sort";

export const Route = createFileRoute("/_authenticated/admin/exceptions")({
  head: () => ({
    meta: [
      { title: "Exception reports (Guardian) — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Guardian of Safe Working / educational supervisor dashboard for trainee exception reports.",
      },
    ],
  }),
  component: AdminExceptionsPage,
});

type Filter = "open" | "overdue" | "safety" | "resolved" | "all";
const FILTER_LABEL: Record<Filter, string> = {
  open: "Open",
  overdue: "Overdue",
  safety: "Safety-flagged",
  resolved: "Resolved",
  all: "All",
};

function AdminExceptionsPage() {
  const { hasRole, loading } = useAuth();
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["exceptions", "admin"],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("exception_reports")
        .select("*")
        .order("immediate_safety_concern", { ascending: false })
        .order("due_by", { ascending: true });
      if (error) throw error;
      const reports = (rows ?? []) as ExceptionReport[];
      const staffIds = Array.from(
        new Set([
          ...reports.map((r) => r.trainee_id),
          ...reports.map((r) => r.responder_id).filter(Boolean) as string[],
        ]),
      );
      const nameById = new Map<string, string>();
      if (staffIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", staffIds);
        for (const p of profs ?? []) nameById.set(p.id, p.full_name);
      }
      return { reports, nameById };
    },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const now = Date.now();
    const list = data.reports.filter((r) => {
      const isOpen = !["resolved", "withdrawn"].includes(r.status);
      if (filter === "open" && !isOpen) return false;
      if (filter === "overdue" && !(isOpen && new Date(r.due_by).getTime() < now)) return false;
      if (filter === "safety" && !r.immediate_safety_concern) return false;
      if (filter === "resolved" && r.status !== "resolved") return false;
      // filter === "all" → no status filter
      if (q) {
        const name = data.nameById.get(r.trainee_id) ?? "";
        if (!name.toLowerCase().includes(q.toLowerCase())
          && !r.description.toLowerCase().includes(q.toLowerCase())) return false;
      }
      return true;
    });
    list.sort((a, b) => {
      if (a.immediate_safety_concern !== b.immediate_safety_concern) {
        return a.immediate_safety_concern ? -1 : 1;
      }
      const nameA = data.nameById.get(a.trainee_id) ?? "";
      const nameB = data.nameById.get(b.trainee_id) ?? "";
      return compareBySurname(nameA, nameB) || a.due_by.localeCompare(b.due_by);
    });
    return list;
  }, [data, filter, q]);

  if (loading) return <PageLoading />;
  if (!hasRole("admin")) return <Navigate to="/" />;

  const now = Date.now();
  const openCount = data?.reports.filter((r) => !["resolved", "withdrawn"].includes(r.status)).length ?? 0;
  const overdueCount = data?.reports.filter(
    (r) => !["resolved", "withdrawn"].includes(r.status) && new Date(r.due_by).getTime() < now,
  ).length ?? 0;
  const safetyCount = data?.reports.filter(
    (r) => r.immediate_safety_concern && !["resolved", "withdrawn"].includes(r.status),
  ).length ?? 0;
  const resolvedCount = data?.reports.filter((r) => r.status === "resolved").length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Exception reports"
        description="Guardian of Safe Working / educational supervisor dashboard. Reports have a 7-day response SLA (same working day for immediate safety concerns)."
        actions={
          <>
            <div className="w-40">
              <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(FILTER_LABEL) as Filter[]).map((k) => (
                    <SelectItem key={k} value={k}>{FILTER_LABEL[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              placeholder="Search trainee or text…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-xs"
            />
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard icon={Clock} label="Open" value={openCount} />
        <StatCard icon={ShieldAlert} tone={overdueCount > 0 ? "destructive" : "default"}
          label="Overdue" value={overdueCount} />
        <StatCard icon={AlertTriangle} tone={safetyCount > 0 ? "destructive" : "default"}
          label="Safety-flagged open" value={safetyCount} />
        <StatCard icon={ShieldCheck} tone="success" label="Resolved" value={resolvedCount} />
      </div>

      {isLoading ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          No exception reports match this view.
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const traineeName = data?.nameById.get(r.trainee_id) ?? "Unknown trainee";
            const responderName = r.responder_id ? data?.nameById.get(r.responder_id) ?? null : null;
            return (
              <ExceptionCard
                key={r.id}
                report={r}
                traineeName={traineeName}
                responderName={responderName}
                canRespond
                onChange={() => refetch()}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
