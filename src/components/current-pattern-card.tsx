/**
 * Current-pattern card: compact per-staff summary of the weekly rota
 * pattern derived from CLWRota-synced assignments over the last N days.
 *
 * Data source is the already-synced `rota_assignments` / `theatre_sessions`
 * tables, so this card stays consistent with the rest of the app.
 *
 * Results are also mirrored to localStorage (per staff + window) so the
 * card paints instantly on repeat visits while React Query refreshes in
 * the background.
 */
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CalendarRange, ChevronDown, ExternalLink, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageLoading } from "@/components/loading";
import { EmptyState } from "@/components/empty-state";
import {
  LOCATION_LABELS,
  computeConsultantPattern,
  dominantByHalfSession,
  suggestedRegularityThreshold,
  summariseStaff,
  WEEKDAY_LABELS,
  type AssignmentLite,
  type DominantCell,
  type LocationBucket,
  type SessionLite,
  type SpecialtyLite,
  type StaffGrade,
  type TheatreKind,
  type TheatreLite,
} from "@/lib/staff-working-patterns";
import {
  applyLeaveOverlay,
  expandApprovedLeaveToAssignments,
  type LeaveRowLite,
} from "@/lib/staff-current-pattern";

import { cn } from "@/lib/utils";

const LOCATION_ABBR: Record<LocationBucket, string> = {
  main: "Main",
  day_surgery: "DSU",
  private_sag: "SAG",
  private_non_sag: "NHH",
  obstetrics: "Obs",
  icu: "ICU",
  leave: "Leave",
  other: "—",
};

const LOCATION_TONE: Record<LocationBucket, string> = {
  main: "bg-primary/10 text-primary border-primary/30",
  day_surgery: "bg-info-muted text-info border-info/30",
  private_sag: "bg-success-muted text-success border-success/30",
  private_non_sag: "bg-warning-muted text-warning border-warning/30",
  obstetrics: "bg-destructive-muted text-destructive border-destructive/30",
  icu: "bg-warning-muted text-warning border-warning/40",
  leave: "bg-muted text-muted-foreground border-dashed border-muted-foreground/40",
  other: "bg-muted text-muted-foreground border-border",
};


function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
const todayIso = () => new Date().toISOString().slice(0, 10);


// ---------------------------------------------------------------------------
// localStorage cache
// ---------------------------------------------------------------------------

const CACHE_PREFIX = "clwrota:current-pattern:v1:";
// Serve cached data instantly, but treat entries older than this as stale
// (React Query still refetches in the background so the UI updates).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

type PatternResult = {
  profile: { id: string; full_name: string; grade: StaffGrade | null };
  summary: ReturnType<typeof summariseStaff>[number];
  consultantPattern: ReturnType<typeof computeConsultantPattern> | null;
  dominant: Record<"am" | "pm", Array<DominantCell | null>>;
  windowDays: number;
  threshold: number;
  minCount: number;
  assignmentCount: number;
};

type CacheEntry = { savedAt: number; to: string; data: PatternResult };

function cacheKey(staffId: string, windowDays: number): string {
  return `${CACHE_PREFIX}${staffId}:${windowDays}`;
}

function readCache(
  staffId: string,
  windowDays: number,
): CacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(staffId, windowDays));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.data) return null;
    if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(
  staffId: string,
  windowDays: number,
  to: string,
  data: PatternResult,
): void {
  if (typeof window === "undefined") return;
  try {
    const entry: CacheEntry = { savedAt: Date.now(), to, data };
    window.localStorage.setItem(cacheKey(staffId, windowDays), JSON.stringify(entry));
  } catch {
    // Quota exceeded / disabled storage — non-fatal.
  }
}

export interface CurrentPatternCardProps {
  staffId: string;
  /** Days of history to consider. Defaults to 90. */
  windowDays?: number;
  /** Optional deep-link into the full working-patterns page. */
  showViewAllLink?: boolean;
}

export function CurrentPatternCard({
  staffId,
  windowDays = 90,
  showViewAllLink = true,
}: CurrentPatternCardProps) {
  const from = useMemo(() => isoDaysAgo(windowDays), [windowDays]);
  const to = todayIso();

  // Seed React Query from localStorage so repeat visits paint instantly.
  const cached = useMemo(
    () => readCache(staffId, windowDays),
    [staffId, windowDays],
  );

  const { data, isLoading, error } = useQuery<PatternResult | null>({
    queryKey: ["current-pattern", staffId, from, to],
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.savedAt,
    // Cached entry from an earlier day should refresh in the background but
    // still render immediately. Same-day cache is treated as fresh.
    staleTime: cached && cached.to === to ? 5 * 60_000 : 0,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      const [profileRes, theatresRes, specialtiesRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, grade")
          .eq("id", staffId)
          .maybeSingle(),
        supabase.from("theatres").select("id, name, kind"),
        supabase.from("specialties").select("id, name"),
      ]);
      if (profileRes.error) throw profileRes.error;
      if (theatresRes.error) throw theatresRes.error;
      if (specialtiesRes.error) throw specialtiesRes.error;

      const theatresById = new Map<string, TheatreLite>();
      for (const t of theatresRes.data ?? []) {
        theatresById.set(t.id, {
          id: t.id,
          name: t.name,
          kind: (t.kind ?? null) as TheatreKind | null,
        });
      }
      const specialtiesById = new Map<string, SpecialtyLite>();
      for (const s of specialtiesRes.data ?? []) {
        specialtiesById.set(s.id, { id: s.id, name: s.name });
      }

      // Assignments for this staff member only.
      const assignments: AssignmentLite[] = [];
      const sessionIds = new Set<string>();
      {
        const PAGE = 1000;
        let offset = 0;
        while (true) {
          const { data: page, error: err } = await supabase
            .from("rota_assignments")
            .select("staff_id, duty_type, theatre_session_id, session_date, session")
            .eq("staff_id", staffId)
            .gte("session_date", from)
            .lte("session_date", to)
            .range(offset, offset + PAGE - 1);
          if (err) throw err;
          const rows = page ?? [];
          for (const r of rows) {
            assignments.push({
              staff_id: r.staff_id,
              duty_type: r.duty_type ?? null,
              session_date: r.session_date,
              session: r.session ?? null,
              theatre_session_id: r.theatre_session_id ?? null,
            });
            if (r.theatre_session_id) sessionIds.add(r.theatre_session_id);
          }
          if (rows.length < PAGE) break;
          offset += PAGE;
        }
      }

      // Only fetch the theatre_sessions this staff actually touched.
      const sessionsById = new Map<string, SessionLite>();
      if (sessionIds.size > 0) {
        const ids = Array.from(sessionIds);
        const CHUNK = 200;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK);
          const { data: rows, error: err } = await supabase
            .from("theatre_sessions")
            .select("id, theatre_id, specialty_id, is_non_sag")
            .in("id", slice);
          if (err) throw err;
          for (const r of rows ?? []) {
            sessionsById.set(r.id, {
              id: r.id,
              theatre_id: r.theatre_id ?? null,
              specialty_id: r.specialty_id ?? null,
              is_non_sag: r.is_non_sag ?? false,
            });
          }
        }
      }

      // Leave overlay: approved leave in the window blocks the covered AM/PM
      // half-sessions and can itself become the dominant "location".
      const { data: leaveRowsRaw, error: leaveErr } = await supabase
        .from("leave_requests")
        .select(
          "type,start_date,end_date,status,half_day_start,half_day_end,reason,decision_notes",
        )
        .eq("staff_id", staffId)
        .eq("status", "approved")
        .lte("start_date", to)
        .gte("end_date", from);
      if (leaveErr) throw leaveErr;
      const leaveRows = (leaveRowsRaw ?? []) as LeaveRowLite[];
      const leaveOverlay = expandApprovedLeaveToAssignments(
        staffId,
        leaveRows,
        from,
        to,
      );
      const effectiveAssignments = applyLeaveOverlay(assignments, leaveOverlay);



      const profile = profileRes.data;
      if (!profile) return null;
      const grade = (profile.grade ?? null) as StaffGrade | null;

      const threshold = suggestedRegularityThreshold(windowDays);
      const [summary] = summariseStaff(
        [
          {
            id: profile.id,
            full_name: profile.full_name ?? "",
            grade,
          },
        ],
        effectiveAssignments,
        sessionsById,
        theatresById,
        specialtiesById,
        { regularityThreshold: threshold },
      );

      const consultantPattern =
        grade === "consultant" || grade === "sas"
          ? computeConsultantPattern(
              effectiveAssignments,
              sessionsById,
              theatresById,
              { regularityThreshold: threshold },
            )
          : null;

      const minCount = Math.max(2, Math.floor(threshold / 2) + 1);
      const dominant = dominantByHalfSession(
        effectiveAssignments,
        sessionsById,
        theatresById,
        // Cell shows up if a half-session recurs in ~half the window's weeks.
        minCount,
      );

      return {
        profile: { id: profile.id, full_name: profile.full_name ?? "", grade },
        summary,
        consultantPattern,
        dominant,
        windowDays,
        threshold,
        minCount,
        assignmentCount: effectiveAssignments.length,
      };

    },
  });

  // Mirror successful fetches back to localStorage.
  useEffect(() => {
    if (data) writeCache(staffId, windowDays, to, data);
  }, [data, staffId, windowDays, to]);

  if (isLoading) return <PageLoading />;
  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">
          Couldn't load pattern: {(error as Error).message}
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <EmptyState
        icon={CalendarRange}
        title="Staff member not found"
        description="No profile matched this ID."
      />
    );
  }
  if (data.summary.totalSessions === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Current pattern</CardTitle>
          <CardDescription>
            Based on the last {data.windowDays} days of synced CLWRota data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={CalendarRange}
            title="No recent assignments"
            description={`No rota assignments for this staff member in the last ${data.windowDays} days.`}
          />
        </CardContent>
      </Card>
    );
  }

  const { summary, consultantPattern, dominant } = data;

  const locationTotals = Object.entries(summary.byLocation)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="text-base">Current pattern</CardTitle>
            <CardDescription>
              Based on the last {data.windowDays} days ·{" "}
              {summary.totalSessions} sessions
              {consultantPattern &&
                consultantPattern.totalOnCallSessions > 0 && (
                  <> · {consultantPattern.totalOnCallSessions} on-call</>
                )}
            </CardDescription>
          </div>
          {showViewAllLink && (
            <Button asChild variant="ghost" size="sm">
              <Link to="/staff/working-patterns">
                All patterns
                <ExternalLink className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Weekly grid */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-separate border-spacing-1 text-center text-xs">
            <thead>
              <tr>
                <th className="w-10" />
                {[1, 2, 3, 4, 5].map((d) => (
                  <th
                    key={d}
                    className="font-medium text-muted-foreground"
                  >
                    {WEEKDAY_LABELS[d]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["am", "pm"] as const).map((half) => (
                <tr key={half}>
                  <td className="text-[10px] font-semibold uppercase text-muted-foreground">
                    {half}
                  </td>
                  {[1, 2, 3, 4, 5].map((d) => {
                    const cell = dominant[half][d];
                    if (!cell) {
                      return (
                        <td
                          key={d}
                          className="rounded-md border border-dashed border-border/60 py-2 text-muted-foreground/50"
                          aria-label={`${WEEKDAY_LABELS[d]} ${half}: no regular pattern`}
                        >
                          ·
                        </td>
                      );
                    }
                    return (
                      <td
                        key={d}
                        className={cn(
                          "rounded-md border py-2 font-medium",
                          LOCATION_TONE[cell.bucket],
                        )}
                        title={`${LOCATION_LABELS[cell.bucket]} — ${cell.count} of ${cell.total} recent ${WEEKDAY_LABELS[d]} ${half} sessions`}
                      >
                        {LOCATION_ABBR[cell.bucket]}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Consultant / SAS extras */}
        {consultantPattern && (
          <div className="flex flex-wrap gap-2 text-xs">
            {consultantPattern.onCallType !== "none" &&
              consultantPattern.onCallWeekdays.length > 0 && (
                <Badge variant="secondary" className="gap-1">
                  On-call ({consultantPattern.onCallType}):{" "}
                  {consultantPattern.onCallWeekdays
                    .map((d) => WEEKDAY_LABELS[d])
                    .join(", ")}
                </Badge>
              )}
            {consultantPattern.privateWeekdays.length > 0 && (
              <Badge variant="secondary" className="gap-1 bg-success-muted text-success">
                SAG:{" "}
                {consultantPattern.privateWeekdays
                  .map((d) => WEEKDAY_LABELS[d])
                  .join(", ")}
              </Badge>
            )}
            {(consultantPattern.spaAmWeekdays.length > 0 ||
              consultantPattern.spaPmWeekdays.length > 0) && (
              <Badge variant="outline" className="gap-1">
                SPA:{" "}
                {Array.from(
                  new Set([
                    ...consultantPattern.spaAmWeekdays,
                    ...consultantPattern.spaPmWeekdays,
                  ]),
                )
                  .sort((a, b) => a - b)
                  .map((d) => WEEKDAY_LABELS[d])
                  .join(", ")}
              </Badge>
            )}
          </div>
        )}

        {/* Location totals */}
        {locationTotals.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              Where they work
            </div>
            <div className="space-y-1">
              {locationTotals.map(([bucket, count]) => {
                const pct = Math.round(
                  (count / summary.totalSessions) * 100,
                );
                return (
                  <div key={bucket} className="flex items-center gap-2 text-xs">
                    <div className="w-32 shrink-0 text-muted-foreground">
                      {LOCATION_LABELS[bucket as LocationBucket]}
                    </div>
                    <div className="relative h-2 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className={cn(
                          "absolute inset-y-0 left-0 rounded",
                          LOCATION_TONE[bucket as LocationBucket]
                            .split(" ")
                            .filter((c) => c.startsWith("bg-"))
                            .join(" ") || "bg-primary/40",
                        )}
                        style={{ width: `${Math.max(4, pct)}%` }}
                      />
                    </div>
                    <div className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                      {count} · {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {summary.bySpecialty.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {summary.bySpecialty.slice(0, 6).map((s) => (
              <Badge key={s.specialty} variant="outline" className="text-[11px]">
                {s.specialty} · {s.count}
              </Badge>
            ))}
          </div>
        )}

        {/* How this was computed */}
        <Collapsible>
          <CollapsibleTrigger
            className={cn(
              "group flex w-full items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left text-xs font-medium text-muted-foreground",
              "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              How this was computed
            </span>
            <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="px-1 pt-3 text-xs leading-relaxed text-muted-foreground">
            <p className="mb-2">
              Derived from{" "}
              <span className="font-medium text-foreground">
                {data.assignmentCount}
              </span>{" "}
              rota assignments in the last{" "}
              <span className="font-medium text-foreground">
                {data.windowDays} days
              </span>{" "}
              synced from CLWRota. Weekends are hidden — only Mon–Fri AM/PM
              half-sessions are shown.
            </p>
            <p className="mb-2">
              <span className="font-medium text-foreground">
                Dominant location per half-session.
              </span>{" "}
              For each weekday × AM/PM pair, assignments are grouped by
              location bucket ({Object.values(LOCATION_LABELS)
                .filter((l) => l !== "—")
                .join(", ")}). The bucket with the most{" "}
              <em>distinct dates</em> in that slot wins the cell — so working
              two AM lists on the same Tuesday still only counts once. The
              cell shows the winning bucket's abbreviation and hovers to
              reveal "<em>N of M</em> recent {WEEKDAY_LABELS[1]} AM sessions".
            </p>
            <p className="mb-2">
              <span className="font-medium text-foreground">
                Regularity threshold.
              </span>{" "}
              A cell only appears if the winning bucket recurs on at least{" "}
              <span className="font-medium text-foreground">
                {data.minCount} distinct dates
              </span>{" "}
              in the window (roughly half the ~
              {data.threshold}-week regularity target from{" "}
              <code>suggestedRegularityThreshold({data.windowDays})</code>).
              One-off cover shifts therefore fall out; a dot (·) means "no
              regular pattern here".
            </p>
            <p className="mb-2">
              <span className="font-medium text-foreground">
                Consultant / SAS extras.
              </span>{" "}
              On-call, SAG (private SAG list), and SPA badges use the same
              regularity threshold via <code>computeConsultantPattern</code>.
              On-call type ("weekday", "weekend", "mixed") is inferred from
              which weekdays are covered.
            </p>
            <p className="mb-0">
              <span className="font-medium text-foreground">
                Location share &amp; specialties.
              </span>{" "}
              The bar chart counts every assignment (not distinct dates), so
              an AM+PM day contributes twice. Top specialties are the most
              common surgical specialties on theatre lists this staff member
              covered.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
