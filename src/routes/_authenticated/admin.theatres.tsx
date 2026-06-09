import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/theatres")({
  component: AdminTheatresPage,
});

type Kind = "main" | "day_surgery" | "private";

function AdminTheatresPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Theatres & specialties</h1>
        <p className="text-sm text-muted-foreground">
          Configure the operating rooms and surgical specialties used across the rota.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TheatresCard />
        <SpecialtiesCard />
      </div>
    </div>
  );
}

function TheatresCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["theatres-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres")
        .select("id,name,kind,active,sort_order")
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Kind>("main");

  const add = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) throw new Error("Name required");
      const maxSort = Math.max(0, ...(data ?? []).map((t) => t.sort_order));
      const { error } = await supabase.from("theatres").insert({
        name: newName.trim(), kind: newKind, sort_order: maxSort + 1,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Theatre added"); setNewName("");
      qc.invalidateQueries({ queryKey: ["theatres-admin"] });
      qc.invalidateQueries({ queryKey: ["theatres"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (t: { id: string; active?: boolean; name?: string; kind?: Kind }) => {
      const { id, ...rest } = t;
      const { error } = await supabase.from("theatres").update(rest).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["theatres-admin"] });
      qc.invalidateQueries({ queryKey: ["theatres"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Theatres</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data?.map((t) => (
              <li key={t.id} className="flex items-center gap-2 p-2 text-sm">
                <Input
                  defaultValue={t.name}
                  onBlur={(e) => {
                    if (e.target.value !== t.name) {
                      update.mutate({ id: t.id, name: e.target.value });
                    }
                  }}
                  className="h-8 max-w-[10rem]"
                />
                <Select
                  value={t.kind}
                  onValueChange={(v) => update.mutate({ id: t.id, kind: v as Kind })}
                >
                  <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="main">main</SelectItem>
                    <SelectItem value="day_surgery">day surgery</SelectItem>
                    <SelectItem value="private">private (NHH)</SelectItem>
                  </SelectContent>
                </Select>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Active</span>
                  <Switch
                    checked={t.active}
                    onCheckedChange={(v) => update.mutate({ id: t.id, active: v })}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 rounded-md border p-2">
          <Input
            placeholder="New theatre name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="h-8"
          />
          <Select value={newKind} onValueChange={(v) => setNewKind(v as Kind)}>
            <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="main">main</SelectItem>
              <SelectItem value="day_surgery">day surgery</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
            <Plus className="mr-1 h-4 w-4" />Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SpecialtiesCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["specialties"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties")
        .select("id,name,is_trainee_bucket")
        .order("name");
      if (error) throw error;
      return data;
    },
  });
  const [name, setName] = useState("");
  const [bucket, setBucket] = useState(true);

  const add = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name required");
      const { error } = await supabase
        .from("specialties")
        .insert({ name: name.trim(), is_trainee_bucket: bucket });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Specialty added"); setName("");
      qc.invalidateQueries({ queryKey: ["specialties"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (s: { id: string; is_trainee_bucket: boolean }) => {
      const { error } = await supabase
        .from("specialties")
        .update({ is_trainee_bucket: s.is_trainee_bucket })
        .eq("id", s.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["specialties"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("specialties").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["specialties"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Surgical specialties</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.map((s) => (
              <li key={s.id} className="flex items-center gap-2 p-2 text-sm">
                <span className="flex-1 font-medium">{s.name}</span>
                {s.is_trainee_bucket && (
                  <Badge variant="secondary">trainee bucket</Badge>
                )}
                <label className="flex items-center gap-1 text-xs">
                  <Checkbox
                    checked={s.is_trainee_bucket}
                    onCheckedChange={(v) =>
                      update.mutate({ id: s.id, is_trainee_bucket: !!v })
                    }
                  />
                  bucket
                </label>
                <Button size="icon" variant="ghost" onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 rounded-md border p-2">
          <Input
            placeholder="e.g. Cardiac, Paeds, Obstetrics"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
          />
          <label className="flex items-center gap-1 text-xs">
            <Checkbox checked={bucket} onCheckedChange={(v) => setBucket(!!v)} />
            trainee bucket
          </label>
          <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
            <Plus className="mr-1 h-4 w-4" />Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          "Trainee bucket" specialties count toward trainee curriculum targets.
        </p>
      </CardContent>
    </Card>
  );
}
