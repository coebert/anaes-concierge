import { useEffect, useState } from "react";
import { todayISO, splitName, composeName } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";
import type { AppRole } from "@/lib/auth-context";

type Grade = "consultant" | "sas" | "trainee";
type SessionHalf = "am" | "pm";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  staffId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StaffEditDialog({ staffId, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit staff member</DialogTitle>
          <DialogDescription>
            Profile, roles, job plan and fixed weekly sessions.
          </DialogDescription>
        </DialogHeader>
        {staffId && (
          <Tabs defaultValue="profile" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="roles">Roles</TabsTrigger>
              <TabsTrigger value="jobplan">Job plan</TabsTrigger>
              <TabsTrigger value="fixed">Fixed sessions</TabsTrigger>
            </TabsList>
            <TabsContent value="profile" className="pt-4">
              <ProfileTab staffId={staffId} />
            </TabsContent>
            <TabsContent value="roles" className="pt-4">
              <RolesTab staffId={staffId} />
            </TabsContent>
            <TabsContent value="jobplan" className="pt-4">
              <JobPlanTab staffId={staffId} />
            </TabsContent>
            <TabsContent value="fixed" className="pt-4">
              <FixedSessionsTab staffId={staffId} />
            </TabsContent>
          </Tabs>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- Profile tab ----------------------------- */

function ProfileTab({ staffId }: { staffId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["profile-edit", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", staffId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const [form, setForm] = useState({
    title: "",
    first_name: "",
    surname: "",
    grade: "" as Grade | "",
    training_level: "",
    gmc_number: "",
    start_date: "",
    rotation_end_date: "",
    active: true,
    ltft_days_off: [] as number[],
  });

  useEffect(() => {
    if (data) {
      const parts = splitName(data.full_name);
      setForm({
        title: parts.title,
        first_name: parts.firstName,
        surname: parts.surname,
        grade: (data.grade as Grade) ?? "",
        training_level: data.training_level ?? "",
        gmc_number: data.gmc_number ?? "",
        start_date: data.start_date ?? "",
        rotation_end_date: data.rotation_end_date ?? "",
        active: data.active,
        ltft_days_off: Array.isArray((data as { ltft_days_off?: number[] }).ltft_days_off)
          ? ((data as { ltft_days_off?: number[] }).ltft_days_off ?? [])
          : [],
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("profiles")
        .update({
          full_name: composeName({
            title: form.title,
            firstName: form.first_name,
            surname: form.surname,
          }),
          grade: form.grade || null,
          training_level: form.training_level || null,
          gmc_number: form.gmc_number || null,
          start_date: form.start_date || null,
          rotation_end_date: form.grade === "trainee" ? form.rotation_end_date || null : null,
          active: form.active,
          ltft_days_off: [...form.ltft_days_off].sort((a, b) => a - b),
        })
        .eq("id", staffId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Profile saved");
      qc.invalidateQueries({ queryKey: ["profiles"] });
      qc.invalidateQueries({ queryKey: ["profile-edit", staffId] });
      qc.invalidateQueries({ queryKey: ["staff-active"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[6rem_1fr_1fr]">
        <Field label="Title">
          <Input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Dr"
            maxLength={20}
          />
        </Field>
        <Field label="Surname">
          <Input
            value={form.surname}
            onChange={(e) => setForm({ ...form, surname: e.target.value })}
            maxLength={100}
          />
        </Field>
        <Field label="First name">
          <Input
            value={form.first_name}
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
            maxLength={100}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Grade">
          <Select
            value={form.grade}
            onValueChange={(v) => setForm({ ...form, grade: v as Grade })}
          >
            <SelectTrigger><SelectValue placeholder="Select grade" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="consultant">Consultant</SelectItem>
              <SelectItem value="sas">SAS</SelectItem>
              <SelectItem value="trainee">Trainee</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Training level (e.g. ST4)">
          <Input
            value={form.training_level}
            onChange={(e) => setForm({ ...form, training_level: e.target.value })}
          />
        </Field>
        <Field label="GMC number">
          <Input
            value={form.gmc_number}
            onChange={(e) => setForm({ ...form, gmc_number: e.target.value })}
          />
        </Field>
        <Field label="Start date">
          <Input
            type="date"
            value={form.start_date}
            onChange={(e) => setForm({ ...form, start_date: e.target.value })}
          />
        </Field>
        {form.grade === "trainee" && (
          <Field label="Rotation end date (last day at Salisbury)">
            <Input
              type="date"
              value={form.rotation_end_date}
              onChange={(e) => setForm({ ...form, rotation_end_date: e.target.value })}
            />
          </Field>
        )}
        <Field label="Active">
          <div className="flex h-10 items-center">
            <Switch
              checked={form.active}
              onCheckedChange={(v) => setForm({ ...form, active: v })}
            />
          </div>
        </Field>
      </div>
      <Field label="LTFT fixed days off">
        <div className="flex flex-wrap gap-3 pt-1">
          {DAYS.map((d, i) => {
            const checked = form.ltft_days_off.includes(i);
            return (
              <label key={d} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => {
                    const on = v === true;
                    setForm({
                      ...form,
                      ltft_days_off: on
                        ? [...form.ltft_days_off, i]
                        : form.ltft_days_off.filter((x) => x !== i),
                    });
                  }}
                />
                {d}
              </label>
            );
          })}
        </div>
        <p className="pt-1 text-xs text-muted-foreground">
          Weekdays this person is contractually off. They will not be assignable to activity on these days.
        </p>
      </Field>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save profile"}
      </Button>
    </div>
  );
}

/* ------------------------------ Roles tab ------------------------------ */

function RolesTab({ staffId }: { staffId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["user-roles", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", staffId);
      if (error) throw error;
      return (data ?? []).map((r) => r.role as AppRole);
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ role, on }: { role: AppRole; on: boolean }) => {
      if (on) {
        const { error } = await supabase
          .from("user_roles")
          .insert({ user_id: staffId, role });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("user_roles")
          .delete()
          .eq("user_id", staffId)
          .eq("role", role);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Roles updated");
      qc.invalidateQueries({ queryKey: ["user-roles", staffId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const all: { role: AppRole; label: string; desc: string }[] = [
    { role: "admin", label: "Admin", desc: "Full system access incl. user management." },
    { role: "rota_coordinator", label: "Rota coordinator", desc: "Manage rota, approve leave." },
    { role: "staff", label: "Staff", desc: "Default — see own rota & request leave." },
  ];

  return (
    <div className="space-y-3">
      {all.map((r) => {
        const has = data?.includes(r.role) ?? false;
        return (
          <label
            key={r.role}
            className="flex items-start gap-3 rounded-md border p-3 cursor-pointer"
          >
            <Checkbox
              checked={has}
              onCheckedChange={(v) => toggle.mutate({ role: r.role, on: !!v })}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-sm">{r.label}</div>
              <div className="text-xs text-muted-foreground">{r.desc}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

/* ----------------------------- Job plan tab ----------------------------- */

function JobPlanTab({ staffId }: { staffId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["job-plan", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_plans")
        .select("*")
        .eq("staff_id", staffId)
        .order("valid_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [form, setForm] = useState({
    total_pas: 10,
    dcc_pas: 7.5,
    spa_pas: 2.5,
    ltft: false,
    ltft_percentage: "",
    on_call_commitment: "",
    notes: "",
    valid_from: todayISO(),
  });

  useEffect(() => {
    if (data) {
      setForm({
        total_pas: Number(data.total_pas),
        dcc_pas: Number(data.dcc_pas),
        spa_pas: Number(data.spa_pas),
        ltft: data.ltft,
        ltft_percentage: data.ltft_percentage?.toString() ?? "",
        on_call_commitment: data.on_call_commitment ?? "",
        notes: data.notes ?? "",
        valid_from: data.valid_from,
      });
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        staff_id: staffId,
        total_pas: form.total_pas,
        dcc_pas: form.dcc_pas,
        spa_pas: form.spa_pas,
        ltft: form.ltft,
        ltft_percentage: form.ltft_percentage ? Number(form.ltft_percentage) : null,
        on_call_commitment: form.on_call_commitment || null,
        notes: form.notes || null,
        valid_from: form.valid_from,
      };
      if (data) {
        const { error } = await supabase.from("job_plans").update(payload).eq("id", data.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("job_plans").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Job plan saved");
      qc.invalidateQueries({ queryKey: ["job-plan", staffId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Total PAs / week">
          <Input
            type="number" step="0.5"
            value={form.total_pas}
            onChange={(e) => setForm({ ...form, total_pas: Number(e.target.value) })}
          />
        </Field>
        <Field label="DCC PAs">
          <Input
            type="number" step="0.5"
            value={form.dcc_pas}
            onChange={(e) => setForm({ ...form, dcc_pas: Number(e.target.value) })}
          />
        </Field>
        <Field label="SPA PAs">
          <Input
            type="number" step="0.5"
            value={form.spa_pas}
            onChange={(e) => setForm({ ...form, spa_pas: Number(e.target.value) })}
          />
        </Field>
        <Field label="LTFT">
          <div className="flex h-10 items-center">
            <Switch
              checked={form.ltft}
              onCheckedChange={(v) => setForm({ ...form, ltft: v })}
            />
          </div>
        </Field>
        <Field label="LTFT %">
          <Input
            type="number"
            value={form.ltft_percentage}
            disabled={!form.ltft}
            onChange={(e) => setForm({ ...form, ltft_percentage: e.target.value })}
          />
        </Field>
        <Field label="Valid from">
          <Input
            type="date"
            value={form.valid_from}
            onChange={(e) => setForm({ ...form, valid_from: e.target.value })}
          />
        </Field>
      </div>
      <Field label="On-call commitment">
        <Input
          value={form.on_call_commitment}
          onChange={(e) => setForm({ ...form, on_call_commitment: e.target.value })}
          placeholder="e.g. 1:8 nights, weekend cover"
        />
      </Field>
      <Field label="Notes">
        <Textarea
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save job plan"}
      </Button>
    </div>
  );
}

/* -------------------------- Fixed sessions tab -------------------------- */

function FixedSessionsTab({ staffId }: { staffId: string }) {
  const qc = useQueryClient();
  const { data: sessions, isLoading } = useQuery({
    queryKey: ["fixed-sessions", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fixed_sessions")
        .select("id,day_of_week,session,theatre_id,description")
        .eq("staff_id", staffId)
        .order("day_of_week");
      if (error) throw error;
      return data;
    },
  });

  const { data: theatres } = useQuery({
    queryKey: ["theatres"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres")
        .select("id,name")
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const [draft, setDraft] = useState<{
    day_of_week: number; session: SessionHalf; theatre_id: string; description: string;
  }>({ day_of_week: 1, session: "am", theatre_id: "", description: "" });

  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fixed_sessions").insert({
        staff_id: staffId,
        day_of_week: draft.day_of_week,
        session: draft.session,
        theatre_id: draft.theatre_id || null,
        description: draft.description || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Added fixed session");
      setDraft({ ...draft, theatre_id: "", description: "" });
      qc.invalidateQueries({ queryKey: ["fixed-sessions", staffId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("fixed_sessions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["fixed-sessions", staffId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        {sessions?.length ? (
          <ul className="divide-y">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{DAYS[s.day_of_week]} {s.session.toUpperCase()}</Badge>
                  <span>{theatres?.find((t) => t.id === s.theatre_id)?.name ?? "—"}</span>
                  {s.description && (
                    <span className="text-xs text-muted-foreground">· {s.description}</span>
                  )}
                </div>
                <Button size="icon" variant="ghost" onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-3 text-sm text-muted-foreground">No fixed sessions yet.</p>
        )}
      </div>

      <div className="rounded-md border p-3">
        <div className="mb-2 text-sm font-medium">Add fixed session</div>
        <div className="grid gap-2 sm:grid-cols-5">
          <Select
            value={String(draft.day_of_week)}
            onValueChange={(v) => setDraft({ ...draft, day_of_week: Number(v) })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {DAYS.map((d, i) => (
                <SelectItem key={d} value={String(i)}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.session}
            onValueChange={(v) => setDraft({ ...draft, session: v as SessionHalf })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="am">AM</SelectItem>
              <SelectItem value="pm">PM</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={draft.theatre_id}
            onValueChange={(v) => setDraft({ ...draft, theatre_id: v })}
          >
            <SelectTrigger><SelectValue placeholder="Theatre" /></SelectTrigger>
            <SelectContent>
              {theatres?.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Description (optional)"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <Button onClick={() => add.mutate()} disabled={add.isPending}>
            <Plus className="mr-1 h-4 w-4" />Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
