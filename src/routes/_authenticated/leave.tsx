import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import { optimisticCancelLeave } from "@/features/leave/optimistic-cancel-leave";
import { LeaveRequestDialog } from "@/components/leave-request-dialog";
import { toast } from "sonner";

import { type AllowanceLike as AllowanceRow } from "@/features/leave/leave-allowances";
import {
  ACTIVE_STATUSES,
  type LeaveRow,
  type ProfileRow,
} from "@/features/leave/tabs/shared";
import { DayCalendarTab } from "@/features/leave/tabs/DayCalendarTab";
import { UpcomingLeaveTab } from "@/features/leave/tabs/UpcomingLeaveTab";
import { SickLeaveTab, type SickRow } from "@/features/leave/tabs/SickLeaveTab";
import { AllowancesTab } from "@/features/leave/tabs/AllowancesTab";
import {
  MyLeaveTab,
  MyLeaveTabLabel,
  MyLeaveDescription,
} from "@/features/leave/tabs/MyLeaveTab";

// Re-exported so existing UI tests continue to import from "./leave".
export { MyLeaveTabLabel, MyLeaveDescription };

export const Route = createFileRoute("/_authenticated/leave")({
  head: () => ({ meta: [{ title: "Leave — Salisbury Anaesthetics Rota" }] }),
  component: LeavePage,
});

function LeavePage() {
  const { user, isCoordinatorOrAdmin } = useAuth();
  const qc = useQueryClient();
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [allowances, setAllowances] = useState<AllowanceRow[]>([]);
  const [yearLeave, setYearLeave] = useState<LeaveRow[]>([]);
  const [myLeave, setMyLeave] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const defaultYearStartISO = useMemo(() => {
    const t = new Date();
    const year = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
    return `${year}-04-01`;
  }, []);

  const [selectedYearStartISO, setSelectedYearStartISO] = useState<string>(defaultYearStartISO);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const today = new Date();
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - 400);
    const windowEnd = new Date(today);
    windowEnd.setFullYear(windowEnd.getFullYear() + 2);
    const fmtIso = (d: Date) => format(d, "yyyy-MM-dd");

    const [leaveRes, profRes, allowRes] = await Promise.all([
      supabase
        .from("leave_requests")
        .select("*")
        .gte("end_date", fmtIso(windowStart))
        .lte("start_date", fmtIso(windowEnd))
        .order("start_date", { ascending: true })
        .range(0, 4999),
      supabase
        .from("profiles")
        .select("id, full_name, grade")
        .eq("active", true),
      supabase
        .from("leave_allowances")
        .select("staff_id, leave_year_start, annual_days, study_days, professional_days"),
    ]);
    if (leaveRes.error) toast.error(leaveRes.error.message);
    if (profRes.error) toast.error(profRes.error.message);
    if (allowRes.error) toast.error(allowRes.error.message);
    setRows((leaveRes.data ?? []) as LeaveRow[]);
    setProfiles((profRes.data ?? []) as ProfileRow[]);
    setAllowances((allowRes.data ?? []) as AllowanceRow[]);

    const mineRes = await supabase
      .from("leave_requests")
      .select("*")
      .eq("staff_id", user.id)
      .order("start_date", { ascending: false })
      .range(0, 4999);
    if (mineRes.error) toast.error(mineRes.error.message);
    setMyLeave((mineRes.data ?? []) as LeaveRow[]);

    setLoading(false);
  };

  useEffect(() => { void load(); }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const yStart = new Date(selectedYearStartISO + "T00:00:00Z");
    const yEnd = new Date(yStart);
    yEnd.setUTCFullYear(yEnd.getUTCFullYear() + 1);
    const fmtIso = (d: Date) => format(d, "yyyy-MM-dd");
    void supabase
      .from("leave_requests")
      .select("id, staff_id, type, status, start_date, end_date, half_day_start, half_day_end")
      .in("status", ["approved", "pending"])
      .lte("start_date", fmtIso(yEnd))
      .gte("end_date", fmtIso(yStart))
      .order("start_date", { ascending: true })
      .range(0, 9999)
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        else setYearLeave((data ?? []) as LeaveRow[]);
      });
  }, [user?.id, selectedYearStartISO]);

  const cancel = async (id: string) => {
    const result = await optimisticCancelLeave({
      id,
      supabase,
      qc,
      patchRows: (u) => setRows((prev) => u(prev)),
      patchMyLeave: (u) => setMyLeave((prev) => u(prev)),
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success("Request cancelled");
    // Reconcile local row arrays with server truth (invalidateWellbeing
    // inside the helper handles the wellbeing caches).
    void load();
  };

  const profileById = useMemo(() => {
    const m = new Map<string, ProfileRow>();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  const activeRows = useMemo(
    () => rows.filter((r) => ACTIVE_STATUSES.has(r.status)),
    [rows],
  );

  const myRows = useMemo(
    () => (user ? myLeave.filter((r) => r.staff_id === user.id) : []),
    [myLeave, user],
  );

  const allUpcoming = useMemo(() => {
    const today = format(new Date(), "yyyy-MM-dd");
    return activeRows
      .filter((r) => r.end_date >= today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [activeRows]);

  const sickRows = useMemo<SickRow[]>(() => {
    const out: SickRow[] = [];
    for (const r of rows) {
      if (r.type !== "sick") continue;
      if (r.status === "cancelled" || r.status === "rejected") continue;
      const startMs = new Date(r.start_date + "T00:00:00Z").getTime();
      const createdMs = new Date(r.created_at).getTime();
      const daysLate = Math.floor((createdMs - startMs) / (1000 * 60 * 60 * 24));
      out.push({ ...r, _isRetrospective: daysLate >= 1, _daysLate: daysLate });
    }
    return out.sort((a, b) => b.start_date.localeCompare(a.start_date));
  }, [rows]);

  const recentlyAddedSick = useMemo(() => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    return sickRows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
  }, [sickRows]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leave"
        description="Department-wide leave calendar. Search any date to see who is off and the grade breakdown."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> New request
          </Button>
        }
      />

      <Tabs defaultValue="calendar" className="space-y-4">
        <TabsList>
          <TabsTrigger value="calendar">Department calendar</TabsTrigger>
          <TabsTrigger value="upcoming">All upcoming</TabsTrigger>
          <TabsTrigger value="sick">Sick leave</TabsTrigger>
          <TabsTrigger value="allowances">Allowances</TabsTrigger>
          <TabsTrigger value="mine" className="gap-2">
            <MyLeaveTabLabel isCoordinatorOrAdmin={isCoordinatorOrAdmin()} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="calendar">
          <DayCalendarTab
            loading={loading}
            activeRows={activeRows}
            profileById={profileById}
          />
        </TabsContent>

        <TabsContent value="upcoming">
          <UpcomingLeaveTab
            loading={loading}
            allUpcoming={allUpcoming}
            profileById={profileById}
          />
        </TabsContent>

        <TabsContent value="sick">
          <SickLeaveTab
            loading={loading}
            sickRows={sickRows}
            recentlyAddedSick={recentlyAddedSick}
            profileById={profileById}
          />
        </TabsContent>

        <TabsContent value="allowances">
          <AllowancesTab
            loading={loading}
            profiles={profiles}
            yearLeave={yearLeave}
            allowances={allowances}
            defaultYearStartISO={defaultYearStartISO}
            selectedYearStartISO={selectedYearStartISO}
            setSelectedYearStartISO={setSelectedYearStartISO}
          />
        </TabsContent>

        <TabsContent value="mine">
          <MyLeaveTab
            loading={loading}
            myRows={myRows}
            isCoordinatorOrAdmin={isCoordinatorOrAdmin()}
            onCancel={cancel}
          />
        </TabsContent>
      </Tabs>

      <LeaveRequestDialog open={open} onOpenChange={setOpen} onSubmitted={load} />
    </div>
  );
}
