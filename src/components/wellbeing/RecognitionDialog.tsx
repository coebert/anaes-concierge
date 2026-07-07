import { useEffect, useState } from "react";
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

export const RECOGNITION_CATEGORIES = [
  { value: "teaching", label: "Great teaching" },
  { value: "kindness", label: "Kindness" },
  { value: "clinical", label: "Clinical excellence" },
  { value: "above_beyond", label: "Above & beyond" },
  { value: "covering_gap", label: "Covered a gap" },
  { value: "other", label: "Other" },
] as const;

interface StaffOption {
  id: string;
  name: string;
}

export function RecognitionDialog({
  open,
  onOpenChange,
  onSaved,
  presetRecipientId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  presetRecipientId?: string;
}) {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [recipient, setRecipient] = useState<string>(presetRecipientId ?? "");
  const [category, setCategory] = useState<string>("kindness");
  const [message, setMessage] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,email")
        .eq("active", true)
        .order("full_name");
      if (error) {
        toast.error(error.message);
        return;
      }
      setStaff(
        (data ?? [])
          .filter((p) => p.id !== user?.id)
          .map((p) => ({ id: p.id, name: p.full_name || p.email || "Unknown" })),
      );
    })();
  }, [open, user?.id]);

  useEffect(() => {
    if (presetRecipientId) setRecipient(presetRecipientId);
  }, [presetRecipientId]);

  const save = async () => {
    if (!user || !recipient) {
      toast.error("Pick a recipient");
      return;
    }
    if (!message.trim()) {
      toast.error("Write a short message");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("recognition_entries").insert({
      staff_id: recipient,
      from_user_id: user.id,
      category,
      message,
      is_public: isPublic,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Recognition sent");
    setMessage("");
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a kudos</DialogTitle>
          <DialogDescription>
            Recognise a colleague. Public kudos appear on the recognition feed;
            private kudos are visible only to the recipient and admins.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Recipient</Label>
            <Select value={recipient} onValueChange={setRecipient}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a colleague…" />
              </SelectTrigger>
              <SelectContent>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECOGNITION_CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="rec-message">Message</Label>
            <Textarea
              id="rec-message"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What made a difference?"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={isPublic}
              onCheckedChange={(v) => setIsPublic(!!v)}
            />
            Share on the public recognition feed
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Sending…" : "Send kudos"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
