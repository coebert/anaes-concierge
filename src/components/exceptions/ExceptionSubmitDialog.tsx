import { useEffect, useMemo, useState } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWellbeing } from "@/features/wellbeing/invalidate";
import { toast } from "sonner";
import {
  CATEGORY_LABEL,
  CATEGORY_DESCRIPTION,
  computeDueBy,
  type ExceptionCategory,
  type SessionHalf,
} from "@/features/exceptions/types";
import { AlertTriangle, CalendarClock } from "lucide-react";

// TCS 2016 session windows — mirrors src/lib/tcs-2016-audit.ts.
const SESSION_WINDOW: Record<
  SessionHalf,
  { label: string; startH: number; endH: number; crossesMidnight: boolean; hours: number }
> = {
  am: { label: "AM", startH: 8, endH: 13, crossesMidnight: false, hours: 5 },
  pm: { label: "PM", startH: 13, endH: 18, crossesMidnight: false, hours: 5 },
  eve: { label: "Evening", startH: 18, endH: 21, crossesMidnight: false, hours: 3 },
  night: { label: "Night", startH: 21, endH: 8, crossesMidnight: true, hours: 11 },
};

const REST_MIN_HOURS = 11; // TCS 2016 min rest between rostered shifts.

function fmtHour(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  return `${String(Math.floor(hh)).padStart(2, "0")}:00`;
}

function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h + mi / 60;
}

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
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [eventDate, setEventDate] = useState(today);
  const [session, setSession] = useState<SessionHalf | "">("");
  const [category, setCategory] = useState<ExceptionCategory>("hours");
  const [description, setDescription] = useState("");
  const [immediate, setImmediate] = useState(false);
  const [hoursExtra, setHoursExtra] = useState("");
  const [restMissed, setRestMissed] = useState("");
  const [actualEnd, setActualEnd] = useState("");
  const [actualRest, setActualRest] = useState("");
  const [saving, setSaving] = useState(false);
  const [rota, setRota] = useState<Array<{ session: SessionHalf; duty_type: string | null }>>([]);
  const [nextRota, setNextRota] = useState<SessionHalf | null>(null);
  const [autoTouched, setAutoTouched] = useState({ hours: false, rest: false });

  const reset = () => {
    setEventDate(today);
    setSession("");
    setCategory("hours");
    setDescription("");
    setImmediate(false);
    setHoursExtra("");
    setRestMissed("");
    setActualEnd("");
    setActualRest("");
    setRota([]);
    setNextRota(null);
    setAutoTouched({ hours: false, rest: false });
  };

  // Fetch trainee's rostered sessions for the event day and the next day.
  useEffect(() => {
    if (!open || !user || !eventDate) return;
    let cancelled = false;
    const nextDate = (() => {
      const d = new Date(eventDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    void supabase
      .from("rota_assignments")
      .select("session,session_date,duty_type")
      .eq("staff_id", user.id)
      .in("session_date", [eventDate, nextDate])
      .then(({ data }) => {
        if (cancelled) return;
        const rows = (data ?? []) as Array<{
          session: SessionHalf;
          session_date: string;
          duty_type: string | null;
        }>;
        const same = rows
          .filter((r) => r.session_date === eventDate)
          .sort((a, b) => SESSION_WINDOW[a.session].startH - SESSION_WINDOW[b.session].startH);
        setRota(same);
        const nxt = rows
          .filter((r) => r.session_date === nextDate)
          .sort((a, b) => SESSION_WINDOW[a.session].startH - SESSION_WINDOW[b.session].startH);
        setNextRota(nxt.length ? nxt[0].session : null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user, eventDate]);

  const plannedSummary = useMemo(() => {
    if (rota.length === 0) return null;
    const totalH = rota.reduce((s, r) => s + SESSION_WINDOW[r.session].hours, 0);
    const first = rota[0];
    const last = rota[rota.length - 1];
    const startH = SESSION_WINDOW[first.session].startH;
    const endW = SESSION_WINDOW[last.session];
    const endLabel = endW.crossesMidnight ? `${fmtHour(endW.endH)} (+1)` : fmtHour(endW.endH);
    return {
      totalH,
      startLabel: fmtHour(startH),
      endLabel,
      list: rota.map((r) => SESSION_WINDOW[r.session].label).join(" + "),
    };
  }, [rota]);

  // The session whose end-time drives "ran until X" — either the one the user
  // picked, or the last rostered session of the day.
  const anchorSession: SessionHalf | null = useMemo(() => {
    if (session) return session;
    if (rota.length > 0) return rota[rota.length - 1].session;
    return null;
  }, [session, rota]);

  // Auto-fill hours_worked_extra when the user enters an actual finish time.
  useEffect(() => {
    if (!anchorSession) return;
    const actual = parseHHMM(actualEnd);
    if (actual === null) return;
    const w = SESSION_WINDOW[anchorSession];
    const plannedEnd = w.crossesMidnight ? w.endH + 24 : w.endH;
    // Users entering e.g. "20:30" after a night shift mean 20:30 the next day.
    const actualNorm = w.crossesMidnight && actual < w.startH ? actual + 24 : actual;
    const diff = Math.max(0, actualNorm - plannedEnd);
    if (diff > 0) {
      setHoursExtra(diff.toFixed(2).replace(/\.?0+$/, ""));
      setAutoTouched((s) => ({ ...s, hours: true }));
    }
  }, [actualEnd, anchorSession]);

  // Auto-fill rest_missed_hours from actual rest given between shifts.
  const restContext = useMemo(() => {
    if (!anchorSession || !nextRota) return null;
    const endW = SESSION_WINDOW[anchorSession];
    // End hour on absolute clock (0-47) relative to event date midnight.
    const endAbs = endW.crossesMidnight ? endW.endH + 24 : endW.endH;
    const nextStartAbs = 24 + SESSION_WINDOW[nextRota].startH;
    const plannedRest = nextStartAbs - endAbs;
    return { plannedRest, nextStart: fmtHour(SESSION_WINDOW[nextRota].startH) };
  }, [anchorSession, nextRota]);

  useEffect(() => {
    if (!restContext) return;
    const actual = parseHHMM(actualRest);
    if (actual === null) return;
    const missed = Math.max(0, REST_MIN_HOURS - actual);
    if (missed > 0) {
      setRestMissed(missed.toFixed(2).replace(/\.?0+$/, ""));
      setAutoTouched((s) => ({ ...s, rest: true }));
    }
  }, [actualRest, restContext]);

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
    invalidateWellbeing(qc, immediate ? "exception.submit:immediate" : "exception.submit");
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

          {plannedSummary ? (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div>
                <div>
                  <span className="font-medium">Rostered that day:</span>{" "}
                  {plannedSummary.list} · {plannedSummary.startLabel}–
                  {plannedSummary.endLabel} ({plannedSummary.totalH}h planned)
                </div>
                {restContext ? (
                  <div className="text-muted-foreground">
                    Next rostered start: {restContext.nextStart} the following day —
                    planned rest {restContext.plannedRest.toFixed(1)}h (TCS minimum {REST_MIN_HOURS}h).
                  </div>
                ) : null}
              </div>
            </div>
          ) : eventDate ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              No rostered sessions found for you on this date — you can still fill the hours below manually.
            </div>
          ) : null}

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
              <Label htmlFor="actual-end">Shift actually ended at (optional)</Label>
              <Input
                id="actual-end"
                type="time"
                value={actualEnd}
                onChange={(e) => setActualEnd(e.target.value)}
                disabled={!anchorSession}
              />
              <p className="text-xs text-muted-foreground">
                {anchorSession
                  ? `Planned end: ${
                      SESSION_WINDOW[anchorSession].crossesMidnight
                        ? `${fmtHour(SESSION_WINDOW[anchorSession].endH)} (+1)`
                        : fmtHour(SESSION_WINDOW[anchorSession].endH)
                    }. We'll calculate extra hours automatically.`
                  : "Pick a session or a date with a rota to enable auto-fill."}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="hours-extra">Extra hours worked</Label>
              <Input
                id="hours-extra"
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={hoursExtra}
                onChange={(e) => {
                  setHoursExtra(e.target.value);
                  setAutoTouched((s) => ({ ...s, hours: false }));
                }}
                placeholder="e.g. 2"
              />
              {autoTouched.hours ? (
                <p className="text-xs text-primary">Auto-filled from actual end time — edit if needed.</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="actual-rest">Rest actually taken, hours (optional)</Label>
              <Input
                id="actual-rest"
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={actualRest}
                onChange={(e) => setActualRest(e.target.value)}
                disabled={!restContext}
                placeholder={restContext ? "e.g. 8" : ""}
              />
              <p className="text-xs text-muted-foreground">
                {restContext
                  ? `Minimum rest required is ${REST_MIN_HOURS}h; shortfall auto-computed.`
                  : "No consecutive rostered shift found — enter shortfall directly."}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rest-missed">Rest missed, hours</Label>
              <Input
                id="rest-missed"
                type="number"
                min="0"
                max="24"
                step="0.25"
                value={restMissed}
                onChange={(e) => {
                  setRestMissed(e.target.value);
                  setAutoTouched((s) => ({ ...s, rest: false }));
                }}
                placeholder="e.g. 1.5"
              />
              {autoTouched.rest ? (
                <p className="text-xs text-primary">Auto-filled from rest taken — edit if needed.</p>
              ) : null}
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
