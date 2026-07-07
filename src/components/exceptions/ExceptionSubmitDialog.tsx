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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import {
  CATEGORY_LABEL,
  CATEGORY_DESCRIPTION,
  computeDueBy,
  type ExceptionCategory,
  type SessionHalf,
} from "@/features/exceptions/types";
import { AlertTriangle } from "lucide-react";

export function ExceptionSubmitDialog({
  open,
  onOpenChange,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmitted: () => void;
}) {
  const { user } = useAuth();
  const today = new Date().toISOString().slice(0, 10);

  const [eventDate, setEventDate] = useState(today);
  const [session, setSession] = useState<SessionHalf | "">("");
  const [category, setCategory] = useState<ExceptionCategory>("hours");
  const [description, setDescription] = useState("");
  const [immediate, setImmediate] = useState(false);
  const [hoursExtra, setHoursExtra] = useState("");
  const [restMissed, setRestMissed] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEventDate(today);
    setSession("");
    setCategory("hours");
    setDescription("");
    setImmediate(false);
    setHoursExtra("");
    setRestMissed("");
  };

  const submit = async () => {
    if (!user) return;
    if (description.trim().length < 10) {
      toast.error("Please describe what happened (at least 10 characters).");
      return;
    }
    setSaving(true);
    const dueBy = computeDueBy(new Date(), immediate).toISOString();
    const { error } = await supabase.from("exception_reports").insert({
      trainee_id: user.id,
      event_date: eventDate,
      event_session: session ? session : null,
      category,
      description: description.trim(),
      immediate_safety_concern: immediate,
      hours_worked_extra: hoursExtra ? Number(hoursExtra) : null,
      rest_missed_hours: restMissed ? Number(restMissed) : null,
      due_by: dueBy,
    });
    setSaving(false);
    if (error) {
      toast.error(`Could not submit exception: ${error.message}`);
      return;
    }
    toast.success(
      immediate
        ? "Exception submitted — flagged for same-day Guardian response."
        : "Exception submitted. You'll hear back within 7 days.",
    );
    reset();
    onOpenChange(false);
    onSubmitted();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Submit an exception report</DialogTitle>
          <DialogDescription>
            Raise a variance from your work schedule as required by the 2016
            Terms &amp; Conditions of Service. Your educational supervisor
            (or the Guardian of Safe Working for safety concerns) will respond.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="event-date">Date of event</Label>
              <Input
                id="event-date"
                type="date"
                max={today}
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="event-session">Session (optional)</Label>
              <Select value={session} onValueChange={(v) => setSession(v as SessionHalf)}>
                <SelectTrigger id="event-session">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="am">AM (08:00–13:00)</SelectItem>
                  <SelectItem value="pm">PM (13:00–18:00)</SelectItem>
                  <SelectItem value="eve">Evening (18:00–21:00)</SelectItem>
                  <SelectItem value="night">Night (21:00–08:00 +1)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="category">Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as ExceptionCategory)}>
              <SelectTrigger id="category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CATEGORY_LABEL) as ExceptionCategory[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {CATEGORY_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{CATEGORY_DESCRIPTION[category]}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="hours-extra">Extra hours worked (optional)</Label>
              <Input
                id="hours-extra"
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={hoursExtra}
                onChange={(e) => setHoursExtra(e.target.value)}
                placeholder="e.g. 2"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-missed">Rest missed, hours (optional)</Label>
              <Input
                id="rest-missed"
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={restMissed}
                onChange={(e) => setRestMissed(e.target.value)}
                placeholder="e.g. 1.5"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="description">What happened?</Label>
            <Textarea
              id="description"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the event, context, and any impact on patient care or your training."
            />
            <p className="text-xs text-muted-foreground">
              {description.length}/5000 characters
            </p>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <Checkbox
              checked={immediate}
              onCheckedChange={(v) => setImmediate(v === true)}
              className="mt-0.5"
            />
            <div className="grid gap-1">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                Immediate patient-safety concern
              </div>
              <p className="text-xs text-muted-foreground">
                Tick if a patient was harmed or could have been. This escalates
                the report to the Guardian of Safe Working with a same-working-day
                response requirement.
              </p>
            </div>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Submitting…" : "Submit exception"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
