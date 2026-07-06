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

export function UpcomingLeaveTab({
  loading,
  allUpcoming,
  profileById,
}: {
  loading: boolean;
  allUpcoming: LeaveRow[];
  profileById: Map<string, ProfileRow>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">All upcoming leave</CardTitle>
        <CardDescription>
          Every approved or pending request ending today or later.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <PageLoading />
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
  );
}
