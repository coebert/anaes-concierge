import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  DOW_LABEL,
  type ConsultantPattern,
} from "@/features/audit/list-feasibility";

export function WorkingPatternsCard({
  patterns,
  regularMinPct,
}: {
  patterns: ConsultantPattern[];
  regularMinPct: number;
}) {
  if (patterns.length === 0) return null;
  const DAYS = [1, 2, 3, 4, 5];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Consultant working patterns</CardTitle>
        <CardDescription>
          For each consultant, the percentage of Mon–Fri half-days{" "}
          <strong>within their own tenure in the data window</strong> on which
          CLWRota recorded them as covering a theatre list (clinical activity).
          Each consultant's denominator is scoped to the first and last date
          they appear in the rota inside the window, so recent joiners and
          leavers are not artificially diluted. Weeks containing on-call are
          still included in the denominator. Cells highlighted in green are
          at or above the regular-working threshold ({regularMinPct}%).
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Consultant</th>
              <th className="px-2 py-1 text-left font-medium whitespace-nowrap">Tenure in window</th>
              {DAYS.map((d) => (
                <th key={d} className="px-1 py-1 text-center font-medium" colSpan={2}>
                  {DOW_LABEL[d]}
                </th>
              ))}
              <th className="px-2 py-1 text-center font-medium">Reg /wk</th>
            </tr>
            <tr className="text-[10px]">
              <th />
              <th />
              {DAYS.flatMap((d) => [
                <th key={`${d}-am`} className="px-1 py-0.5 text-center font-normal">AM</th>,
                <th key={`${d}-pm`} className="px-1 py-0.5 text-center font-normal">PM</th>,
              ])}
              <th />
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="px-2 py-1 whitespace-nowrap">{p.name}</td>
                <td className="px-2 py-1 whitespace-nowrap text-[11px] text-muted-foreground">
                  {p.tenureStart && p.tenureEnd ? (
                    <>
                      {p.tenureStart} → {p.tenureEnd}
                      <span className="ml-1 text-muted-foreground/70">
                        ({p.tenureWeekdays} wd)
                      </span>
                    </>
                  ) : (
                    <span className="italic">no data</span>
                  )}
                </td>
                {p.cells.map((c) => (
                  <td
                    key={`${c.dow}-${c.session}`}
                    className={cn(
                      "px-1 py-1 text-center font-mono text-[11px]",
                      c.regularDayOff
                        ? "bg-muted/40 text-muted-foreground italic"
                        : c.regular
                          ? "bg-emerald-100 text-emerald-800"
                          : c.workingPct >= regularMinPct - 15
                            ? "bg-amber-50 text-warning"
                            : "text-muted-foreground",
                    )}
                    title={
                      c.regularDayOff
                        ? "Regular non-working day — excluded from working-pattern denominator"
                        : `Clinical activity ${c.workingOccurrences}/${c.totalOccurrences} weekdays in tenure (on-call on ${c.oncallOccurrences})`
                    }
                  >
                    {c.regularDayOff ? "off" : `${c.workingPct}%`}
                  </td>
                ))}
                <td className="px-2 py-1 text-center font-medium">
                  {p.regularSessionsPerWeek}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
