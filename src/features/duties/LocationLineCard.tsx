import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorNotice } from "@/components/query-state-notice";
import { pagedSelect } from "@/lib/paged-select";
import { formatDateGB } from "@/lib/utils";
import {
  buildLocationCells,
  LOCATION_HALVES,
  type LocationAssignment,
  type LocationSession,
} from "./location-line";

const HALF_LABEL = { am: "AM", pm: "PM" } as const;

/**
 * Read-only line for one theatre location (matched by its exact name, as on
 * the rota grids). People are linked to the location's lists on the theatre
 * rota, so changes are made there, not here.
 */
export function LocationLineCard({
  locationName,
  days,
  isoOf,
  staffName,
}: {
  locationName: string;
  days: Date[];
  isoOf: (d: Date) => string;
  staffName: (id: string) => string;
}) {
  const startIso = isoOf(days[0]);
  const endIso = isoOf(days[days.length - 1]);

  const q = useQuery({
    queryKey: ["duties-location-line", locationName, startIso, endIso],
    queryFn: async () => {
      const theatres = await pagedSelect<{ id: string; name: string }>("theatres", "id,name", {
        filter: (f) => f.eq("active", true),
        order: ["id"],
        source: "theatres",
      });
      const want = locationName.trim().toLowerCase();
      const ids = theatres.filter((t) => t.name.trim().toLowerCase() === want).map((t) => t.id);
      if (ids.length === 0) return { found: false as const };
      const sessions = await pagedSelect<LocationSession>(
        "theatre_sessions",
        "id,session_date,session",
        {
          filter: (f) =>
            f.in("theatre_id", ids).gte("session_date", startIso).lte("session_date", endIso),
          order: ["session_date", "id"],
          source: "theatre_sessions",
        },
      );
      const sessionIds = sessions.map((s) => s.id);
      const assignments: LocationAssignment[] = [];
      for (let i = 0; i < sessionIds.length; i += 500) {
        const chunk = sessionIds.slice(i, i + 500);
        assignments.push(
          ...(await pagedSelect<LocationAssignment>(
            "rota_assignments",
            "id,staff_id,theatre_session_id",
            { filter: (f) => f.in("theatre_session_id", chunk), order: ["id"] },
          )),
        );
      }
      return { found: true as const, sessions, assignments };
    },
  });

  const data = q.data;
  const cellAt = data?.found ? buildLocationCells(data.sessions, data.assignments) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{locationName}</CardTitle>
        <CardDescription>
          Location line, as on the rota grids. People are linked to {locationName} lists on the{" "}
          <Link to="/coordinator/rota" className="underline">
            theatre rota
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 overflow-x-auto">
        {q.error ? (
          <QueryErrorNotice
            error={q.error}
            onRetry={() => void q.refetch()}
            what={`the ${locationName} line`}
            stale={!!data}
          />
        ) : null}
        {q.isPending ? (
          <p className="text-xs text-muted-foreground">Loading {locationName}…</p>
        ) : data && !data.found ? (
          <p className="text-xs text-muted-foreground">
            No active location called {locationName} in the app.
          </p>
        ) : cellAt ? (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-24 p-2 text-left font-medium text-muted-foreground">Slot</th>
                {days.map((d, i) => (
                  <th key={i} className="border-l p-2 text-left font-medium">
                    {/* eslint-disable-next-line no-restricted-syntax */}
                    <div>{d.toLocaleDateString("en-GB", { weekday: "short" })}</div>
                    <div className="text-muted-foreground">
                      {formatDateGB(isoOf(d)).slice(0, 5)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LOCATION_HALVES.map((half) => (
                <tr key={half} className="border-t">
                  <td className="p-2 align-top text-muted-foreground">{HALF_LABEL[half]}</td>
                  {days.map((d, i) => {
                    const cell = cellAt(isoOf(d), half);
                    return (
                      <td key={i} className="border-l p-1 align-top">
                        {cell.kind === "no_list" ? (
                          <span className="px-2 text-muted-foreground">—</span>
                        ) : cell.staffIds.length === 0 ? (
                          <span className="block rounded border border-dashed px-2 py-1 text-muted-foreground">
                            List, nobody linked
                          </span>
                        ) : (
                          <div className="space-y-1">
                            {cell.staffIds
                              .map((id) => staffName(id))
                              .sort()
                              .map((name, j) => (
                                <div key={j} className="truncate rounded bg-muted px-2 py-1">
                                  {name}
                                </div>
                              ))}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </CardContent>
    </Card>
  );
}
