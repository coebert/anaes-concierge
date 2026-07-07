import { createFileRoute, Navigate, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/loading";
import { StatCard } from "@/components/stat-card";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ClipboardList,
  HeartPulse,
  Inbox,
  ShieldAlert,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import {
  buildInbox,
  type InboxItem,
  type InboxItemKind,
  type LeaveInboxRow,
  type ExceptionInboxRow,
  type RtwInboxRow,
  type CompetencyInboxRow,
} from "@/features/inbox/inbox";

export const Route = createFileRoute("/_authenticated/admin/inbox")({
  head: () => ({
    meta: [
      { title: "Coordinator inbox — Salisbury Anaesthetics" },
      {
        name: "description",
        content:
          "Prioritised inbox for the rota coordinator: pending leave, open exceptions, overdue return-to-work interviews and upcoming competency expiries.",
      },
    ],
  }),
  component: CoordinatorInboxPage,
});

type KindFilter = InboxItemKind | "all";

const KIND_META: Record<InboxItemKind, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = {
  leave: { label: "Leave", icon: CalendarClock },
  exception: { label: "Exception", icon: ShieldAlert },
  rtw: { label: "RTW", icon: HeartPulse },
  competency: { label: "Competency", icon: ShieldCheck },
};

const SEVERITY_STYLES: Record<InboxItem["severity"], string> = {
  critical: "border-l-4 border-l-destructive",
  warning: "border-l-4 border-l-amber-500",
  info: "border-l-4 border-l-muted",
};

const SEVERITY_BADGE: Record<InboxItem["severity"], string> = {
  critical: "bg-destructive/15 text-destructive",
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  info: "bg-muted text-muted-foreground",
};

const RTW_OVERDUE_WORKING_DAYS = 3;

function isoToUTC(iso: string): number {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

function workingDaysSince(dateIso: string, today: Date): number {
  let count = 0;
  const cursor = new Date(isoToUTC(dateIso));
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= today) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function CoordinatorInboxPage() {
  const { hasRole, loading, user } = useAuth();
  const [filter, setFilter] = useState<KindFilter>("all");
  const [showAddressed, setShowAddressed] = useState(false);
  const queryClient = useQueryClient();

  const dismissalsQuery = useQuery({
    queryKey: ["coordinator-inbox-dismissals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inbox_dismissals")
        .select("item_id,kind,dismissed_at,dismissed_by");
      if (error) throw error;
      return data ?? [];
    },
  });

  const dismissedIds = useMemo(
    () => new Set((dismissalsQuery.data ?? []).map((d) => d.item_id)),
    [dismissalsQuery.data],
  );

  const dismissMutation = useMutation({
    mutationFn: async (item: InboxItem) => {
      if (!user) throw new Error("Not signed in");
      const { error } = await supabase.from("inbox_dismissals").upsert({
        item_id: item.id,
        kind: item.kind,
        dismissed_by: user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["coordinator-inbox-dismissals"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to mark addressed";
      toast.error(msg);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from("inbox_dismissals")
        .delete()
        .eq("item_id", itemId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["coordinator-inbox-dismissals"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to restore item";
      toast.error(msg);
    },
  });


  const { data, isLoading } = useQuery({
    queryKey: ["coordinator-inbox"],
    queryFn: async () => {
      const todayIso = new Date().toISOString().slice(0, 10);
      const sixtyDays = new Date();
      sixtyDays.setUTCDate(sixtyDays.getUTCDate() + 60);
      const sixtyIso = sixtyDays.toISOString().slice(0, 10);

      const [leaveRes, excRes, sickRes, rtwRes, compRes, profRes, compDefRes] =
        await Promise.all([
          supabase
            .from("leave_requests")
            .select("id,staff_id,type,status,start_date,end_date,created_at")
            .eq("status", "pending")
            .range(0, 999),
          supabase
            .from("exception_reports")
            .select("id,trainee_id,status,due_by,immediate_safety_concern,description,category")
            .range(0, 999),
          supabase
            .from("leave_requests")
            .select("id,staff_id,start_date,end_date")
            .eq("type", "sick")
            .eq("status", "approved")
            .lte("end_date", todayIso)
            .range(0, 999),
          supabase
            .from("return_to_work_interviews")
            .select("leave_request_id")
            .range(0, 9999),
          supabase
            .from("staff_competencies")
            .select("id,staff_id,competency_id,expires_at,revoked_at")
            .not("expires_at", "is", null)
            .is("revoked_at", null)
            .lte("expires_at", sixtyIso)
            .range(0, 999),
          supabase.from("profiles").select("id,full_name,email"),
          supabase.from("competencies").select("id,name"),
        ]);

      if (leaveRes.error) throw leaveRes.error;
      if (excRes.error) throw excRes.error;
      if (sickRes.error) throw sickRes.error;
      if (rtwRes.error) throw rtwRes.error;
      if (compRes.error) throw compRes.error;
      if (profRes.error) throw profRes.error;
      if (compDefRes.error) throw compDefRes.error;

      const nameById = new Map<string, string>();
      for (const p of profRes.data ?? []) {
        nameById.set(p.id, p.full_name || p.email || "Unknown");
      }
      const compNameById = new Map<string, string>();
      for (const c of compDefRes.data ?? []) compNameById.set(c.id, c.name);

      // Compute overdue RTW rows client-side (mirrors absence-summary logic).
      const today = new Date();
      const todayUtc = new Date(Date.UTC(
        today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
      ));
      const rtwSet = new Set<string>();
      for (const r of rtwRes.data ?? []) rtwSet.add(r.leave_request_id);

      const rtws: RtwInboxRow[] = [];
      for (const s of sickRes.data ?? []) {
        if (rtwSet.has(s.id)) continue;
        const wd = workingDaysSince(s.end_date, todayUtc);
        if (wd <= RTW_OVERDUE_WORKING_DAYS) continue;
        rtws.push({
          leave_request_id: s.id,
          staff_id: s.staff_id,
          spell_start: s.start_date,
          spell_end: s.end_date,
          daysOverdue: wd - RTW_OVERDUE_WORKING_DAYS,
        });
      }

      const competencies: CompetencyInboxRow[] = (compRes.data ?? [])
        .filter((r) => !!r.expires_at)
        .map((r) => ({
          id: r.id,
          staff_id: r.staff_id,
          competency_name: compNameById.get(r.competency_id) ?? "Competency",
          expires_at: r.expires_at as string,
        }));

      return {
        leave: (leaveRes.data ?? []) as LeaveInboxRow[],
        exceptions: (excRes.data ?? []) as ExceptionInboxRow[],
        rtws,
        competencies,
        nameById,
      };
    },
  });

  const allItems = useMemo(() => (data ? buildInbox(data) : []), [data]);
  const pendingItems = useMemo(
    () => allItems.filter((i) => !dismissedIds.has(i.id)),
    [allItems, dismissedIds],
  );
  const addressedItems = useMemo(
    () => allItems.filter((i) => dismissedIds.has(i.id)),
    [allItems, dismissedIds],
  );
  const items = showAddressed ? addressedItems : pendingItems;
  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.kind === filter)),
    [items, filter],
  );

  if (loading) return <PageLoading />;
  if (!hasRole("admin") && !hasRole("rota_coordinator")) return <Navigate to="/" />;

  const counts = {
    leave: items.filter((i) => i.kind === "leave").length,
    exception: items.filter((i) => i.kind === "exception").length,
    rtw: items.filter((i) => i.kind === "rtw").length,
    competency: items.filter((i) => i.kind === "competency").length,
  };
  const criticalCount = pendingItems.filter((i) => i.severity === "critical").length;


  return (
    <div className="space-y-6">
      <PageHeader
        title="Coordinator inbox"
        description="Everything that needs a decision or action, sorted by urgency. Safety concerns and overdue items come first."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          icon={AlertTriangle}
          tone={criticalCount > 0 ? "destructive" : "default"}
          label="Critical / overdue"
          value={criticalCount}
        />
        <StatCard icon={CalendarClock} label="Pending leave" value={counts.leave} />
        <StatCard icon={ShieldAlert} label="Open exceptions" value={counts.exception} />
        <StatCard icon={HeartPulse} label="Overdue RTW" value={counts.rtw} />
        <StatCard icon={ShieldCheck} label="Expiring competencies" value={counts.competency} />
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          All ({items.length})
        </FilterChip>
        {(Object.keys(KIND_META) as InboxItemKind[]).map((k) => (
          <FilterChip
            key={k}
            active={filter === k}
            onClick={() => setFilter(k)}
          >
            {KIND_META[k].label} ({counts[k]})
          </FilterChip>
        ))}
      </div>

      {isLoading ? (
        <PageLoading />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 opacity-60" aria-hidden="true" />
            <div>Inbox zero. Nothing needs a decision right now.</div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const meta = KIND_META[item.kind];
  const Icon = meta.icon;
  return (
    <Card className={SEVERITY_STYLES[item.severity]}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="truncate font-medium">{item.title}</div>
              <Badge className={SEVERITY_BADGE[item.severity]} variant="secondary">
                {item.severity === "critical" ? "Urgent" : item.severity === "warning" ? "Soon" : "Upcoming"}
              </Badge>
              <Badge variant="outline">{meta.label}</Badge>
            </div>
            <div className="text-sm text-muted-foreground">{item.detail}</div>
          </div>
        </div>
        <Button asChild size="sm" variant="outline" className="self-start sm:self-center">
          <Link to={item.href}>Open</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
