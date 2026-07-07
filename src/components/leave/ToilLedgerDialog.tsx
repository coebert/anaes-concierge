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

export function ToilLedgerDialog({
  open,
  onOpenChange,
  onSaved,
  staffId,
  staffName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  staffId: string;
  staffName?: string | null;
}) {
  const { user } = useAuth();
  const today = new Date().toISOString().slice(0, 10);

  const [entryDate, setEntryDate] = useState(today);
  const [kind, setKind] = useState<"accrual" | "spend" | "adjustment">("accrual");
  const [hours, setHours] = useState<string>("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const numHours = parseFloat(hours);
    if (!Number.isFinite(numHours) || numHours <= 0) {
      toast.error("Enter a positive number of hours");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("leave_ledger_entries").insert({
      staff_id: staffId,
      entry_date: entryDate,
      kind,
      hours: numHours,
      reason: reason || null,
      created_by: user?.id ?? null,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("TOIL entry recorded");
    setHours("");
    setReason("");
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Time off in lieu — ledger entry</DialogTitle>
          <DialogDescription>
            {staffName ? `Adjust TOIL balance for ${staffName}.` : "Adjust TOIL balance."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="toil-date">Date</Label>
            <Input
              id="toil-date"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="accrual">Accrual (earned)</SelectItem>
                <SelectItem value="spend">Spend (taken)</SelectItem>
                <SelectItem value="adjustment">Adjustment</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="toil-hours">Hours</Label>
            <Input
              id="toil-hours"
              type="number"
              step="0.25"
              min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="e.g. 4"
            />
          </div>
          <div>
            <Label htmlFor="toil-reason">Reason</Label>
            <Textarea
              id="toil-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Covered late list on 2 June"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
