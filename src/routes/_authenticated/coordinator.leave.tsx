import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { computeLeaveConflicts, type LeaveConflict } from "@/features/leave/leave-utils";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { notifyLeaveDecided } from "@/features/leave/leave-notifications.functions";
import { formatDateGB } from "@/lib/utils";

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
}

export const Route = createFileRoute("/_authenticated/coordinator/leave")({
  component: ApproveLeavePage,
});

function ApproveLeavePage() {
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
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
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", staffIds);
      setProfiles(Object.fromEntries((profs ?? []).map((p) => [p.id, p.full_name || p.email])));
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const filtered = rows.filter((r) =>
    tab === "pending" ? r.status === "pending" : r.status !== "pending",
  );

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
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here.</p>
          ) : (
            filtered.map((r) => (
              <LeaveCard key={r.id} row={r} staffName={profiles[r.staff_id] ?? r.staff_id} onChanged={load} />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LeaveCard({ row, staffName, onChanged }: { row: LeaveRow; staffName: string; onChanged: () => void }) {
  const { user } = useAuth();
  const notifyDecided = useServerFn(notifyLeaveDecided);
  const [conflicts, setConflicts] = useState<LeaveConflict[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState(false);

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

  const decide = async (status: "approved" | "rejected", reserveList = false) => {
    if (!user) return;
    setActing(true);
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
                  <p className="text-xs text-emerald-600">No rota assignments affected.</p>
                )}

                {otherConflicts.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Also off in this window:{" "}
                    {[...new Set(otherConflicts.map((c) => c.staffName))].join(", ")}
                  </div>
                )}
              </>
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

        {row.status !== "pending" && row.decision_notes && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Decision notes:</span> {row.decision_notes}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
