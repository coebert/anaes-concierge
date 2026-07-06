import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/theatre-aliases")({
  head: () => ({ meta: [{ title: "Theatre aliases — Salisbury Anaesthetics Rota" }] }),
  component: TheatreAliasesPage,
});

interface Theatre {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
  kind: string;
}

interface Alias {
  id: string;
  alias: string;
  theatre_id: string;
  active: boolean;
  notes: string | null;
  created_at: string;
}

function TheatreAliasesPage() {
  const qc = useQueryClient();

  const { data: theatres } = useQuery({
    queryKey: ["theatres-for-aliases"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres")
        .select("id, name, active, sort_order, kind")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return data as Theatre[];
    },
  });

  const { data: aliases, isLoading } = useQuery({
    queryKey: ["theatre-name-aliases"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatre_name_aliases")
        .select("*")
        .order("alias", { ascending: true });
      if (error) throw error;
      return data as Alias[];
    },
  });

  const theatreById = useMemo(() => {
    const m = new Map<string, Theatre>();
    for (const t of theatres ?? []) m.set(t.id, t);
    return m;
  }, [theatres]);

  const [draft, setDraft] = useState({
    alias: "",
    theatre_id: "",
    notes: "",
  });

  const add = useMutation({
    mutationFn: async () => {
      const alias = draft.alias.trim();
      if (!alias) throw new Error("Alias is required");
      if (!draft.theatre_id) throw new Error("Pick a target theatre");
      const { error } = await supabase.from("theatre_name_aliases").insert({
        alias,
        theatre_id: draft.theatre_id,
        notes: draft.notes.trim() || null,
        active: true,
      });
      if (error) {
        if (error.code === "23505") {
          throw new Error(`An alias for "${alias}" already exists`);
        }
        throw error;
      }
    },
    onSuccess: () => {
      toast.success("Alias added — will take effect on the next sync");
      setDraft((d) => ({ ...d, alias: "", notes: "" }));
      qc.invalidateQueries({ queryKey: ["theatre-name-aliases"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async (m: Partial<Alias> & { id: string }) => {
      const { id, ...rest } = m;
      const { error } = await supabase.from("theatre_name_aliases").update(rest).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["theatre-name-aliases"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("theatre_name_aliases").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Alias removed");
      qc.invalidateQueries({ queryKey: ["theatre-name-aliases"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activeTheatres = (theatres ?? []).filter((t) => t.active);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Theatre name aliases</h1>
        <p className="text-sm text-muted-foreground">
          Map imported rota theatre labels (e.g. from CLWRota) to the canonical AM/PM
          theatre list they belong to. The exact theatre name is always matched first;
          aliases are only consulted when an imported label does not match any real
          theatre name. Changes take effect on the next sync. See{" "}
          <Link to="/admin/settings" className="underline">
            admin settings
          </Link>{" "}
          for unmatched-theatre diagnostics from recent syncs.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add alias</CardTitle>
          <CardDescription>
            Enter the label exactly as it appears in the imported rota (case and
            surrounding whitespace are ignored), and pick which app theatre it should map
            to.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-7">
          <div className="md:col-span-3">
            <label className="text-xs text-muted-foreground">Imported label</label>
            <Input
              value={draft.alias}
              onChange={(e) => setDraft({ ...draft, alias: e.target.value })}
              placeholder='e.g. "T3 (NHH)" or "Endoscopy Suite"'
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">→ App theatre</label>
            <Select
              value={draft.theatre_id}
              onValueChange={(v) => setDraft({ ...draft, theatre_id: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a theatre…" />
              </SelectTrigger>
              <SelectContent>
                {activeTheatres.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-muted-foreground">Notes (optional)</label>
            <Input
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="Why this alias exists"
            />
          </div>
          <div className="flex items-end md:col-span-7">
            <Button onClick={() => add.mutate()} disabled={add.isPending}>
              <Plus className="mr-1 h-4 w-4" /> Add alias
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Current aliases{" "}
            {aliases ? (
              <span className="text-muted-foreground">· {aliases.length}</span>
            ) : null}
          </CardTitle>
          <CardDescription>
            Toggle <em>Active</em> to disable an alias without deleting it. Real theatre
            names always take precedence over aliases.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Imported label</TableHead>
                    <TableHead>→ App theatre</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="w-20">Active</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(aliases ?? []).map((a) => {
                    const theatre = theatreById.get(a.theatre_id);
                    return (
                      <TableRow key={a.id} className={a.active ? "" : "opacity-50"}>
                        <TableCell className="font-mono text-xs">{a.alias}</TableCell>
                        <TableCell>
                          <Select
                            value={a.theatre_id}
                            onValueChange={(v) =>
                              update.mutate({ id: a.id, theatre_id: v })
                            }
                          >
                            <SelectTrigger className="h-8 w-[220px]">
                              <SelectValue>
                                {theatre ? (
                                  <Badge variant="secondary">{theatre.name}</Badge>
                                ) : (
                                  <span className="text-destructive">
                                    Theatre missing
                                  </span>
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {activeTheatres.map((t) => (
                                <SelectItem key={t.id} value={t.id}>
                                  {t.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {a.notes ?? ""}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={a.active}
                            onCheckedChange={(v) =>
                              update.mutate({ id: a.id, active: v })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (
                                confirm(
                                  `Delete alias "${a.alias}" → ${theatre?.name ?? "?"}?`,
                                )
                              ) {
                                del.mutate(a.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {(aliases ?? []).length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-sm text-muted-foreground"
                      >
                        No aliases yet — only exact theatre-name matches will be made.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
