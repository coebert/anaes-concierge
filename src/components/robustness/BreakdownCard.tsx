import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, UserMinus, Coffee, Info, CheckCircle2, XCircle, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  HalfBreakdown, StaffStatusEntry, StaffStatusCategory,
} from "@/lib/audit/robustness";

const CATEGORY_META: Record<
  StaffStatusCategory,
  { label: string; tone: string; iconName: "check" | "coffee" | "info" | "list" | "ban" | "user-minus" | "x"; order: number }
> = {
  free_consultant: { label: "Free consultants (solo-capable)", tone: "border-emerald-500/40 bg-emerald-500/5", iconName: "check", order: 1 },
  free_senior_trainee: { label: "Free senior trainees ST6–8 (solo-capable)", tone: "border-emerald-500/40 bg-emerald-500/5", iconName: "check", order: 2 },
  on_spa: { label: "Consultants on SPA (flexible cover)", tone: "border-orange-500/40 bg-orange-500/5", iconName: "coffee", order: 3 },
  free_junior_trainee: { label: "Free junior trainees (need supervision)", tone: "border-sky-500/30 bg-sky-500/5", iconName: "info", order: 4 },
  free_sas: { label: "Free SAS (pair with consultant)", tone: "border-sky-500/30 bg-sky-500/5", iconName: "info", order: 5 },
  on_clinical_list: { label: "Excluded — already covering a list", tone: "border-slate-500/30 bg-slate-500/5", iconName: "list", order: 6 },
  on_excluded_duty: { label: "Excluded — ICU / obstetrics / on-call / teaching / admin", tone: "border-blue-500/30 bg-blue-500/5", iconName: "ban", order: 7 },
  on_leave: { label: "Excluded — on approved leave", tone: "border-red-500/30 bg-red-500/5", iconName: "user-minus", order: 8 },
  ltft_off: { label: "Excluded — LTFT non-working day", tone: "border-muted bg-muted/30", iconName: "x", order: 9 },
};

function renderIcon(name: typeof CATEGORY_META[StaffStatusCategory]["iconName"]) {
  switch (name) {
    case "check": return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    case "coffee": return <Coffee className="h-4 w-4 text-orange-600" />;
    case "info": return <Info className="h-4 w-4 text-sky-600" />;
    case "list": return <ClipboardList className="h-4 w-4 text-slate-500" />;
    case "ban": return <Ban className="h-4 w-4 text-blue-600" />;
    case "user-minus": return <UserMinus className="h-4 w-4 text-red-500" />;
    case "x": return <XCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function GradeBadge({ grade, trainingLevel }: { grade: string; trainingLevel: string | null }) {
  const label = grade === "trainee" && trainingLevel ? trainingLevel : grade;
  return <Badge variant="outline" className="text-[10px] capitalize">{label}</Badge>;
}

export function BreakdownCard({ label, breakdown }: { label: string; breakdown: HalfBreakdown }) {
  const groups = new Map<StaffStatusCategory, StaffStatusEntry[]>();
  for (const e of breakdown.entries) {
    const arr = groups.get(e.category) ?? [];
    arr.push(e);
    groups.set(e.category, arr);
  }
  const orderedCats = (Object.keys(CATEGORY_META) as StaffStatusCategory[])
    .sort((a, b) => CATEGORY_META[a].order - CATEGORY_META[b].order)
    .filter((c) => (groups.get(c)?.length ?? 0) > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>
          Every active staff member classified for this half-day, with the exact reason.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {orderedCats.length === 0 ? (
          <div className="text-sm text-muted-foreground">Nobody.</div>
        ) : (
          orderedCats.map((cat) => {
            const meta = CATEGORY_META[cat];
            const people = groups.get(cat) ?? [];
            return (
              <details
                key={cat}
                className={cn("rounded-md border p-2", meta.tone)}
                open={cat.startsWith("free_") || cat === "on_spa"}
              >
                <summary className="cursor-pointer text-sm font-medium flex items-center gap-2 select-none">
                  {renderIcon(meta.iconName)}
                  <span>{meta.label}</span>
                  <Badge variant="secondary" className="ml-auto text-[10px]">{people.length}</Badge>
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {people.map((p) => (
                    <li
                      key={p.staffId}
                      className="flex items-center justify-between gap-2 rounded border bg-background/60 px-2 py-1"
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium text-sm">{p.staffName}</span>
                        <GradeBadge grade={p.grade} trainingLevel={p.trainingLevel} />
                      </span>
                      <span className="text-right text-muted-foreground">{p.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
