import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import { computeLeaveConflicts, type LeaveConflict } from "@/features/leave/leave-utils";
import {
  computeStudyBudget,
  previewAfterDecision,
  type StudyLeaveRow,
} from "@/features/leave/study-leave-budget";
import { leaveWorkingDays } from "@/features/leave/leave-allowances";
import { StudyLeaveBudgetCard } from "@/components/leave/StudyLeaveBudgetCard";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { notifyLeaveDecided } from "@/features/leave/leave-notifications.functions";
import { formatDateGB } from "@/lib/utils";
import { PageLoading } from "@/components/loading";

interface LeaveRow {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  half_day_start: string | null;
  half_day_end: string | null;
  reason: string | null;
  conflict_notes: string | null;
  decision_notes: string | null;
  decided_at: string | null;
  reserve_listed_at: string | null;
  created_at: string;
  study_cost_gbp: number | null;
}

interface AllowanceRow {
  staff_id: string;
  leave_year_start: string;
  study_days: number;
  study_budget_gbp: number;
}

interface StaffProfile {
  name: string;
  grade: string | null;
}

function defaultLeaveYearStart(today = new Date()): string {
  // NHS leave year: 1 April → 31 March.
  const y = today.getUTCFullYear();
  const beforeApril = today.getUTCMonth() < 3;
  return `${beforeApril ? y - 1 : y}-04-01`;
}


export const Route = createFileRoute("/_authenticated/coordinator/leave")({
  head: () => ({ meta: [{ title: "Coordinator — Leave — Salisbury Anaesthetics Rota" }] }),
  component: ApproveLeavePage,
});

function ApproveLeavePage() {
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, StaffProfile>>({});
  const [allowances, setAllowances] = useState<AllowanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("pending");

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("leave_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    const all = (data ?? []) as LeaveRow[];
    setRows(all);
    const staffIds = [...new Set(all.map((r) => r.staff_id))];
    if (staffIds.length) {
      const [profRes, allowanceRes] = await Promise.all([
        supabase.from("profiles").select("id, full_name, email, grade").in("id", staffIds),
        supabase
          .from("leave_allowances")
          .select("staff_id, leave_year_start, study_days, study_budget_gbp")
          .in("staff_id", staffIds),
      ]);
      setProfiles(Object.fromEntries(
        (profRes.data ?? []).map((p) => [
          p.id,
          { name: p.full_name || p.email, grade: p.grade ?? null } as StaffProfile,
        ]),
      ));
      setAllowances((allowanceRes.data ?? []) as AllowanceRow[]);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const filtered = rows.filter((r) =>
    tab === "pending" ? r.status === "pending" : r.status !== "pending",
  );

  // Rows needed for study-budget aggregation, in the shape the pure helper expects.
  const studyLeaveRows: StudyLeaveRow[] = useMemo(
    () => rows.map((r) => ({
      id: r.id,
      staff_id: r.staff_id,
      type: r.type,
      status: r.status,
      start_date: r.start_date,
      end_date: r.end_date,
      half_day_start: r.half_day_start,
      half_day_end: r.half_day_end,
      study_cost_gbp: r.study_cost_gbp,
    })),
    [rows],
  );
  const allowanceByStaff = useMemo(() => {
    const m = new Map<string, AllowanceRow>();
    for (const a of allowances) m.set(a.staff_id, a);
    return m;
  }, [allowances]);
  const yearStart = defaultLeaveYearStart();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approve leave</h1>
        <p className="text-sm text-muted-foreground">Pending requests with cover-impact analysis.</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pending">
            Pending {rows.filter((r) => r.status === "pending").length > 0 && `(${rows.filter((r) => r.status === "pending").length})`}
          </TabsTrigger>
          <TabsTrigger value="decided">Decided</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="space-y-4 mt-4">
          {loading ? (
            <PageLoading />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here.</p>
          ) : (
            filtered.map((r) => (
              <LeaveCard
                key={r.id}
                row={r}
                profile={profiles[r.staff_id] ?? { name: r.staff_id, grade: null }}
                allowance={allowanceByStaff.get(r.staff_id)}
                studyRows={studyLeaveRows}
                yearStart={yearStart}
                onChanged={load}
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}


function LeaveCard({
  row,
  profile,
  allowance,
  studyRows,
  yearStart,
  onChanged,
}: {
  row: LeaveRow;
  profile: StaffProfile;
  allowance: AllowanceRow | undefined;
  studyRows: StudyLeaveRow[];
  yearStart: string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const staffName = profile.name;
  const notifyDecided = useServerFn(notifyLeaveDecided);
  const [conflicts, setConflicts] = useState<LeaveConflict[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState(false);
  const [costInput, setCostInput] = useState<string>(
    row.study_cost_gbp != null ? String(row.study_cost_gbp) : "",
  );

  const isStudy = row.type === "study";
  const requestDays = useMemo(() => leaveWorkingDays(row), [row]);
  const requestCostGbp = useMemo(() => {
    const n = Number.parseFloat(costInput);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [costInput]);

  const baseBudget = useMemo(
    () => (isStudy
      ? computeStudyBudget(row.staff_id, studyRows, allowance, yearStart, row.id)
      : null),
    [isStudy, row.staff_id, row.id, studyRows, allowance, yearStart],
  );
  const previewBudget = useMemo(
    () => (baseBudget
      ? previewAfterDecision(baseBudget, { days: requestDays, costGbp: requestCostGbp }, "approved")
      : null),
    [baseBudget, requestDays, requestCostGbp],
  );

  useEffect(() => {
    if (row.status !== "pending") return;
    setLoading(true);
    void computeLeaveConflicts(
      row.staff_id,
      row.start_date,
      row.end_date,
      (row.half_day_start as "am" | "pm" | null) ?? null,
      (row.half_day_end as "am" | "pm" | null) ?? null,
      row.id,
    ).then((c) => { setConflicts(c); setLoading(false); });
  }, [row.id]);

  const persistCost = async (): Promise<boolean> => {
    if (!isStudy) return true;
    if (costInput === "" && row.study_cost_gbp == null) return true;
    const next = costInput === "" ? null : requestCostGbp;
    if (next === row.study_cost_gbp) return true;
    const { error } = await supabase
      .from("leave_requests")
      .update({ study_cost_gbp: next })
      .eq("id", row.id);
    if (error) { toast.error(error.message); return false; }
    return true;
  };

  const decide = async (status: "approved" | "rejected", reserveList = false) => {
    if (!user) return;
    setActing(true);
    const costOk = await persistCost();
    if (!costOk) { setActing(false); return; }
    const { error } = await supabase
      .from("leave_requests")
      .update({
        status,
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        decision_notes: notes || null,
        ...(reserveList ? { reserve_listed_at: new Date().toISOString() } : {}),
      })
      .eq("id", row.id);
    setActing(false);
    if (error) return toast.error(error.message);
    toast.success(reserveList ? "Rejected & placed on reserve list" : `Leave ${status}`);
    invalidateWellbeing(qc, `leave.decide:${status}${reserveList ? "+reserve" : ""}`);
    void notifyDecided({ data: { leaveId: row.id } }).catch((e) => console.error("notify failed", e));
    onChanged();
  };


  const ownConflicts = (conflicts ?? []).filter((c) => c.type === "rota_assignment");
  const otherConflicts = (conflicts ?? []).filter((c) => c.type === "other_leave");

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{staffName}</CardTitle>
            <div className="text-xs text-muted-foreground mt-1">
              <span className="capitalize">{row.type}</span> · {formatDateGB(row.start_date)}
              {row.half_day_start ? ` (${row.half_day_start === "am" ? "PM only" : "AM only"})` : ""}
              {" → "}
              {formatDateGB(row.end_date)}
              {row.half_day_end ? ` (${row.half_day_end} only)` : ""}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge
              variant={row.status === "approved" ? "default" : row.status === "pending" ? "secondary" : "destructive"}
              className="capitalize"
            >
              {row.status}
            </Badge>
            {row.reserve_listed_at && <Badge variant="outline">Reserve list</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {row.reason && (
          <div className="text-sm">
            <span className="text-muted-foreground">Reason:</span> {row.reason}
          </div>
        )}

        {row.status === "pending" && (
          <>
            {loading ? (
              <p className="text-xs text-muted-foreground">Checking cover…</p>
            ) : (
              <>
                {ownConflicts.length > 0 ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>{ownConflicts.length} clinical session(s) need cover</AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 list-disc pl-5 text-xs">
                        {ownConflicts.map((c, i) => (
                          <li key={i}>{formatDateGB(c.date)} · {c.session.toUpperCase()} · {c.theatre ?? "—"} ({c.role})</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <p className="text-xs text-success">No rota assignments affected.</p>
                )}

                {otherConflicts.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Also off in this window:{" "}
                    {[...new Set(otherConflicts.map((c) => c.staffName))].join(", ")}
                  </div>
                )}
              </>
            )}

            {isStudy && baseBudget && previewBudget && (
              <div className="space-y-2">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div className="space-y-1">
                    <Label htmlFor={`cost-${row.id}`} className="text-xs">
                      Estimated cost (£)
                      <span className="ml-1 font-normal text-muted-foreground">
                        course fees, travel, accommodation
                      </span>
                    </Label>
                    <Input
                      id={`cost-${row.id}`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="10"
                      placeholder="0"
                      value={costInput}
                      onChange={(e) => setCostInput(e.target.value)}
                      className="max-w-[10rem]"
                    />
                  </div>
                  <div className="text-xs text-muted-foreground sm:text-right">
                    {requestDays.toFixed(requestDays % 1 === 0 ? 0 : 1)} working day{requestDays === 1 ? "" : "s"} requested
                  </div>
                </div>
                <StudyLeaveBudgetCard
                  base={baseBudget}
                  preview={previewBudget}
                  requestDays={requestDays}
                  requestCostGbp={requestCostGbp}
                />
              </div>
            )}

            <Textarea
              placeholder="Decision notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />


            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => decide("approved")} disabled={acting}>
                <Check className="mr-1 h-4 w-4" /> Approve
              </Button>
              <Button size="sm" variant="destructive" onClick={() => decide("rejected")} disabled={acting}>
                <X className="mr-1 h-4 w-4" /> Reject
              </Button>
              <Button size="sm" variant="outline" onClick={() => decide("rejected", true)} disabled={acting}>
                Reject & place on reserve list
              </Button>
            </div>
          </>
        )}

        {row.status !== "pending" && isStudy && baseBudget && row.study_cost_gbp != null && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Study cost:</span>{" "}
            {new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 })
              .format(Number(row.study_cost_gbp))}
            {" · "}
            <span className="font-medium">Budget left this year:</span>{" "}
            {new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 })
              .format(baseBudget.remainingGbp - (row.status === "approved" ? Number(row.study_cost_gbp) : 0))}
          </div>
        )}

        {row.status !== "pending" && row.decision_notes && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Decision notes:</span> {row.decision_notes}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
