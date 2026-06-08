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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarIcon, Plus, Trash2 } from "lucide-react";
import { cn, formatDateGB } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { LeaveRequestDialog } from "@/components/leave-request-dialog";
import { toast } from "sonner";
import { compareBySurname } from "@/lib/name-sort";

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

import {
  leaveWorkingDays,
  leaveOverlapsYear,
  summariseStaffLeave,
  DEFAULT_ANNUAL,
  DEFAULT_STUDY,
  DEFAULT_PROFESSIONAL,
  type AllowanceLike as AllowanceRow,
} from "@/lib/leave-allowances";

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
  const [allowances, setAllowances] = useState<AllowanceRow[]>([]);
  // Year-scoped leave rows (separate from `rows` so the calendar / upcoming
  // tabs aren't ballooned by historical data they don't need).
  const [yearLeave, setYearLeave] = useState<LeaveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  // Default leave year start: April 1st of the current (or prior, if before
  // April) calendar year — the NHS convention.
  const defaultYearStartISO = useMemo(() => {
    const t = new Date();
    const year = t.getUTCMonth() >= 3 ? t.getUTCFullYear() : t.getUTCFullYear() - 1;
    return `${year}-04-01`;
  }, []);

  // Selected leave year for the Allowances tab (uniform across all staff
  // when set — overrides any per-staff leave_year_start so the table is
  // consistent for prior- and future-year viewing).
  const [selectedYearStartISO, setSelectedYearStartISO] = useState<string>(defaultYearStartISO);

  // Day-search state: defaults to today.
  const [pickedDate, setPickedDate] = useState<Date>(() => new Date());
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [nameFilter, setNameFilter] = useState("");
  const [allowanceFilter, setAllowanceFilter] = useState("");

  const load = async () => {
    if (!user) return;
    setLoading(true);
    // Scope to a relevant window so we never hit Supabase's default 1000-row
    // cap and silently drop rows covering "today" (which happened when there
    // were >1000 future rows ordered by start_date DESC). We keep ~13 months
    // of history for the "All upcoming" / sick-leave tabs so that
    // retrospectively-added sick leave (logged in CLWRota weeks or months
    // after the absence) is included, and a generous future horizon for
    // planning. .range() raises the row ceiling as a belt-and-braces guard.
    const today = new Date();
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - 400);
    const windowEnd = new Date(today);
    windowEnd.setFullYear(windowEnd.getFullYear() + 2);
    // Allowance tab needs up to 13 months of history (longest realistic leave
    // year window) to compute year-to-date taken/booked totals.
    const yearLookback = new Date(today);
    yearLookback.setDate(yearLookback.getDate() - 400);
    const fmtIso = (d: Date) => format(d, "yyyy-MM-dd");

    // Rely on RLS: staff see own rows; coords/admins see everyone.
    // NOTE: yearLeave is fetched by a separate effect keyed on
    // selectedYearStartISO, so it isn't loaded here (avoids a race where
    // this load completes after the year-specific fetch and overwrites it).
    const [leaveRes, profRes, allowRes] = await Promise.all([
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
      supabase
        .from("leave_allowances")
        .select("staff_id, leave_year_start, annual_days, study_days, professional_days"),
    ]);
    if (leaveRes.error) toast.error(leaveRes.error.message);
    if (profRes.error) toast.error(profRes.error.message);
    if (allowRes.error) toast.error(allowRes.error.message);
    setRows((leaveRes.data ?? []) as LeaveRow[]);
    setProfiles((profRes.data ?? []) as ProfileRow[]);
    setAllowances((allowRes.data ?? []) as AllowanceRow[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [user?.id]);

  // Refetch yearLeave whenever the selected leave year changes, so prior
  // and future years return their own rows (the main load only covers a
  // sliding window around today).
  useEffect(() => {
    if (!user) return;
    const yStart = new Date(selectedYearStartISO + "T00:00:00Z");
    const yEnd = new Date(yStart);
    yEnd.setUTCFullYear(yEnd.getUTCFullYear() + 1);
    const fmtIso = (d: Date) => format(d, "yyyy-MM-dd");
    void supabase
      .from("leave_requests")
      .select("id, staff_id, type, status, start_date, end_date, half_day_start, half_day_end")
      .in("status", ["approved", "pending"])
      .lte("start_date", fmtIso(yEnd))
      .gte("end_date", fmtIso(yStart))
      .order("start_date", { ascending: true })
      .range(0, 9999)
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        else setYearLeave((data ?? []) as LeaveRow[]);
      });
  }, [user?.id, selectedYearStartISO]);


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
        compareBySurname(a.profile?.full_name, b.profile?.full_name),
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

  // Sick-leave listing across the loaded window. Sick leave is almost
  // always recorded retrospectively (logged in CLWRota after the absence
  // started), so we surface it on its own tab — most recent first — and
  // flag rows whose `created_at` is after `start_date` so reviewers can
  // see which entries were back-filled rather than booked in advance.
  type SickRow = LeaveRow & { _isRetrospective: boolean; _daysLate: number };
  const sickRows = useMemo<SickRow[]>(() => {
    const out: SickRow[] = [];
    for (const r of rows) {
      if (r.type !== "sick") continue;
      if (r.status === "cancelled" || r.status === "rejected") continue;
      const startMs = new Date(r.start_date + "T00:00:00Z").getTime();
      const createdMs = new Date(r.created_at).getTime();
      const daysLate = Math.floor((createdMs - startMs) / (1000 * 60 * 60 * 24));
      out.push({ ...r, _isRetrospective: daysLate >= 1, _daysLate: daysLate });
    }
    return out.sort((a, b) => b.start_date.localeCompare(a.start_date));
  }, [rows]);

  // Sick leave entries added in the last 14 days, no matter what absence
  // date they cover — the practical "what's new on the leave tab" view.
  const recentlyAddedSick = useMemo(() => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    return sickRows.filter((r) => new Date(r.created_at).getTime() >= cutoff);
  }, [sickRows]);


  // --- Allowance summary: per-staff balances for the selected leave year. ---



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
          <TabsTrigger value="sick">Sick leave</TabsTrigger>
          <TabsTrigger value="allowances">Allowances</TabsTrigger>
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

        {/* ---------------- Sick leave (incl. retrospective from CLWRota) ---------------- */}
        <TabsContent value="sick">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Sick leave</CardTitle>
              <CardDescription>
                All sick-leave entries in the last 13 months, most recent absence first.
                Includes records back-filled from CLWRota after the absence — flagged
                <Badge variant="outline" className="ml-1 mr-1 align-middle">Retrospective</Badge>
                when the entry was logged after the absence started.
                {recentlyAddedSick.length > 0 && (
                  <> <span className="font-medium text-foreground">{recentlyAddedSick.length}</span> entr{recentlyAddedSick.length === 1 ? "y" : "ies"} added in the last 14 days.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : sickRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sick-leave records in the loaded window.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Absence</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Grade</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Logged</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sickRows.map((r) => {
                      const p = profileById.get(r.staff_id);
                      const isNew = recentlyAddedSick.some((x) => x.id === r.id);
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="font-mono text-xs">
                            {formatDateGB(r.start_date)} → {formatDateGB(r.end_date)}
                          </TableCell>
                          <TableCell>{p?.full_name ?? "Unknown"}</TableCell>
                          <TableCell>{gradeLabel(p?.grade)}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(r.status)} className="capitalize">
                              {r.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="font-mono">{formatDateGB(r.created_at.slice(0, 10))}</span>
                              {r._isRetrospective && (
                                <Badge variant="outline" title={`Logged ${r._daysLate} day${r._daysLate === 1 ? "" : "s"} after absence started`}>
                                  Retrospective{r._daysLate > 1 ? ` (+${r._daysLate}d)` : ""}
                                </Badge>
                              )}
                              {isNew && (
                                <Badge variant="secondary">New</Badge>
                              )}
                            </div>
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

        {/* ---------------- Allowances ---------------- */}
        <TabsContent value="allowances">

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
