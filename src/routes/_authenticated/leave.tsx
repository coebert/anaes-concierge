import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { LeaveRequestDialog } from "@/components/leave-request-dialog";
import { toast } from "sonner";

interface LeaveRow {
  id: string;
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
  created_at: string;
}

export const Route = createFileRoute("/_authenticated/leave")({
  component: LeavePage,
});

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "approved") return "default";
  if (s === "rejected" || s === "cancelled") return "destructive";
  return "secondary";
}

function LeavePage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("leave_requests")
      .select("*")
      .eq("staff_id", user.id)
      .order("start_date", { ascending: false });
    if (error) toast.error(error.message);
    setRows((data ?? []) as LeaveRow[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [user?.id]);

  const cancel = async (id: string) => {
    const { error } = await supabase.from("leave_requests").update({ status: "cancelled" }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Request cancelled");
    void load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Leave</h1>
          <p className="text-sm text-muted-foreground">Submit and track annual, study and compassionate leave requests.</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New request
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">My requests</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dates</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.start_date}
                      {r.half_day_start ? ` (${r.half_day_start === "am" ? "PM only" : "AM only"})` : ""}
                      {" → "}
                      {r.end_date}
                      {r.half_day_end ? ` (${r.half_day_end} only)` : ""}
                    </TableCell>
                    <TableCell className="capitalize">{r.type}</TableCell>
                    <TableCell><Badge variant={statusVariant(r.status)} className="capitalize">{r.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-sm">
                      {r.conflict_notes && <div className="text-amber-700">⚠ {r.conflict_notes}</div>}
                      {r.decision_notes && <div>{r.decision_notes}</div>}
                      {r.reason && <div className="italic">{r.reason}</div>}
                    </TableCell>
                    <TableCell>
                      {r.status === "pending" && (
                        <Button variant="ghost" size="icon" onClick={() => cancel(r.id)} title="Cancel">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <LeaveRequestDialog open={open} onOpenChange={setOpen} onSubmitted={load} />
    </div>
  );
}
