import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Stethoscope } from "lucide-react";
import { splitName } from "@/lib/utils";
import { checkTableGrants } from "@/lib/grants-healthcheck.functions";

const REQUIRED_TABLES = [
  "profiles",
  "theatres",
  "theatre_sessions",
  "rota_assignments",
] as const;

export const Route = createFileRoute(
  "/_authenticated/robustness/consultant-audits",
)({
  component: ConsultantAuditsPage,
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function ConsultantAuditsPage() {
  const [from, setFrom] = useState<string>(isoDaysAgo(90));
  const [to, setTo] = useState<string>(todayIso());
  const [filter, setFilter] = useState("");

  const checkGrants = useServerFn(checkTableGrants);
  const grantsCheck = useQuery({
    queryKey: ["consultant-audits-grants-check"],
    queryFn: () => checkGrants({ data: { tables: [...REQUIRED_TABLES] } }),
    staleTime: 5 * 60_000,
  });
  const grantsOk = grantsCheck.data?.ok === true;

  const { data, isLoading, error } = useQuery({
    queryKey: ["consultant-audits", from, to],
    enabled: grantsOk,
    queryFn: async () => {
      // Consultants
      const { data: profiles, error: pe } = await supabase
        .from("profiles")
        .select("id,full_name,email,grade,active")
        .eq("grade", "consultant")
        .eq("active", true);
      if (pe) throw pe;
      const consultantIds = (profiles ?? []).map((p) => p.id);
      if (!consultantIds.length) {
        return { rows: [] as ConsultantRow[] };
      }
      const consultantIdSet = new Set(consultantIds);

      // NHH (private) theatres. Include inactive private theatres (e.g.
      // "NHH (legacy)") so historical NHH lists are still classified
      // consistently with how they appear elsewhere in the rota UI.
      const { data: theatres, error: te } = await supabase
        .from("theatres")
        .select("id,name,kind,active")
        .eq("kind", "private");
      if (te) throw te;
      const privateTheatres = new Map(
        (theatres ?? []).map((t) => [t.id, t] as const),
      );

      // SAG classification for an NHH theatre session.
      //   - sag   : NHH list with is_non_sag = false
      //   - non_sag: NHH list with is_non_sag = true
      // This mirrors the existing rota markings: the "Non-SAG" badge in
      // rota-views.tsx and the admin theatre-grid checkbox both key off
      // `theatre_sessions.is_non_sag` for theatres of kind = 'private' only.
      // The `non_sag_override` flag tracks whether an admin has explicitly
      // set the value (vs the default false); we surface it as evidence that
      // the marking has been actively reviewed.
      type SagClass = "sag" | "non_sag";
      type SagMark = { kind: SagClass; reviewed: boolean };
      const sagBySession = new Map<string, SagMark>();
      {
        const PAGE = 1000;
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { data: page, error: se } = await supabase
            .from("theatre_sessions")
            .select(
              "id,theatre_id,is_non_sag,non_sag_override,session_date",
            )
            .gte("session_date", from)
            .lte("session_date", to)
            .range(offset, offset + PAGE - 1);
          if (se) throw se;
          for (const s of page ?? []) {
            // Explicit NHH check: only private-theatre sessions are eligible
            // for SAG / non-SAG classification.
            if (!privateTheatres.has(s.theatre_id)) continue;
            const isNonSag = s.is_non_sag === true;
            sagBySession.set(s.id, {
              kind: isNonSag ? "non_sag" : "sag",
              reviewed: s.non_sag_override === true,
            });
          }
          if (!page || page.length < PAGE) break;
          offset += PAGE;
        }
      }

      // Per-consultant counters.
      const counts = new Map<
        string,
        {
          spa: number;
          sag: number;
          nonSag: number;
          /** Non-SAG lists flagged as explicitly reviewed by an admin. */
          nonSagReviewed: number;
        }
      >();
      for (const id of consultantIds) {
        counts.set(id, { spa: 0, sag: 0, nonSag: 0, nonSagReviewed: 0 });
      }

      // Pull rota assignments in range (paginated). We don't filter by staff_id
      // in the query to avoid URL-length limits with 50+ UUIDs; we drop
      // non-consultant rows in the loop below via the counts map.
      {
        const PAGE = 1000;
        let offset = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { data: page, error: ae } = await supabase
            .from("rota_assignments")
            .select("staff_id,duty_type,theatre_session_id,session_date,session")
            .gte("session_date", from)
            .lte("session_date", to)
            .range(offset, offset + PAGE - 1);
          if (ae) throw ae;
          for (const a of page ?? []) {
            if (!consultantIdSet.has(a.staff_id)) continue;
            const c = counts.get(a.staff_id);
            if (!c) continue;
            // SPA: any assignment marked as a SPA duty.
            if (a.duty_type === "spa") c.spa += 1;
            // SAG vs non-SAG only applies to clinical theatre lists actually
            // worked at an NHH (private) theatre. Skip non-theatre duties
            // (admin, SPA, on-call) even if they somehow point at an NHH
            // theatre_session — they are not "lists worked at NHH".
            if (a.duty_type !== "theatre") continue;
            if (!a.theatre_session_id) continue;
            const mark = sagBySession.get(a.theatre_session_id);
            if (!mark) continue; // not an NHH session — ignore for SAG counts
            if (mark.kind === "non_sag") {
              c.nonSag += 1;
              if (mark.reviewed) c.nonSagReviewed += 1;
            } else {
              c.sag += 1;
            }
          }
          if (!page || page.length < PAGE) break;
          offset += PAGE;
        }
      }


      const rows: ConsultantRow[] = (profiles ?? [])
        .map((p) => {
          const c = counts.get(p.id)!;
          return {
            id: p.id,
            full_name: p.full_name ?? p.email ?? "—",
            email: p.email ?? "",
            ...splitName(p.full_name),
            spa: c.spa,
            sag: c.sag,
            nonSag: c.nonSag,
            nonSagReviewed: c.nonSagReviewed,
            nhhTotal: c.sag + c.nonSag,
          };
        })
        .sort(
          (a, b) =>
            (a.surname || "").localeCompare(b.surname || "") ||
            (a.firstName || "").localeCompare(b.firstName || ""),
        );

      return { rows };
    },
  });

  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    if (!filter) return rows;
    const q = filter.toLowerCase();
    return rows.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q),
    );
  }, [data, filter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Consultant audits</h1>
        <p className="text-sm text-muted-foreground">
          Per-consultant SPA, SAG and non-SAG session counts within a chosen
          date range. SAG lists are NHH (private) lists not marked
          &lsquo;non-SAG&rsquo;; non-SAG lists are NHH lists explicitly tagged
          as covered under the consultant&rsquo;s NHS job plan.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-[170px]"
              />
            </div>
            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label htmlFor="filter">Search</Label>
              <Input
                id="filter"
                placeholder="Filter by name or email…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {grantsCheck.isLoading ? (
        <p className="text-sm text-muted-foreground">Checking data access…</p>
      ) : grantsCheck.error ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            Data access health check failed:{" "}
            {(grantsCheck.error as Error).message}
          </CardContent>
        </Card>
      ) : grantsCheck.data && !grantsCheck.data.ok ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 space-y-2 text-sm">
            <p className="font-medium text-destructive">
              Required tables are not reachable via the Data API.
            </p>
            <p className="text-muted-foreground">
              Missing GRANTs for the signed-in role on:{" "}
              <span className="font-mono">
                {grantsCheck.data.missing.join(", ")}
              </span>
              . Ask an administrator to restore the table grants before this
              page can run.
            </p>
            {grantsCheck.data.otherErrors.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Other probe errors:{" "}
                {grantsCheck.data.otherErrors
                  .map((e) => `${e.table}: ${e.message}`)
                  .join("; ")}
              </p>
            )}
          </CardContent>
        </Card>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            Failed to load consultant audits: {(error as Error).message}
          </CardContent>
        </Card>
      ) : !filtered.length ? (
        <p className="text-sm text-muted-foreground">No consultants found.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((r) => (
            <Card key={r.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start gap-2">
                  <div className="rounded-md bg-primary/10 p-2 text-primary">
                    <Stethoscope className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base leading-tight truncate">
                      {r.full_name}
                    </CardTitle>
                    {r.email && (
                      <CardDescription className="truncate text-xs">
                        {r.email}
                      </CardDescription>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <Stat label="SPA sessions" value={r.spa} hint="duty_type = SPA" />
                <Stat
                  label="SAG sessions"
                  value={r.sag}
                  hint="NHH lists (SAG)"
                  tone="primary"
                />
                <Stat
                  label="Non-SAG sessions"
                  value={r.nonSag}
                  hint={
                    r.nonSag > 0
                      ? `NHH lists marked non-SAG (${r.nonSagReviewed}/${r.nonSag} admin-reviewed)`
                      : "NHH lists marked non-SAG"
                  }
                  tone="amber"
                />
                <div className="flex items-center justify-between border-t pt-2 text-xs text-muted-foreground">
                  <span>NHH total</span>
                  <Badge variant="secondary">{r.nhhTotal}</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

type ConsultantRow = {
  id: string;
  full_name: string;
  email: string;
  title?: string;
  firstName?: string;
  surname?: string;
  spa: number;
  sag: number;
  nonSag: number;
  nonSagReviewed: number;
  nhhTotal: number;
};

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "primary" | "amber";
}) {
  const toneClass =
    tone === "primary"
      ? "text-primary"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && (
          <div className="text-[11px] text-muted-foreground">{hint}</div>
        )}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
