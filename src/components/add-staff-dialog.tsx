import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { composeName } from "@/lib/utils";
import { toast } from "sonner";
import { createStaffMember } from "@/features/staff/admin-staff.functions";

type Grade = "consultant" | "sas" | "trainee" | "";
type AppRole = "staff" | "rota_coordinator" | "admin";
const TRAINING_LEVELS = ["CT1","CT2","CT3","ACCS1","ACCS2","ACCS3","ST4","ST5","ST6","ST7","ST8","ST8+"] as const;

export function AddStaffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const createFn = useServerFn(createStaffMember);

  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [grade, setGrade] = useState<Grade>("");
  const [trainingLevel, setTrainingLevel] = useState<string>("");
  const [role, setRole] = useState<AppRole>("staff");
  const [sendInvite, setSendInvite] = useState(true);
  const [password, setPassword] = useState("");

  const reset = () => {
    setEmail(""); setTitle(""); setFirstName(""); setSurname("");
    setGrade(""); setTrainingLevel("");
    setRole("staff"); setSendInvite(true); setPassword("");
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await createFn({
        data: {
          email: email.trim(),
          full_name: composeName({ title, firstName, surname }),
          grade: grade || null,
          training_level: grade === "trainee" && trainingLevel ? (trainingLevel as typeof TRAINING_LEVELS[number]) : null,
          role,
          send_invite: sendInvite,
          password: sendInvite ? undefined : password,
        },
      });
      if ("error" in res && res.error) throw new Error(res.error);
      return res;
    },
    onSuccess: () => {
      toast.success(sendInvite ? "Invitation sent" : "Staff member created");
      qc.invalidateQueries({ queryKey: ["profiles"] });
      reset();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSubmit =
    email.trim().length > 0 &&
    surname.trim().length > 0 &&
    (sendInvite || password.length >= 8);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add staff member</DialogTitle>
          <DialogDescription>
            Create a new user account. They will receive an email to set their password
            unless you set one manually.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="add-staff-email">Email</Label>
            <Input
              id="add-staff-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@nhs.net"
              maxLength={255}
            />
          </div>

          <div className="grid grid-cols-[6rem_1fr_1fr] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="add-staff-title">Title</Label>
              <Input
                id="add-staff-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Dr"
                maxLength={20}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-staff-surname">Surname</Label>
              <Input
                id="add-staff-surname"
                value={surname}
                onChange={(e) => setSurname(e.target.value)}
                placeholder="Smith"
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-staff-first">First name</Label>
              <Input
                id="add-staff-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Jane"
                maxLength={100}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Grade</Label>
              <Select value={grade || "none"} onValueChange={(v) => setGrade(v === "none" ? "" : (v as Grade))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  <SelectItem value="consultant">Consultant</SelectItem>
                  <SelectItem value="sas">SAS Doctor</SelectItem>
                  <SelectItem value="trainee">Trainee</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {grade === "trainee" && (
              <div className="space-y-1.5">
                <Label>Training level</Label>
                <Select value={trainingLevel} onValueChange={setTrainingLevel}>
                  <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                  <SelectContent>
                    {TRAINING_LEVELS.map((l) => (
                      <SelectItem key={l} value={l}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>App role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="staff">Staff</SelectItem>
                <SelectItem value="rota_coordinator">Rota coordinator</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label className="text-sm">Send invite email</Label>
              <p className="text-xs text-muted-foreground">
                User receives a link to set their own password.
              </p>
            </div>
            <Switch checked={sendInvite} onCheckedChange={setSendInvite} />
          </div>

          {!sendInvite && (
            <div className="space-y-1.5">
              <Label htmlFor="add-staff-password">Initial password</Label>
              <Input
                id="add-staff-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                minLength={8}
                maxLength={72}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? "Saving…" : sendInvite ? "Send invite" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
