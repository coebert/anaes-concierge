import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateGB } from "@/lib/utils";
import {
import { PageLoading } from "@/components/loading";
  gradeLabel,
  statusVariant,
  type LeaveRow,
  type ProfileRow,
} from "./shared";

export type SickRow = LeaveRow & { _isRetrospective: boolean; _daysLate: number };

export function SickLeaveTab({
  loading,
  sickRows,
  recentlyAddedSick,
  profileById,
}: {
  loading: boolean;
  sickRows: SickRow[];
  recentlyAddedSick: SickRow[];
  profileById: Map<string, ProfileRow>;
}) {
  return (
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
          <PageLoading />
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
                        {isNew && <Badge variant="secondary">New</Badge>}
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
  );
}
