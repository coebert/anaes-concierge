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
 */

const NON_CLINICAL_DUTY_TYPES = new Set([
  "spa",
  "admin",
  "teaching",
  "non_clinical",
]);

type SessionHalf = "am" | "pm";

type StaffLite = {
  id: string;
  full_name: string | null;
  grade: "consultant" | "sas" | "trainee" | null;
  training_level: string | null;
};

type PersonEntry = {
  staff: StaffLite;
  duty_types: Set<string>;
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
          .select("staff_id, session, duty_type")
          .eq("session_date", today)
          .in("session", ["am", "pm"]),
        listStaff(),
      ]);
      if (error) throw error;
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
        const bucket = row.session === "am" ? am : pm;
        const existing = bucket.get(row.staff_id);
        if (existing) {
          if (dt) existing.duty_types.add(dt);
        } else {
          bucket.set(row.staff_id, {
            staff: profile,
            duty_types: new Set(dt ? [dt] : []),
          });
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
          <div className="grid gap-6 md:grid-cols-2">
            <SessionColumn title="AM" entries={data.am} />
            <SessionColumn title="PM" entries={data.pm} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SessionColumn({
  title,
  entries,
}: {
  title: string;
  entries: Map<string, PersonEntry>;
}) {
  const list = [...entries.values()];
  const byGrade = new Map<StaffLite["grade"], PersonEntry[]>();
  for (const e of list) {
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
        <span className="text-xs text-muted-foreground">{list.length} staff</span>
      </div>
      {list.length === 0 ? (
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
                        {[...e.duty_types].map((dt) => (
                          <Badge key={dt} variant="secondary" className="text-xs">
                            {dutyLabel(dt)}
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
