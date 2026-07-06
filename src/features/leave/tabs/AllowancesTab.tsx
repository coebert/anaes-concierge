import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, formatDateGB } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import {
  leaveWorkingDays,
  leaveOverlapsYear,
  DEFAULT_ANNUAL,
  DEFAULT_STUDY,
  DEFAULT_PROFESSIONAL,
  type AllowanceLike as AllowanceRow,
} from "@/features/leave/leave-allowances";
import { gradeLabel, type LeaveRow, type ProfileRow } from "./shared";

export function AllowancesTab({
  loading,
  profiles,
  yearLeave,
  allowances,
  defaultYearStartISO,
  selectedYearStartISO,
  setSelectedYearStartISO,
}: {
  loading: boolean;
  profiles: ProfileRow[];
  yearLeave: LeaveRow[];
  allowances: AllowanceRow[];
  defaultYearStartISO: string;
  selectedYearStartISO: string;
  setSelectedYearStartISO: (iso: string) => void;
}) {
  const [allowanceFilter, setAllowanceFilter] = useState("");

  const allowanceByStaff = useMemo(() => {
    const m = new Map<string, AllowanceRow>();
    for (const a of allowances) m.set(a.staff_id, a);
    return m;
  }, [allowances]);

  const allowanceRows = useMemo(() => {
    type Bucket = { taken: number; booked: number };
    type BucketKey =
      | "annual" | "study" | "professional"
      | "sick" | "parental" | "compassionate" | "other";
    type Summary = {
      profile: ProfileRow;
      yearStartISO: string;
      annualAllowance: number;
      studyAllowance: number;
      professionalAllowance: number;
      buckets: Record<BucketKey, Bucket>;
    };
    const emptyBuckets = (): Record<BucketKey, Bucket> => ({
      annual: { taken: 0, booked: 0 },
      study: { taken: 0, booked: 0 },
      professional: { taken: 0, booked: 0 },
      sick: { taken: 0, booked: 0 },
      parental: { taken: 0, booked: 0 },
      compassionate: { taken: 0, booked: 0 },
      other: { taken: 0, booked: 0 },
    });
    const out: Summary[] = [];
    for (const p of profiles) {
      const a = allowanceByStaff.get(p.id);
      const yearStartISO = selectedYearStartISO;
      const annualAllowance = Number(a?.annual_days ?? DEFAULT_ANNUAL);
      const studyAllowance = Number(a?.study_days ?? DEFAULT_STUDY);
      const professionalAllowance = Number(a?.professional_days ?? DEFAULT_PROFESSIONAL);
      const buckets = emptyBuckets();
      for (const r of yearLeave) {
        if (r.staff_id !== p.id) continue;
        if (!leaveOverlapsYear(r, yearStartISO)) continue;
        const days = leaveWorkingDays(r);
        if (days <= 0) continue;
        const k: BucketKey =
          r.type === "annual" ? "annual"
          : r.type === "study" ? "study"
          : r.type === "professional" ? "professional"
          : r.type === "sick" ? "sick"
          : r.type === "parental" ? "parental"
          : r.type === "compassionate" ? "compassionate"
          : "other";
        if (r.status === "approved") buckets[k].taken += days;
        else if (r.status === "pending") buckets[k].booked += days;
      }
      out.push({
        profile: p,
        yearStartISO,
        annualAllowance,
        studyAllowance,
        professionalAllowance,
        buckets,
      });
    }
    return out.sort((a, b) => compareBySurname(a.profile.full_name, b.profile.full_name));
  }, [profiles, yearLeave, allowanceByStaff, selectedYearStartISO]);

  const allowanceVisible = useMemo(() => {
    const q = allowanceFilter.trim().toLowerCase();
    if (!q) return allowanceRows;
    return allowanceRows.filter(
      (r) =>
        r.profile.full_name.toLowerCase().includes(q) ||
        gradeLabel(r.profile.grade).toLowerCase().includes(q),
    );
  }, [allowanceRows, allowanceFilter]);

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-end justify-between gap-3">
        <div>
          <CardTitle className="text-base">Leave allowances</CardTitle>
          <CardDescription>
            Days taken (approved) + booked (pending) vs annual allowance for the
            current leave year. Counts working days (Mon–Fri); half-day requests
            count as 0.5. Study and professional leave are tracked separately.
          </CardDescription>
        </div>
        <div className="flex items-end gap-2">
          <Select value={selectedYearStartISO} onValueChange={setSelectedYearStartISO}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(() => {
                const baseYear = Number(defaultYearStartISO.slice(0, 4));
                const opts: { iso: string; label: string }[] = [];
                for (let y = baseYear + 2; y >= baseYear - 5; y--) {
                  opts.push({
                    iso: `${y}-04-01`,
                    label: `Apr ${y} – Mar ${y + 1}${y === baseYear ? " (current)" : ""}`,
                  });
                }
                return opts.map((o) => (
                  <SelectItem key={o.iso} value={o.iso}>{o.label}</SelectItem>
                ));
              })()}
            </SelectContent>
          </Select>
          <Input
            value={allowanceFilter}
            onChange={(e) => setAllowanceFilter(e.target.value)}
            placeholder="Filter by name / grade…"
            className="w-[260px]"
          />
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : allowanceVisible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No staff to show.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead className="text-right" title="Annual taken (approved) / booked (pending)">Annual taken/booked</TableHead>
                  <TableHead className="text-right">Annual allowance</TableHead>
                  <TableHead className="text-right" title="Allowance minus taken only (booked future leave is NOT subtracted)">Annual remaining (excl. booked)</TableHead>
                  <TableHead className="text-right" title="Annual remaining minus booked future leave">Annual remaining (after booked)</TableHead>
                  <TableHead className="text-right">Study taken/booked</TableHead>
                  <TableHead className="text-right">Study allowance</TableHead>
                  <TableHead className="text-right">Study remaining</TableHead>
                  <TableHead className="text-right">Professional taken/booked</TableHead>
                  <TableHead className="text-right">Professional allowance</TableHead>
                  <TableHead className="text-right">Professional remaining</TableHead>
                  <TableHead className="text-right" title="Sick leave — informational only, not deducted from an allowance">Sick taken/booked</TableHead>
                  <TableHead className="text-right" title="Parental leave — informational only">Parental taken/booked</TableHead>
                  <TableHead className="text-right" title="Compassionate leave — informational only">Compassionate taken/booked</TableHead>
                  <TableHead className="text-right" title="Any other leave type — informational only">Other taken/booked</TableHead>
                  <TableHead className="text-xs text-muted-foreground">Leave year</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allowanceVisible.map((s) => {
                  const b = s.buckets;
                  const annualRemExcl = s.annualAllowance - b.annual.taken;
                  const annualRemAfter = annualRemExcl - b.annual.booked;
                  const studyUsed = b.study.taken + b.study.booked;
                  const studyRem = s.studyAllowance - studyUsed;
                  const profUsed = b.professional.taken + b.professional.booked;
                  const profRem = s.professionalAllowance - profUsed;
                  const fmt = (n: number) => (Number.isInteger(n) ? n.toString() : n.toFixed(1));
                  const remTone = (rem: number) =>
                    rem < 0 ? "text-destructive font-semibold"
                    : rem <= 2 ? "text-amber-600 font-medium"
                    : "";
                  return (
                    <TableRow key={s.profile.id}>
                      <TableCell className="font-medium">{s.profile.full_name}</TableCell>
                      <TableCell>{gradeLabel(s.profile.grade)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(b.annual.taken)} / {fmt(b.annual.booked)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(s.annualAllowance)}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", remTone(annualRemExcl))}>
                        {fmt(annualRemExcl)}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", remTone(annualRemAfter))}>
                        {fmt(annualRemAfter)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(b.study.taken)} / {fmt(b.study.booked)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(s.studyAllowance)}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", remTone(studyRem))}>
                        {fmt(studyRem)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmt(b.professional.taken)} / {fmt(b.professional.booked)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(s.professionalAllowance)}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", remTone(profRem))}>
                        {fmt(profRem)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(b.sick.taken)} / {fmt(b.sick.booked)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(b.parental.taken)} / {fmt(b.parental.booked)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(b.compassionate.taken)} / {fmt(b.compassionate.booked)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmt(b.other.taken)} / {fmt(b.other.booked)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {formatDateGB(s.yearStartISO)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
