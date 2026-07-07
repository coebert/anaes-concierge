import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ChevronRight } from "lucide-react";
import { formatDateWithWeekdayGB, parseDateLocal } from "@/lib/utils";
import {
  computeWeekBlockingCompetencyIssues,
  type WeekAssignmentLike,
  type TheatreSessionLike,
  type TheatreLike,
  type StaffLike,
} from "@/features/competencies/week-blockers";
import type {
  Competency,
  CompetencyRequirement,
  StaffCompetency,
} from "@/features/competencies/competencies";

/**
 * Summary panel for the rota editor: scans all am/pm assignments in the
 * visible week and lists every blocking competency issue, grouped by staff.
 * Only renders when there is at least one blocker.
 */
export function CompetencyBlockersPanel({
  assignments, theatreSessions, theatres, staff,
  onSelectCell,
}: {
  assignments: WeekAssignmentLike[];
  theatreSessions: TheatreSessionLike[];
  theatres: TheatreLike[];
  staff: StaffLike[];
  onSelectCell?: (a: { theatreId: string; date: string; session: "am" | "pm" }) => void;
}) {
  const { data: competencies } = useQuery({
    queryKey: ["competencies-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("competencies")
        .select("id,code,name,description,category,applies_to_grades,active,sort_order")
        .eq("active", true);
      if (error) throw error;
      return (data ?? []) as Competency[];
    },
  });
  const { data: requirements } = useQuery({
    queryKey: ["specialty-competency-requirements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("specialty_competency_requirements")
        .select("id,specialty_id,competency_id,requirement,applies_to_role");
      if (error) throw error;
      return (data ?? []) as CompetencyRequirement[];
    },
  });
  const { data: holdings } = useQuery({
    queryKey: ["staff-competencies-all-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_competencies")
        .select("id,staff_id,competency_id,level,granted_at,expires_at,revoked_at,notes");
      if (error) throw error;
      return (data ?? []) as StaffCompetency[];
    },
  });

  const groups = useMemo(() => {
    if (!competencies || !requirements || !holdings) return [];
    return computeWeekBlockingCompetencyIssues({
      assignments, theatreSessions, theatres, staff,
      competencies, requirements, staffCompetencies: holdings,
    });
  }, [assignments, theatreSessions, theatres, staff, competencies, requirements, holdings]);

  if (!competencies || !requirements || !holdings) return null;
  if (groups.length === 0) return null;

  const total = groups.reduce((n, g) => n + g.issues.length, 0);

  return (
    <Card className="border-destructive/40">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 text-destructive">
          <ShieldAlert className="h-4 w-4" />
          Blocking competency issues
          <Badge variant="destructive" className="ml-1">{total}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Assignments this week where the staff member lacks a required sign-off for the list's
          specialty. These would be blocked in the cell editor.
        </p>
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.staffId} className="rounded-md border p-3">
              <div className="text-sm font-medium mb-2">
                {g.staffName}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  ({g.issues.length} session{g.issues.length === 1 ? "" : "s"})
                </span>
              </div>
              <ul className="space-y-2">
                {g.issues.map((it) => {
                  const dateLabel = (() => {
                    const d = parseDateLocal(it.date);
                    return d ? formatDateWithWeekdayGB(d) : it.date;
                  })();
                  const clickable = onSelectCell && it.theatreId;
                  return (
                    <li
                      key={it.assignmentId}
                      className={
                        clickable
                          ? "text-xs rounded p-2 bg-muted/40 hover:bg-muted cursor-pointer transition-colors"
                          : "text-xs rounded p-2 bg-muted/40"
                      }
                      onClick={
                        clickable
                          ? () => onSelectCell!({
                              theatreId: it.theatreId!,
                              date: it.date,
                              session: it.session as "am" | "pm",
                            })
                          : undefined
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {it.session}
                          </Badge>
                          <span className="font-medium">{dateLabel}</span>
                          <span className="text-muted-foreground">·</span>
                          <span>{it.theatreName}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="capitalize">{it.role}</span>
                        </div>
                        {clickable && (
                          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                      </div>
                      <ul className="mt-1 ml-1 list-disc list-inside text-destructive">
                        {it.messages.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
