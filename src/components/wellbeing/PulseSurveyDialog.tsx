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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

export interface PulseCycle {
  id: string;
  question_1: string;
  question_2: string;
  question_3: string;
}

const OPTIONS = [1, 2, 3, 4, 5];

function ScorePicker({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-2">
      {OPTIONS.map((n) => (
        <Button
          key={n}
          type="button"
          size="sm"
          variant={value === n ? "default" : "outline"}
          onClick={() => onChange(n)}
          className="w-10"
        >
          {n}
        </Button>
      ))}
    </div>
  );
}

export function PulseSurveyDialog({
  open,
  onOpenChange,
  onSaved,
  cycle,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  cycle: PulseCycle | null;
}) {
  const { user } = useAuth();
  const [s1, setS1] = useState<number | null>(null);
  const [s2, setS2] = useState<number | null>(null);
  const [s3, setS3] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!cycle || !user) return;
    if (s1 === null || s2 === null || s3 === null) {
      toast.error("Please answer all three questions (1–5).");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("pulse_survey_responses")
      .upsert(
        {
          cycle_id: cycle.id,
          staff_id: user.id,
          score_1: s1,
          score_2: s2,
          score_3: s3,
          comment: comment || null,
        },
        { onConflict: "cycle_id,staff_id" },
      );
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Response saved — thank you.");
    setComment("");
    setS1(null);
    setS2(null);
    setS3(null);
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Wellbeing pulse</DialogTitle>
          <DialogDescription>
            1 = strongly disagree · 5 = strongly agree. Only admins see individual
            responses; coordinators see aggregated scores only.
          </DialogDescription>
        </DialogHeader>

        {cycle ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{cycle.question_1}</Label>
              <ScorePicker value={s1} onChange={setS1} />
            </div>
            <div className="space-y-2">
              <Label>{cycle.question_2}</Label>
              <ScorePicker value={s2} onChange={setS2} />
            </div>
            <div className="space-y-2">
              <Label>{cycle.question_3}</Label>
              <ScorePicker value={s3} onChange={setS3} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pulse-comment">Anything else (optional)</Label>
              <Textarea
                id="pulse-comment"
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Encrypted — only admins can read individual comments."
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No open pulse survey right now.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !cycle}>
            {saving ? "Saving…" : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
