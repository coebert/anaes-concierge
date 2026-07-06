import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { cn, formatDateGB } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import {
  Stat,
  gradeLabel,
  statusVariant,
  leaveCoversDate,
  type LeaveRow,
  type ProfileRow,
} from "./shared";

export function DayCalendarTab({
  loading,
  activeRows,
  profileById,
}: {
  loading: boolean;
  activeRows: LeaveRow[];
  profileById: Map<string, ProfileRow>;
}) {
  const [pickedDate, setPickedDate] = useState<Date>(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [nameFilter, setNameFilter] = useState("");

  const pickedIso = format(pickedDate, "yyyy-MM-dd");

  const onPickedDay = useMemo(() => {
    return activeRows
      .filter((r) => leaveCoversDate(r, pickedIso))
      .map((r) => ({ row: r, profile: profileById.get(r.staff_id) }))
      .filter(({ profile }) => {
        if (!nameFilter.trim()) return true;
        const q = nameFilter.trim().toLowerCase();
        return (profile?.full_name ?? "").toLowerCase().includes(q);
      })
      .sort((a, b) =>
        compareBySurname(a.profile?.full_name, b.profile?.full_name),
      );
  }, [activeRows, profileById, pickedIso, nameFilter]);

  const breakdown = useMemo(() => {
    const counts = { consultant: 0, trainee: 0, sas: 0, other: 0, total: 0 };
    const seen = new Set<string>();
    for (const r of activeRows) {
      if (!leaveCoversDate(r, pickedIso)) continue;
      if (seen.has(r.staff_id)) continue;
      seen.add(r.staff_id);
      const g = profileById.get(r.staff_id)?.grade ?? null;
      counts.total++;
      if (g === "consultant") counts.consultant++;
      else if (g === "trainee") counts.trainee++;
      else if (g === "sas") counts.sas++;
      else counts.other++;
    }
    return counts;
  }, [activeRows, profileById, pickedIso]);

  const daysWithLeave = useMemo(() => {
    const set = new Set<string>();
    for (const r of activeRows) {
      const start = new Date(r.start_date);
      const end = new Date(r.end_date);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        set.add(format(d, "yyyy-MM-dd"));
      }
    }
    return set;
  }, [activeRows]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pick a date</CardTitle>
            <CardDescription>Approved + pending leave is included.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-[260px] justify-start text-left font-normal",
                    !pickedDate && "text-muted-foreground",
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(pickedDate, "EEEE, d MMM yyyy")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={pickedDate}
                  onSelect={(d) => {
                    if (d) setPickedDate(d);
                    setCalendarOpen(false);
                  }}
                  initialFocus
                  modifiers={{
                    hasLeave: (d) => daysWithLeave.has(format(d, "yyyy-MM-dd")),
                  }}
                  modifiersClassNames={{
                    hasLeave:
                      "relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:h-1 after:w-1 after:rounded-full after:bg-primary",
                  }}
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
            <div className="flex flex-wrap gap-2 text-xs">
              <Button variant="ghost" size="sm" onClick={() => setPickedDate(new Date())}>
                Today
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const d = new Date(pickedDate);
                  d.setDate(d.getDate() - 1);
                  setPickedDate(d);
                }}
              >
                ← Prev day
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const d = new Date(pickedDate);
                  d.setDate(d.getDate() + 1);
                  setPickedDate(d);
                }}
              >
                Next day →
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Breakdown — {format(pickedDate, "EEE d MMM yyyy")}
            </CardTitle>
            <CardDescription>
              Distinct people off (a single person on two overlapping requests is counted once).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <Stat label="Total off" value={breakdown.total} accent />
              <Stat label="Consultants" value={breakdown.consultant} />
              <Stat label="Trainees" value={breakdown.trainee} />
              <Stat label="SAS" value={breakdown.sas} />
              <Stat label="Other" value={breakdown.other} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2 flex flex-row items-end justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              On leave on {format(pickedDate, "EEE d MMM yyyy")}
            </CardTitle>
            <CardDescription>
              {onPickedDay.length === 0
                ? "Nobody is recorded as on leave for this date."
                : `${onPickedDay.length} matching ${onPickedDay.length === 1 ? "person" : "people"}.`}
            </CardDescription>
          </div>
          <Input
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter by name…"
            className="w-[220px]"
          />
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : onPickedDay.length === 0 ? (
            <p className="text-sm text-muted-foreground">No staff on leave.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {onPickedDay.map(({ row, profile }) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {profile?.full_name ?? <span className="text-muted-foreground">Unknown</span>}
                    </TableCell>
                    <TableCell>{gradeLabel(profile?.grade)}</TableCell>
                    <TableCell className="capitalize">{row.type}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {formatDateGB(row.start_date)}
                      {row.half_day_start ? ` (${row.half_day_start === "am" ? "PM only" : "AM only"})` : ""}
                      {" → "}
                      {formatDateGB(row.end_date)}
                      {row.half_day_end ? ` (${row.half_day_end} only)` : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(row.status)} className="capitalize">
                        {row.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
