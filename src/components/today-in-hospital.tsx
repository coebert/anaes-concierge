import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import { todayISO, formatDateGB } from "@/lib/utils";
import { compareBySurname } from "@/lib/name-sort";
import { listActiveStaffSafe } from "@/lib/staff-directory.functions";

/**
 * "Who's in today" — staff assigned to a clinical activity for today's AM/PM
 * sessions, grouped by grade. Non-clinical duty types (SPA, admin, teaching,
 * non-clinical) are excluded so the panel reflects on-site clinical presence.
 *
 * Staff working at NHH (Norfolk House / off-site) are shown in a separate
 * section so it's clear they are not on the Salisbury District Hospital site.
 * Theatre duty rows show the specific theatre name they're allocated to.
 */

const NON_CLINICAL_DUTY_TYPES = new Set([
  "spa",
  "admin",
  "teaching",
  "non_clinical",
]);

type StaffLite = {
  id: string;
  full_name: string | null;
  grade: "consultant" | "sas" | "trainee" | null;
  training_level: string | null;
};

type DutyEntry = { duty_type: string; theatre_name: string | null };

type PersonEntry = {
  staff: StaffLite;
  duties: DutyEntry[];
};

const DUTY_LABEL: Record<string, string> = {
  theatre: "Theatre",
  obstetrics: "Obs",
  obstetrics_2nd: "Obs 2nd",
  icu_trainee: "ICU",
  icu_ct2_plus: "ICU",
  icu_consultant_oncall: "ICU on-call",
  general_consultant_oncall: "Gen on-call",
  consultant_in_charge: "In charge",
  registrar_oncall: "Reg on-call",
  sho_oncall: "SHO on-call",
  nhh_oncall: "NHH on-call",
};

function dutyLabel(dt: string): string {
  return DUTY_LABEL[dt] ?? dt.replace(/_/g, " ");
}

function gradeLabel(g: StaffLite["grade"]): string {
  if (g === "consultant") return "Consultants";
  if (g === "sas") return "SAS Doctors";
  if (g === "trainee") return "Trainees";
  return "Other";
}

function isNhhTheatre(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^\s*NHH\b/i.test(name);
}

const GRADE_ORDER: Array<StaffLite["grade"]> = ["consultant", "sas", "trainee", null];

export function TodayInHospital() {
  const today = todayISO();
  const listStaff = useServerFn(listActiveStaffSafe);

  const { data, isLoading } = useQuery({
    queryKey: ["today-in-hospital", today],
    queryFn: async () => {
      const [{ data: rota, error }, staff] = await Promise.all([
        supabase
          .from("rota_assignments")
          .select("staff_id, session, duty_type, theatre_session_id")
          .eq("session_date", today)
          .in("session", ["am", "pm"]),
        listStaff(),
      ]);
      if (error) throw error;

      // Resolve theatre names for any theatre sessions referenced today.
      const tsIds = Array.from(
        new Set(
          (rota ?? [])
            .map((r) => r.theatre_session_id)
            .filter((x): x is string => !!x),
        ),
      );
      const theatreByTsId = new Map<string, string | null>();
      if (tsIds.length) {
        const { data: tsRows, error: tsErr } = await supabase
          .from("theatre_sessions")
          .select("id, theatre:theatres(name)")
          .in("id", tsIds);
        if (tsErr) throw tsErr;
        for (const r of (tsRows ?? []) as Array<{
          id: string;
          theatre: { name: string | null } | null;
        }>) {
          theatreByTsId.set(r.id, r.theatre?.name ?? null);
        }
      }

      const byId = new Map<string, StaffLite>(
        (staff ?? []).map((s) => [s.id, s as StaffLite]),
      );
      const am = new Map<string, PersonEntry>();
      const pm = new Map<string, PersonEntry>();
      for (const row of rota ?? []) {
        const dt = row.duty_type ?? "";
        if (NON_CLINICAL_DUTY_TYPES.has(dt)) continue;
        const profile = byId.get(row.staff_id);
        if (!profile) continue;
        const theatreName = row.theatre_session_id
          ? theatreByTsId.get(row.theatre_session_id) ?? null
          : null;
        const bucket = row.session === "am" ? am : pm;
        const existing = bucket.get(row.staff_id);
        const duty: DutyEntry = { duty_type: dt, theatre_name: theatreName };
        if (existing) {
          // Deduplicate identical duty entries.
          const dup = existing.duties.some(
            (d) => d.duty_type === duty.duty_type && d.theatre_name === duty.theatre_name,
          );
          if (!dup) existing.duties.push(duty);
        } else {
          bucket.set(row.staff_id, { staff: profile, duties: [duty] });
        }
      }
      return { am, pm };
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">In hospital today</CardTitle>
            <CardDescription className="text-xs">
              {formatDateGB(today)} · staff assigned to a clinical activity
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data || (data.am.size === 0 && data.pm.size === 0) ? (
          <p className="text-sm text-muted-foreground">
            No clinical assignments recorded for today.
          </p>
        ) : (
          <div className="space-y-6">
            <SiteBlock
              title="Salisbury District Hospital"
              subtitle="On-site clinical activity"
              am={data.am}
              pm={data.pm}
              site="sdh"
            />
            <SiteBlock
              title="New Hall Hospital (NHH)"
              subtitle="Off-site — not at Salisbury District Hospital"
              am={data.am}
              pm={data.pm}
              site="nhh"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function isNhhDuty(d: DutyEntry): boolean {
  return d.duty_type === "nhh_oncall" || isNhhTheatre(d.theatre_name);
}

function partitionForSite(
  entries: Map<string, PersonEntry>,
  site: "sdh" | "nhh",
): PersonEntry[] {
  const out: PersonEntry[] = [];
  for (const e of entries.values()) {
    const matching = e.duties.filter((d) =>
      site === "nhh" ? isNhhDuty(d) : !isNhhDuty(d),
    );
    if (matching.length) out.push({ staff: e.staff, duties: matching });
  }
  return out;
}

function SiteBlock({
  title,
  subtitle,
  am,
  pm,
  site,
}: {
  title: string;
  subtitle: string;
  am: Map<string, PersonEntry>;
  pm: Map<string, PersonEntry>;
  site: "sdh" | "nhh";
}) {
  const amList = partitionForSite(am, site);
  const pmList = partitionForSite(pm, site);
  if (amList.length === 0 && pmList.length === 0) {
    return (
      <section>
        <SiteHeader title={title} subtitle={subtitle} />
        <p className="text-sm text-muted-foreground">
          No {site === "nhh" ? "NHH" : "on-site"} clinical assignments today.
        </p>
      </section>
    );
  }
  return (
    <section>
      <SiteHeader title={title} subtitle={subtitle} />
      <div className="grid gap-6 md:grid-cols-2">
        <SessionColumn title="AM" entries={amList} />
        <SessionColumn title="PM" entries={pmList} />
      </div>
    </section>
  );
}

function SiteHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-3 border-b pb-1">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function SessionColumn({
  title,
  entries,
}: {
  title: string;
  entries: PersonEntry[];
}) {
  const byGrade = new Map<StaffLite["grade"], PersonEntry[]>();
  for (const e of entries) {
    const k = e.staff.grade ?? null;
    const arr = byGrade.get(k) ?? [];
    arr.push(e);
    byGrade.set(k, arr);
  }
  for (const arr of byGrade.values()) {
    arr.sort((a, b) => compareBySurname(a.staff.full_name, b.staff.full_name));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        <span className="text-xs text-muted-foreground">{entries.length} staff</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assignments.</p>
      ) : (
        <div className="space-y-4">
          {GRADE_ORDER.map((g) => {
            const arr = byGrade.get(g);
            if (!arr || arr.length === 0) return null;
            return (
              <div key={String(g)}>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {gradeLabel(g)} ({arr.length})
                </div>
                <ul className="space-y-1">
                  {arr.map((e) => (
                    <li
                      key={e.staff.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-2 py-1.5 text-sm"
                    >
                      <span className="font-medium">
                        {e.staff.full_name ?? "—"}
                        {e.staff.training_level &&
                        e.staff.training_level !== "Consultant" ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {e.staff.training_level}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {e.duties.map((d, i) => (
                          <Badge
                            key={`${d.duty_type}-${d.theatre_name ?? ""}-${i}`}
                            variant="secondary"
                            className="text-xs"
                          >
                            {d.duty_type === "theatre" && d.theatre_name
                              ? d.theatre_name
                              : d.theatre_name &&
                                  d.duty_type !== "nhh_oncall"
                                ? `${dutyLabel(d.duty_type)} · ${d.theatre_name}`
                                : dutyLabel(d.duty_type)}
                          </Badge>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
