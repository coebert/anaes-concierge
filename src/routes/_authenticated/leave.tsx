import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { LeaveRequestDialog } from "@/components/leave-request-dialog";
import { toast } from "sonner";
import { formatDateGB } from "@/lib/utils";

interface LeaveRow {
  id: string;
  staff_id: string;
  type: string;
  status: string;
  start_date: string;
  end_date: string;
  half_day_start: string | null;
  half_day_end: string | null;
  reason: string | null;
  conflict_notes: string | null;
  decision_notes: string | null;
  decided_at: string | null;
  created_at: string;
}

interface ProfileRow {
  id: string;
  full_name: string;
  grade: string | null;
}

interface AllowanceRow {
  staff_id: string;
  leave_year_start: string; // YYYY-MM-DD
  annual_days: number;
  study_days: number;
}

const DEFAULT_ANNUAL = 27;
const DEFAULT_STUDY = 10;

/**
 * Working-day length of a leave request (Mon–Fri only), with half-day
 * markers reducing the total by 0.5 each. Mirrors how NHS leave allowances
 * are conventionally expressed.
 */
function leaveWorkingDays(r: Pick<LeaveRow, "start_date" | "end_date" | "half_day_start" | "half_day_end">): number {
  let count = 0;
  const start = new Date(r.start_date + "T00:00:00Z");
  const end = new Date(r.end_date + "T00:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  if (r.half_day_start) count -= 0.5;
  if (r.half_day_end) count -= 0.5;
  return Math.max(0, count);
}

/** Returns true if the leave window overlaps [yearStart, yearStart + 1y). */
function leaveOverlapsYear(r: Pick<LeaveRow, "start_date" | "end_date">, yearStartISO: string): boolean {
  const yStart = new Date(yearStartISO + "T00:00:00Z");
  const yEnd = new Date(yStart);
  yEnd.setUTCFullYear(yEnd.getUTCFullYear() + 1);
  const lStart = new Date(r.start_date + "T00:00:00Z");
  const lEnd = new Date(r.end_date + "T00:00:00Z");
  return lStart < yEnd && lEnd >= yStart;
}

export const Route = createFileRoute("/_authenticated/leave")({
  component: LeavePage,
});

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "approved") return "default";
  if (s === "rejected" || s === "cancelled") return "destructive";
  return "secondary";
}

const ACTIVE_STATUSES = new Set(["approved", "pending"]);

/** A leave row covers a given date if start_date <= date <= end_date. */
function leaveCoversDate(r: LeaveRow, isoDate: string): boolean {
  return r.start_date <= isoDate && isoDate <= r.end_date;
}

function gradeLabel(grade: string | null | undefined): string {
  if (!grade) return "Other";
  if (grade === "consultant") return "Consultant";
  if (grade === "trainee") return "Trainee";
  if (grade === "sas") return "SAS";
  return grade;
}

function LeavePage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  // Day-search state: defaults to today.
  const [pickedDate, setPickedDate] = useState<Date>(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [nameFilter, setNameFilter] = useState("");

  const load = async () => {
    if (!user) return;
    setLoading(true);
    // Scope to a relevant window so we never hit Supabase's default 1000-row
    // cap and silently drop rows covering "today" (which happened when there
    // were >1000 future rows ordered by start_date DESC). We keep ~60 days of
    // history for the "All upcoming" tab and a generous future horizon for
    // planning. .range() raises the row ceiling as a belt-and-braces guard.
    const today = new Date();
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - 60);
    const windowEnd = new Date(today);
    windowEnd.setFullYear(windowEnd.getFullYear() + 2);
    const fmtIso = (d: Date) => format(d, "yyyy-MM-dd");

    // Rely on RLS: staff see own rows; coords/admins see everyone.
    const [leaveRes, profRes] = await Promise.all([
      supabase
        .from("leave_requests")
        .select("*")
        .gte("end_date", fmtIso(windowStart))
        .lte("start_date", fmtIso(windowEnd))
        .order("start_date", { ascending: true })
        .range(0, 4999),
      supabase
        .from("profiles")
        .select("id, full_name, grade")
        .eq("active", true),
    ]);
    if (leaveRes.error) toast.error(leaveRes.error.message);
    if (profRes.error) toast.error(profRes.error.message);
    setRows((leaveRes.data ?? []) as LeaveRow[]);
    setProfiles((profRes.data ?? []) as ProfileRow[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [user?.id]);

  const cancel = async (id: string) => {
    const { error } = await supabase.from("leave_requests").update({ status: "cancelled" }).eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Request cancelled");
    void load();
  };

  const profileById = useMemo(() => {
    const m = new Map<string, ProfileRow>();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  const pickedIso = format(pickedDate, "yyyy-MM-dd");

  // Active rows = approved/pending; cancelled and rejected don't count.
  const activeRows = useMemo(
    () => rows.filter((r) => ACTIVE_STATUSES.has(r.status)),
    [rows],
  );

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
        (a.profile?.full_name ?? "").localeCompare(b.profile?.full_name ?? ""),
      );
  }, [activeRows, profileById, pickedIso, nameFilter]);

  const breakdown = useMemo(() => {
    const counts = { consultant: 0, trainee: 0, sas: 0, other: 0, total: 0 };
    const seen = new Set<string>();
    for (const r of activeRows) {
      if (!leaveCoversDate(r, pickedIso)) continue;
      if (seen.has(r.staff_id)) continue; // de-dupe overlapping rows for same person
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

  // For the calendar dots: dates with any active leave.
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

  const myRows = useMemo(
    () => (user ? rows.filter((r) => r.staff_id === user.id) : []),
    [rows, user],
  );

  // All-staff approved/pending listing (upcoming first, then recent past).
  const allUpcoming = useMemo(() => {
    const today = format(new Date(), "yyyy-MM-dd");
    return activeRows
      .filter((r) => r.end_date >= today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [activeRows]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Leave</h1>
          <p className="text-sm text-muted-foreground">
            Department-wide leave calendar. Search any date to see who is off and the
            grade breakdown.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> New request
        </Button>
      </div>

      <Tabs defaultValue="calendar" className="space-y-4">
        <TabsList>
          <TabsTrigger value="calendar">Department calendar</TabsTrigger>
          <TabsTrigger value="upcoming">All upcoming</TabsTrigger>
          <TabsTrigger value="mine">My requests</TabsTrigger>
        </TabsList>

        {/* ---------------- Day search + breakdown ---------------- */}
        <TabsContent value="calendar" className="space-y-4">
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
        </TabsContent>

        {/* ---------------- All upcoming ---------------- */}
        <TabsContent value="upcoming">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">All upcoming leave</CardTitle>
              <CardDescription>
                Every approved or pending request ending today or later.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : allUpcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing upcoming.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dates</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Grade</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allUpcoming.map((r) => {
                      const p = profileById.get(r.staff_id);
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs">
                            {formatDateGB(r.start_date)} → {formatDateGB(r.end_date)}
                          </TableCell>
                          <TableCell>{p?.full_name ?? "Unknown"}</TableCell>
                          <TableCell>{gradeLabel(p?.grade)}</TableCell>
                          <TableCell className="capitalize">{r.type}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(r.status)} className="capitalize">
                              {r.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------- My requests (original view) ---------------- */}
        <TabsContent value="mine">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">My requests</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : myRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No requests yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dates</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {myRows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">
                          {formatDateGB(r.start_date)}
                          {r.half_day_start ? ` (${r.half_day_start === "am" ? "PM only" : "AM only"})` : ""}
                          {" → "}
                          {formatDateGB(r.end_date)}
                          {r.half_day_end ? ` (${r.half_day_end} only)` : ""}
                        </TableCell>
                        <TableCell className="capitalize">{r.type}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(r.status)} className="capitalize">
                            {r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-sm">
                          {r.conflict_notes && <div className="text-amber-700">⚠ {r.conflict_notes}</div>}
                          {r.decision_notes && <div>{r.decision_notes}</div>}
                          {r.reason && <div className="italic">{r.reason}</div>}
                        </TableCell>
                        <TableCell>
                          {r.status === "pending" && (
                            <Button variant="ghost" size="icon" onClick={() => cancel(r.id)} title="Cancel">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <LeaveRequestDialog open={open} onOpenChange={setOpen} onSubmitted={load} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        accent ? "bg-primary/5 border-primary/30" : "bg-muted/30",
      )}
    >
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
