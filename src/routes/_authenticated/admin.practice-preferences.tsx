import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { compareBySurname } from "@/lib/name-sort";
import { Baby, HeartPulse, Smile, Pencil, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  evaluatePreference,
  preferenceMatches,
  isPreferred,
} from "@/features/coordinator-rota/preferences";


export const Route = createFileRoute("/_authenticated/admin/practice-preferences")({
  head: () => ({
    meta: [
      { title: "Practice preferences — Salisbury Anaesthetics Rota" },
      {
        name: "description",
        content:
          "Record each consultant and SAS doctor's preferred specialties and coverage of obstetrics, paediatrics and cleft palate lists.",
      },
    ],
  }),
  component: PracticePreferencesGuard,
});

type PreferenceLevel = "preferred" | "willing" | "none";

interface StaffRow {
  id: string;
  full_name: string;
  grade: string | null;
  active: boolean;
}
interface Specialty {
  id: string;
  name: string;
}
interface PracticePref {
  staff_id: string;
  covers_obstetrics: boolean;
  covers_paediatrics: boolean;
  covers_cleft_palate: boolean;
  notes: string | null;
}
interface SpecialtyPref {
  staff_id: string;
  specialty_id: string;
  preference: PreferenceLevel;
}

function PracticePreferencesGuard() {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  if (!hasRole("admin")) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Only administrators can manage practice preferences.
        </CardContent>
      </Card>
    );
  }
  return <PracticePreferencesPage />;
}

function PracticePreferencesPage() {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<StaffRow | null>(null);

  const { data: staff } = useQuery({
    queryKey: ["prefs-staff-consultant-sas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,full_name,grade,active")
        .in("grade", ["consultant", "sas"])
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as StaffRow[];
    },
  });

  const { data: specialties } = useQuery({
    queryKey: ["specialties-list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialties").select("id,name").order("name");
      if (error) throw error;
      // SDH does not offer vascular or cardiac/cardiothoracic surgery,
      // so those specialties are hidden from the practice preferences list.
      return ((data ?? []) as Specialty[]).filter(
        (s) => !/vascular|cardiac|cardio-?thoracic/i.test(s.name),
      );
    },
  });

  const { data: practicePrefs } = useQuery({
    queryKey: ["staff-practice-prefs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_practice_preferences")
        .select("staff_id,covers_obstetrics,covers_paediatrics,covers_cleft_palate,notes");
      if (error) throw error;
      return (data ?? []) as PracticePref[];
    },
  });

  const { data: specialtyPrefs } = useQuery({
    queryKey: ["staff-specialty-prefs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_specialty_preferences")
        .select("staff_id,specialty_id,preference");
      if (error) throw error;
      return (data ?? []) as SpecialtyPref[];
    },
  });

  const practiceById = useMemo(() => {
    const m = new Map<string, PracticePref>();
    for (const p of practicePrefs ?? []) m.set(p.staff_id, p);
    return m;
  }, [practicePrefs]);

  const specialtyByStaff = useMemo(() => {
    const m = new Map<string, SpecialtyPref[]>();
    for (const p of specialtyPrefs ?? []) {
      const arr = m.get(p.staff_id) ?? [];
      arr.push(p);
      m.set(p.staff_id, arr);
    }
    return m;
  }, [specialtyPrefs]);

  const filteredStaff = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (staff ?? []).slice().sort((a, b) =>
      compareBySurname(a.full_name, b.full_name));
    if (!q) return rows;
    return rows.filter((s) => s.full_name.toLowerCase().includes(q));
  }, [staff, query]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Practice preferences"
        description="Record specialty preferences and coverage of obstetrics, paediatrics and cleft palate lists for consultant and SAS grade doctors."
      />

      <Card>
        <CardContent className="p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Assignment priority legend
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-sm font-bold text-amber-600 dark:text-amber-400"
              >
                ★
              </span>
              <div>
                <div className="font-medium text-foreground">Preferred</div>
                <div className="text-muted-foreground">
                  Enjoys or requests these lists. Sorted to the top of the staff picker.
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-sm font-bold text-emerald-600 dark:text-emerald-400"
              >
                ✓
              </span>
              <div>
                <div className="font-medium text-foreground">Willing</div>
                <div className="text-muted-foreground">
                  Happy to cover as part of normal practice. Default level.
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-sm font-bold text-amber-600 dark:text-amber-400"
              >
                ~
              </span>
              <div>
                <div className="font-medium text-foreground">Prefer not to</div>
                <div className="text-muted-foreground">
                  Soft — still assignable if needed, but sorted below Willing and flagged in amber.
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
              <span
                aria-hidden
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-destructive/20 text-sm font-bold text-destructive"
              >
                !
              </span>
              <div>
                <div className="font-medium text-foreground">Does not cover</div>
                <div className="text-muted-foreground">
                  Hard exclusion — will not be offered in the picker for this specialty.
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 max-w-sm"
        />
        <span className="text-xs text-muted-foreground">
          {filteredStaff.length} of {staff?.length ?? 0}
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Preferred specialties</TableHead>
                <TableHead className="w-16 text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredStaff.map((s) => {
                const pp = practiceById.get(s.id);
                const sp = specialtyByStaff.get(s.id) ?? [];
                const preferred = sp
                  .filter((x) => x.preference === "preferred")
                  .map((x) => specialties?.find((sp2) => sp2.id === x.specialty_id)?.name)
                  .filter(Boolean) as string[];
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.full_name}</TableCell>
                    <TableCell className="capitalize text-xs text-muted-foreground">
                      {s.grade ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {pp?.covers_obstetrics && (
                          <Badge variant="secondary" className="gap-1">
                            <HeartPulse className="h-3 w-3" /> Obstetrics
                          </Badge>
                        )}
                        {pp?.covers_paediatrics && (
                          <Badge variant="secondary" className="gap-1">
                            <Baby className="h-3 w-3" /> Paediatrics
                          </Badge>
                        )}
                        {pp?.covers_cleft_palate && (
                          <Badge variant="secondary" className="gap-1">
                            <Smile className="h-3 w-3" /> Cleft palate
                          </Badge>
                        )}
                        {!pp?.covers_obstetrics && !pp?.covers_paediatrics && !pp?.covers_cleft_palate && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {preferred.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {preferred.map((name) => (
                            <Badge key={name} variant="outline">{name}</Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => setEditing(s)}
                        aria-label={`Edit preferences for ${s.full_name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredStaff.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">
                    No consultants or SAS doctors match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && (
        <EditPreferencesDialog
          staff={editing}
          specialties={specialties ?? []}
          practicePref={practiceById.get(editing.id)}
          specialtyPrefs={specialtyByStaff.get(editing.id) ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function EditPreferencesDialog({
  staff, specialties, practicePref, specialtyPrefs, onClose,
}: {
  staff: StaffRow;
  specialties: Specialty[];
  practicePref: PracticePref | undefined;
  specialtyPrefs: SpecialtyPref[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [obstetrics, setObstetrics] = useState(!!practicePref?.covers_obstetrics);
  const [paediatrics, setPaediatrics] = useState(!!practicePref?.covers_paediatrics);
  const [cleft, setCleft] = useState(!!practicePref?.covers_cleft_palate);
  const [notes, setNotes] = useState(practicePref?.notes ?? "");

  const [prefs, setPrefs] = useState<Record<string, PreferenceLevel>>(() => {
    const m: Record<string, PreferenceLevel> = {};
    for (const s of specialties) m[s.id] = "willing";
    for (const p of specialtyPrefs) m[p.specialty_id] = p.preference;
    return m;
  });

  const save = useMutation({
    mutationFn: async () => {
      const { error: e1 } = await supabase
        .from("staff_practice_preferences")
        .upsert({
          staff_id: staff.id,
          covers_obstetrics: obstetrics,
          covers_paediatrics: paediatrics,
          covers_cleft_palate: cleft,
          notes: notes.trim() ? notes.trim() : null,
        });
      if (e1) throw e1;

      const rows = specialties.map((s) => ({
        staff_id: staff.id,
        specialty_id: s.id,
        preference: prefs[s.id] ?? "willing",
      }));
      const { error: e2 } = await supabase
        .from("staff_specialty_preferences")
        .upsert(rows, { onConflict: "staff_id,specialty_id" });
      if (e2) throw e2;
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["staff-practice-prefs"] }),
        qc.invalidateQueries({ queryKey: ["staff-specialty-prefs"] }),
      ]);
      toast.success("Preferences saved");
      onClose();
    },
    onError: (err: unknown) => {
      toast.error("Could not save preferences", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staff.full_name}</DialogTitle>
          <DialogDescription>
            Specialty preferences and coverage flags. Advisory only — does not block rota assignments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Coverage</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="flex items-center gap-2 rounded border border-border p-2 cursor-pointer">
                <Checkbox
                  checked={obstetrics}
                  onCheckedChange={(v) => setObstetrics(!!v)}
                />
                <span className="text-sm">Covers obstetrics</span>
              </label>
              <label className="flex items-center gap-2 rounded border border-border p-2 cursor-pointer">
                <Checkbox
                  checked={paediatrics}
                  onCheckedChange={(v) => setPaediatrics(!!v)}
                />
                <span className="text-sm">Covers paediatrics</span>
              </label>
              <label className="flex items-center gap-2 rounded border border-border p-2 cursor-pointer">
                <Checkbox
                  checked={cleft}
                  onCheckedChange={(v) => setCleft(!!v)}
                />
                <span className="text-sm">Does cleft palate lists</span>
              </label>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Specialty preferences</h3>
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                Assignable — the coordinator can pick this doctor
              </p>
              <ul className="mb-2 space-y-0.5 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">★ Preferred</span> — actively enjoys or requests these lists. Sorted to the top of the staff picker.
                </li>
                <li>
                  <span className="font-medium text-foreground">✓ Willing</span> — happy to cover as part of normal practice.
                </li>
                <li>
                  <span className="font-medium text-foreground">~ Prefer not to</span> — would rather not, but <span className="italic">is able to cover if needed</span>. Soft preference: still eligible, just sorted below "Willing" and flagged with an amber note in the picker so the coordinator knows to try other options first.
                </li>
              </ul>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-destructive">
                Not assignable — hard exclusion
              </p>
              <ul className="space-y-0.5 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">! Does not cover</span> — should not be assigned to this specialty at all (e.g. lack of experience or a formal decision not to practise).
                </li>
              </ul>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {specialties.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 rounded border border-border p-2">
                  <span className="text-sm">{s.name}</span>
                  <Select
                    value={prefs[s.id] ?? "willing"}
                    onValueChange={(v: PreferenceLevel) =>
                      setPrefs((prev) => ({ ...prev, [s.id]: v }))}
                  >
                    <SelectTrigger className="h-8 w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="preferred">
                        <span className="flex flex-col">
                          <span>★ Preferred</span>
                          <span className="text-[10px] text-muted-foreground">Enjoys / requests</span>
                        </span>
                      </SelectItem>
                      <SelectItem value="willing">
                        <span className="flex flex-col">
                          <span>✓ Willing</span>
                          <span className="text-[10px] text-muted-foreground">Happy to cover</span>
                        </span>
                      </SelectItem>
                      <SelectItem value="prefer_not_to">
                        <span className="flex flex-col">
                          <span>~ Prefer not to</span>
                          <span className="text-[10px] text-muted-foreground">Soft — still assignable if needed</span>
                        </span>
                      </SelectItem>
                      <SelectItem value="none">
                        <span className="flex flex-col">
                          <span>! Does not cover</span>
                          <span className="text-[10px] text-muted-foreground">Hard exclusion — do not assign</span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
              {specialties.length === 0 && (
                <p className="text-sm text-muted-foreground">No specialties configured.</p>
              )}
            </div>
          </section>

          <PreviewSection
            grade={staff.grade}
            specialties={specialties}
            prefs={prefs}
            obstetrics={obstetrics}
            paediatrics={paediatrics}
            cleft={cleft}
          />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Notes</h3>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional context, e.g. only covers day-case paediatrics."
              rows={3}
            />
          </section>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save preferences"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewSection({
  grade,
  specialties,
  prefs,
  obstetrics,
  paediatrics,
  cleft,
}: {
  grade: string | null;
  specialties: Specialty[];
  prefs: Record<string, PreferenceLevel>;
  obstetrics: boolean;
  paediatrics: boolean;
  cleft: boolean;
}) {
  // Default the preview to the first specialty whose name triggers a
  // coverage requirement, so the admin immediately sees how obs/paeds/cleft
  // flags interact. Falls back to the first specialty.
  const defaultId = useMemo(() => {
    const trigger = specialties.find((s) =>
      /\bobstet|\bpaed|\bpediat|\bcleft/i.test(s.name),
    );
    return (trigger ?? specialties[0])?.id ?? "";
  }, [specialties]);
  const [previewId, setPreviewId] = useState<string>(defaultId);
  const effectiveId = previewId || defaultId;
  const previewSpec = specialties.find((s) => s.id === effectiveId);

  const draftInput = useMemo(
    () => ({
      staffId: "preview",
      grade,
      specialtyId: previewSpec?.id ?? null,
      specialtyName: previewSpec?.name ?? null,
      practicePref: {
        staff_id: "preview",
        covers_obstetrics: obstetrics,
        covers_paediatrics: paediatrics,
        covers_cleft_palate: cleft,
      },
      specialtyPref: previewSpec
        ? {
            staff_id: "preview",
            specialty_id: previewSpec.id,
            preference: prefs[previewSpec.id] ?? "willing",
          }
        : undefined,
    }),
    [grade, previewSpec, obstetrics, paediatrics, cleft, prefs],
  );

  const issues = evaluatePreference(draftInput);
  const matches = preferenceMatches(draftInput);
  const preferred = isPreferred(draftInput);

  const applicable = grade === "consultant" || grade === "sas";

  return (
    <section className="space-y-2 rounded-md border border-dashed border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Live preview</h3>
        <Select value={effectiveId} onValueChange={setPreviewId}>
          <SelectTrigger className="h-8 w-56">
            <SelectValue placeholder="Choose a list…" />
          </SelectTrigger>
          <SelectContent>
            {specialties.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!applicable ? (
        <p className="text-xs text-muted-foreground">
          Preferences only affect warnings for consultants and SAS grade doctors.
        </p>
      ) : !previewSpec ? (
        <p className="text-xs text-muted-foreground">
          Add a specialty above to preview warnings.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {preferred && (
              <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/40 gap-1">
                ★ Preferred
              </Badge>
            )}
            {matches ? (
              <Badge variant="outline" className="gap-1 text-emerald-700 dark:text-emerald-400 border-emerald-500/40">
                <CheckCircle2 className="h-3 w-3" /> Matches list requirements
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-amber-700 dark:text-amber-400 border-amber-500/40">
                <AlertTriangle className="h-3 w-3" /> Would trigger warnings
              </Badge>
            )}
          </div>

          {issues.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No preference warnings would appear on the rota picker for a{" "}
              <span className="font-medium">{previewSpec.name}</span> list.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {issues.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{w.message}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

