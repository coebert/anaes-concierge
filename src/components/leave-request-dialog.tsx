import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { computeLeaveConflicts, countWorkingDays, type LeaveConflict } from "@/features/leave/leave-utils";
import { validateHalfDayRange } from "@/features/leave/half-day-validation";
import { useServerFn } from "@tanstack/react-start";
import { notifyLeaveSubmitted } from "@/features/leave/leave-notifications.functions";
import { formatDateGB } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
}

const TYPES = ["annual", "study", "professional", "compassionate", "sick", "parental", "other"] as const;

export function LeaveRequestDialog({ open, onOpenChange, onSubmitted }: Props) {
  const notify = useServerFn(notifyLeaveSubmitted);
  const { user } = useAuth();
  const [type, setType] = useState<(typeof TYPES)[number]>("annual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [halfDayStart, setHalfDayStart] = useState<"none" | "am" | "pm">("none");
  const [halfDayEnd, setHalfDayEnd] = useState<"none" | "am" | "pm">("none");
  const [reason, setReason] = useState("");
  const [conflicts, setConflicts] = useState<LeaveConflict[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setConflicts(null);
      setReason("");
      setStartDate("");
      setEndDate("");
      setHalfDayStart("none");
      setHalfDayEnd("none");
      setType("annual");
    }
  }, [open]);

  const validate = () => {
    const r = validateHalfDayRange({
      start_date: startDate,
      end_date: endDate,
      half_day_start: halfDayStart === "none" ? null : halfDayStart,
      half_day_end: halfDayEnd === "none" ? null : halfDayEnd,
    });
    if (!r.ok) {
      toast.error(r.errors[0].message);
      return null;
    }
    return r;
  };

  const checkConflicts = async () => {
    if (!user || !startDate || !endDate) return;
    if (!validate()) return;
    setChecking(true);
    try {
      const c = await computeLeaveConflicts(
        user.id,
        startDate,
        endDate,
        halfDayStart === "none" ? null : halfDayStart,
        halfDayEnd === "none" ? null : halfDayEnd,
      );
      setConflicts(c);
    } catch (e) {
      console.error(e);
      toast.error("Failed to check conflicts");
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    if (!user || !startDate || !endDate) return;
    if (!validate()) return;
    setSaving(true);
    const ownConflicts = (conflicts ?? []).filter((c) => c.type === "rota_assignment");
    const conflictNotes =
      ownConflicts.length > 0
        ? `${ownConflicts.length} clinical session(s) need cover: ${ownConflicts
            .map((c) => `${formatDateGB(c.date)} ${c.session.toUpperCase()} ${c.theatre ?? ""}`.trim())
            .join("; ")}`
        : null;

    const { data: inserted, error } = await supabase.from("leave_requests").insert({
      staff_id: user.id,
      type,
      start_date: startDate,
      end_date: endDate,
      half_day_start: halfDayStart === "none" ? null : halfDayStart,
      half_day_end: halfDayEnd === "none" ? null : halfDayEnd,
      reason: reason || null,
      conflict_notes: conflictNotes,
    }).select("id").maybeSingle();
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Leave request submitted");
    if (inserted?.id) {
      void notify({ data: { leaveId: inserted.id } }).catch((e) => console.error("notify failed", e));
    }
    onOpenChange(false);
    onSubmitted?.();
  };

  const workingDays =
    startDate && endDate && endDate >= startDate
      ? countWorkingDays(
          startDate,
          endDate,
          halfDayStart === "none" ? null : halfDayStart,
          halfDayEnd === "none" ? null : halfDayEnd,
        )
      : 0;

  const ownConflicts = (conflicts ?? []).filter((c) => c.type === "rota_assignment");
  const otherConflicts = (conflicts ?? []).filter((c) => c.type === "other_leave");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Request leave</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setConflicts(null); }} />
            </div>
            <div>
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setConflicts(null); }} />
            </div>
            <div>
              <Label>Start day</Label>
              <Select value={halfDayStart} onValueChange={(v) => { setHalfDayStart(v as typeof halfDayStart); setConflicts(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Full day</SelectItem>
                  <SelectItem value="pm">Afternoon only (skip AM)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>End day</Label>
              <Select value={halfDayEnd} onValueChange={(v) => { setHalfDayEnd(v as typeof halfDayEnd); setConflicts(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Full day</SelectItem>
                  <SelectItem value="am">Morning only (skip PM)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Reason (optional)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>

          {workingDays > 0 && (
            <div className="text-sm text-muted-foreground">
              Approx. <strong>{workingDays}</strong> working day(s) (Mon–Fri).
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={checkConflicts} disabled={!startDate || !endDate || checking}>
              {checking ? "Checking…" : "Check conflicts"}
            </Button>
            {conflicts && conflicts.length === 0 && (
              <span className="text-sm text-success">No conflicts detected</span>
            )}
          </div>

          {ownConflicts.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>{ownConflicts.length} clinical session(s) need cover</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {ownConflicts.map((c, i) => (
                    <li key={i}>
                      {formatDateGB(c.date)} · {c.session.toUpperCase()} · {c.theatre ?? "—"} ({c.role})
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {otherConflicts.length > 0 && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Colleagues already on approved leave</AlertTitle>
              <AlertDescription>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {[...new Set(otherConflicts.map((c) => `${formatDateGB(c.date)} · ${c.staffName}`))].map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !startDate || !endDate}>
            {saving ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
