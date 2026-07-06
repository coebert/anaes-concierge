import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";
import { formatDateGB } from "@/lib/utils";
import {
  GAP_KIND_LABEL,
  classifyRotaGaps,
  type GapRange,
  type ClassifiedGapRange,
  type GapKind,
} from "@/lib/rota-gaps";

export function GapRangeRow({ range }: { range: GapRange }) {
  const single = range.startISO === range.endISO;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="font-mono">
        {single
          ? formatDateGB(range.startISO)
          : `${formatDateGB(range.startISO)} → ${formatDateGB(range.endISO)}`}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {range.missingDays} working day{range.missingDays === 1 ? "" : "s"}
        </span>
        {!single && (
          <Badge variant="outline" className="px-1 py-0 text-[10px]">
            {range.spanDays}-day span
          </Badge>
        )}
      </span>
    </li>
  );
}

export function Stat({
  icon: Icon, tone, label, value,
}: {
  icon: typeof CheckCircle2;
  tone: "ok" | "bad" | "muted";
  label: string;
  value: number;
}) {
  const toneClass =
    tone === "ok"
      ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
      : tone === "bad"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 items-center justify-center rounded-md ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export const KIND_TONE: Record<GapKind, string> = {
  pre_rotation: "bg-muted text-muted-foreground",
  rotation_ended: "bg-muted text-muted-foreground",
  ltft_off: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sync_missing: "bg-destructive/10 text-destructive",
};

export function ClassifiedSection({
  report,
}: {
  report: ReturnType<typeof classifyRotaGaps>;
}) {
  const total =
    report.counts.pre_rotation +
    report.counts.rotation_ended +
    report.counts.ltft_off +
    report.counts.sync_missing;
  if (total === 0) return null;
  return (
    <CardContent className="border-t pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">Classification:</span>
        {(Object.keys(GAP_KIND_LABEL) as GapKind[]).map((k) => (
          <Badge key={k} variant="outline" className={`gap-1 ${KIND_TONE[k]}`}>
            {GAP_KIND_LABEL[k]}: {report.counts[k]}
          </Badge>
        ))}
      </div>
      {report.ranges.length > 0 && (
        <ul className="divide-y rounded-md border">
          {report.ranges.map((r) => (
            <ClassifiedRangeRow key={`${r.kind}-${r.startISO}-${r.endISO}`} range={r} />
          ))}
        </ul>
      )}
    </CardContent>
  );
}

export function ClassifiedRangeRow({ range }: { range: ClassifiedGapRange }) {
  const single = range.startISO === range.endISO;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <Badge variant="outline" className={`px-1 py-0 text-[10px] ${KIND_TONE[range.kind]}`}>
          {GAP_KIND_LABEL[range.kind]}
        </Badge>
        <span className="font-mono">
          {single
            ? formatDateGB(range.startISO)
            : `${formatDateGB(range.startISO)} → ${formatDateGB(range.endISO)}`}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {range.days} day{range.days === 1 ? "" : "s"}
      </span>
    </li>
  );
}
