import { PageHeader } from "@/components/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { fetchAllRowsPaged, idKey } from "@/features/audit/paginate";
import { leaveYearWindow } from "@/features/leave/leave-count";

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

  const [loadError, setLoadError] = useState<string | null>(null);
  const [yearError, setYearError] = useState<string | null>(null);
  const [yearLoading, setYearLoading] = useState(false);
  const yearReq = useRef(0);

  const fmtIso = (d: Date) => format(d, "yyyy-MM-dd");

  // Page with a stable (start_date, id) order — the API caps each response
  // at 1000 rows, so a single wide .range() silently truncated totals.
  const load = async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const today = new Date();
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - 400);
    const windowEnd = new Date(today);
    windowEnd.setFullYear(windowEnd.getFullYear() + 2);
    try {
      const [leave, profRes, allowances, mine] = await Promise.all([
        fetchAllRowsPaged<LeaveRow>(
          (from, to) =>
            supabase
              .from("leave_requests")
              .select("*")
              .gte("end_date", fmtIso(windowStart))
              .lte("start_date", fmtIso(windowEnd))
              .order("start_date", { ascending: true })
              .order("id", { ascending: true })
              .range(from, to) as never,
          { label: "Department leave", rowKey: idKey as never },
        ),
        supabase.from("profiles").select("id, full_name, grade").eq("active", true),
        fetchAllRowsPaged<AllowanceRow>(
          (from, to) =>
            supabase
              .from("leave_allowances")
              .select("id, staff_id, leave_year_start, annual_days, study_days, professional_days")
              .order("staff_id")
              .order("leave_year_start")
              .order("id")
              .range(from, to) as never,
          { label: "Leave allowances" },
        ),
        fetchAllRowsPaged<LeaveRow>(
          (from, to) =>
            supabase
              .from("leave_requests")
              .select("*")
              .eq("staff_id", user.id)
              .order("start_date", { ascending: false })
              .order("id", { ascending: true })
              .range(from, to) as never,
          { label: "My leave", rowKey: idKey as never },
        ),
      ]);
      if (profRes.error) throw new Error(profRes.error.message);
      setRows(leave);
      setProfiles((profRes.data ?? []) as ProfileRow[]);
      setAllowances(allowances);
      setMyLeave(mine);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load leave.";
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const loadYear = async (yearStartISO: string) => {
    if (!user) return;
    const req = ++yearReq.current;
    // Clear the previous year's totals so they are never shown under the new year label.
    setYearLeave([]);
    setYearError(null);
    setYearLoading(true);
    const w = leaveYearWindow(yearStartISO);
    try {
      const data = await fetchAllRowsPaged<LeaveRow>(
        (from, to) =>
          supabase
            .from("leave_requests")
            .select("id, staff_id, type, status, start_date, end_date, half_day_start, half_day_end")
            .in("status", ["approved", "pending"])
            .lt("start_date", w.endExclusive)
            .gte("end_date", w.start)
            .order("start_date", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to) as never,
        { label: "Leave year totals", rowKey: idKey as never },
      );
      if (req !== yearReq.current) return; // stale response for a previous year
      setYearLeave(data);
    } catch (e) {
      if (req !== yearReq.current) return;
      const msg = e instanceof Error ? e.message : "Could not load leave totals.";
      setYearError(msg);
      toast.error(msg);
    } finally {
      if (req === yearReq.current) setYearLoading(false);
    }
  };

  const reloadAll = () => {
    void load();
    void loadYear(selectedYearStartISO);
  };

  useEffect(() => { void load(); }, [user?.id]);

  useEffect(() => {
    void loadYear(selectedYearStartISO);
  }, [user?.id, selectedYearStartISO]);

  const cancel = async (id: string) => {
    const result = await optimisticCancelLeave({
      id,
      // Supabase's generated typings are deeply generic; the helper only
      // needs the minimal `.from().update().eq()` surface it declares.
      supabase: supabase as unknown as Parameters<typeof optimisticCancelLeave>[0]["supabase"],
      qc,
      patchRows: (u) => setRows((prev) => u(prev)),
      patchMyLeave: (u) => setMyLeave((prev) => u(prev)),
    });
    if (!result.ok) {
      toast.error(result.error.message);
      return;
    }
    toast.success("Request cancelled");
    // Reconcile local row arrays AND year totals with server truth
    // (invalidateWellbeing inside the helper handles the wellbeing caches).
    reloadAll();
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

      {loadError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <span>Leave could not be fully loaded, so totals below may be incomplete: {loadError}</span>
          <Button size="sm" variant="outline" onClick={reloadAll}>Retry</Button>
        </div>
      )}
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
          {yearError && (
            <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <span>Totals for this leave year could not be loaded and are not shown: {yearError}</span>
              <Button size="sm" variant="outline" onClick={() => void loadYear(selectedYearStartISO)}>Retry</Button>
            </div>
          )}
          <AllowancesTab
            loading={loading || yearLoading || !!yearError}
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

      <LeaveRequestDialog open={open} onOpenChange={setOpen} onSubmitted={reloadAll} />
    </div>
  );
}
