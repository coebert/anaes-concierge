import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import { formatDateWithWeekdayGB } from "@/lib/utils";

export function RTWInterviewDialog({
  open,
  onOpenChange,
  onSaved,
  staffId,
  leaveRequestId,
  spellStart,
  spellEnd,
  staffName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  staffId: string;
  leaveRequestId: string;
  spellStart: string;
  spellEnd: string;
  staffName?: string | null;
}) {
  const { user } = useAuth();
  const today = new Date().toISOString().slice(0, 10);

  const [conductedAt, setConductedAt] = useState(today);
  const [fitness, setFitness] = useState(true);
  const [adjustments, setAdjustments] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [followUpDate, setFollowUpDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase.from("return_to_work_interviews").insert({
      leave_request_id: leaveRequestId,
      staff_id: staffId,
      conducted_by: user.id,
      conducted_at: new Date(conductedAt).toISOString(),
      fitness_confirmed: fitness,
      reasonable_adjustments: adjustments.trim() || null,
      follow_up_required: followUp,
      follow_up_date: followUp && followUpDate ? followUpDate : null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast.error(`Could not save interview: ${error.message}`);
      return;
    }
    toast.success("Return-to-Work interview recorded.");
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Return-to-Work interview</DialogTitle>
          <DialogDescription>
            Recording the RTW conversation for{staffName ? ` ${staffName}` : " this staff member"} —
            sickness {formatDateWithWeekdayGB(spellStart)} to {formatDateWithWeekdayGB(spellEnd)}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rtw-date">Interview date</Label>
            <Input
              id="rtw-date"
              type="date"
              max={today}
              value={conductedAt}
              onChange={(e) => setConductedAt(e.target.value)}
            />
          </div>

          <label className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
            <Checkbox
              checked={fitness}
              onCheckedChange={(v) => setFitness(v === true)}
              className="mt-0.5"
            />
            <div className="grid gap-0.5 text-sm">
              <span className="font-medium">Fit to return to full duties</span>
              <span className="text-xs text-muted-foreground">
                Untick if a phased return, restrictions, or occupational-health input is required.
              </span>
            </div>
          </label>

          <div className="grid gap-1.5">
            <Label htmlFor="rtw-adjust">Reasonable adjustments agreed</Label>
            <Textarea
              id="rtw-adjust"
              rows={3}
              value={adjustments}
              onChange={(e) => setAdjustments(e.target.value)}
              placeholder="e.g. phased return over 2 weeks, no on-calls until reviewed…"
            />
          </div>

          <label className="flex items-start gap-2 rounded-md border p-3">
            <Checkbox
              checked={followUp}
              onCheckedChange={(v) => setFollowUp(v === true)}
              className="mt-0.5"
            />
            <div className="grid gap-1 flex-1">
              <span className="text-sm font-medium">Follow-up required</span>
              {followUp ? (
                <Input
                  type="date"
                  min={today}
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                />
              ) : null}
            </div>
          </label>

          <div className="grid gap-1.5">
            <Label htmlFor="rtw-notes">Notes</Label>
            <Textarea
              id="rtw-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Themes discussed, welfare concerns, referrals made. Stored encrypted."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Record interview"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
