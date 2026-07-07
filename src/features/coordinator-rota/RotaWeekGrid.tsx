import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn, formatDateWithWeekdayGB } from "@/lib/utils";
import { specialtyTone } from "@/lib/specialty-colors";
import { SessionChip } from "@/components/rota-views";
import type { Profile } from "@/lib/rota-validation";
import type { SessionHalf, WeekAssignment } from "./types";

type Theatre = { id: string; name: string; kind: string | null; sort_order: number | null };
type TheatreSession = {
  id: string;
  theatre_id: string;
  session: string;
  session_date: string;
  surgical_consultant: string | null;
  specialty_id: string | null;
  is_non_sag: boolean | null;
};

function iso(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function fmt(d: Date) {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function RotaWeekGrid({
  days,
  theatres,
  theatreSessions,
  assignments,
  staff,
  specialtiesList,
  onCellClick,
}: {
  days: Date[];
  theatres: Theatre[] | undefined;
  theatreSessions: TheatreSession[] | undefined;
  assignments: WeekAssignment[] | undefined;
  staff: Profile[] | undefined;
  specialtiesList: { id: string; name: string }[] | undefined;
  onCellClick: (t: { theatreId: string; date: string; session: SessionHalf }) => void;
}) {
  const staffById = (id: string | null) => staff?.find((s) => s.id === id);
  const staffName = (id: string | null) => staffById(id)?.full_name ?? "—";
  const gradeRank = (g: string | null | undefined) =>
    g === "consultant" ? 0 : g === "sas" ? 1 : g === "trainee" ? 2 : 3;
  const specialtyName = (id: string | null) =>
    id ? specialtiesList?.find((s) => s.id === id)?.name : undefined;

  const cellSession = (theatreId: string, date: string, session: SessionHalf) =>
    theatreSessions?.find(
      (s) => s.theatre_id === theatreId && s.session_date === date && s.session === session,
    );

  const cellAssignments = (theatreSessionId: string | undefined) => {
    const list = theatreSessionId
      ? assignments?.filter((a) => a.theatre_session_id === theatreSessionId) ?? []
      : [];
    return [...list].sort(
      (a, b) => gradeRank(staffById(a.staff_id)?.grade) - gradeRank(staffById(b.staff_id)?.grade),
    );
  };

  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              <th className="border-b border-r p-2 text-left font-medium w-28">Theatre</th>
              {days.map((d) => (
                <th key={iso(d)} colSpan={2} className="border-b border-r p-2 text-center font-medium">
                  {fmt(d)}
                </th>
              ))}
            </tr>
            <tr className="text-muted-foreground">
              <th className="border-b border-r p-1"></th>
              {days.flatMap((d) => [
                <th key={iso(d) + "am"} className="border-b p-1 font-normal">
                  <SessionChip half="am" />
                </th>,
                <th key={iso(d) + "pm"} className="border-b border-r p-1 font-normal">
                  <SessionChip half="pm" />
                </th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {theatres?.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="border-r p-2 font-medium whitespace-nowrap">
                  {t.name}
                  <div className="text-[10px] text-muted-foreground">
                    {t.kind === "main" ? "Main" : "Day surgery"}
                  </div>
                </td>
                {days.flatMap((d) =>
                  (["am", "pm"] as SessionHalf[]).map((s) => {
                    const ts = cellSession(t.id, iso(d), s);
                    const assigns = cellAssignments(ts?.id);
                    const isPm = s === "pm";
                    const spec = specialtyName(ts?.specialty_id ?? null);
                    const tone = specialtyTone(spec);
                    return (
                      <td
                        key={t.id + iso(d) + s}
                        onClick={() =>
                          onCellClick({ theatreId: t.id, date: iso(d), session: s })
                        }
                        className={cn(
                          "min-w-[110px] cursor-pointer border-b p-1.5 hover:bg-accent/40",
                          isPm ? "border-r" : "border-r border-r-border/30",
                          ts && tone.cell,
                        )}
                      >
                        {ts ? (
                          <div className="space-y-1">
                            {ts.is_non_sag && (
                              <Badge
                                variant="outline"
                                className="text-[9px] border-amber-500/60 bg-warning-muted text-warning"
                                title="NHH list covered as part of NHS job plan (non-SAG)"
                              >
                                Non-SAG
                              </Badge>
                            )}
                            {spec && (
                              <div className={cn("font-medium truncate", tone.label)}>{spec}</div>
                            )}
                            {ts.surgical_consultant && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {ts.surgical_consultant}
                              </div>
                            )}
                            {(() => {
                              const hasSeniorCover = assigns.some((x) => {
                                const g = staffById(x.staff_id)?.grade;
                                return g === "consultant" || g === "sas";
                              });
                              return assigns.map((a) => {
                                const sp = staffById(a.staff_id);
                                const isConsultant = sp?.grade === "consultant";
                                const isTrainee = sp?.grade === "trainee";
                                const isSoloTrainee =
                                  isTrainee &&
                                  a.role_on_list === "solo" &&
                                  !hasSeniorCover;
                                const showRoleBadge =
                                  a.role_on_list !== "solo" || isSoloTrainee;
                                return (
                                  <div
                                    key={a.id}
                                    className={cn(
                                      "truncate text-[10px]",
                                      isConsultant && "font-bold",
                                      isSoloTrainee && "text-blue-600 dark:text-blue-400",
                                    )}
                                  >
                                    {showRoleBadge && (
                                      <Badge
                                        variant={a.role_on_list === "supervising" ? "default" : "outline"}
                                        className="mr-1 px-1 py-0 text-[9px]"
                                      >
                                        {a.role_on_list}
                                      </Badge>
                                    )}
                                    {staffName(a.staff_id)}
                                    {isTrainee ? ` (${sp?.training_level || "Level unknown"})` : ""}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        ) : (
                          <div className="text-muted-foreground/60 text-[10px]">+ add</div>
                        )}
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
