import { Button } from "@/components/ui/button";
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
import { Trash2 } from "lucide-react";
import { formatDateGB } from "@/lib/utils";
import { statusVariant, type LeaveRow } from "./shared";

/**
 * Tab-trigger label for the "My leave" tab. Coordinators/admins see a
 * "Personal view" badge after the label so it's obvious the tab is scoped
 * to their own requests even though they have org-wide visibility.
 * Exported so UI tests can render it in isolation.
 */
export function MyLeaveTabLabel({ isCoordinatorOrAdmin }: { isCoordinatorOrAdmin: boolean }) {
  return (
    <>
      My leave
      {isCoordinatorOrAdmin && (
        <Badge variant="outline" className="text-xs font-normal">Personal view</Badge>
      )}
    </>
  );
}

/**
 * Description copy shown at the top of the "My leave" tab. Coordinators/
 * admins get an explainer that the tab is intentionally scoped to their own
 * requests and where to look for org-wide leave. Exported for UI tests.
 */
export function MyLeaveDescription({ isCoordinatorOrAdmin }: { isCoordinatorOrAdmin: boolean }) {
  return (
    <>
      {isCoordinatorOrAdmin
        ? "This tab shows only your own requests. As a coordinator/admin, you can also view other staff leave records in the Department calendar and All upcoming tabs."
        : "All your leave requests and their current status."}
    </>
  );
}

export function MyLeaveTab({
  loading,
  myRows,
  isCoordinatorOrAdmin,
  onCancel,
}: {
  loading: boolean;
  myRows: LeaveRow[];
  isCoordinatorOrAdmin: boolean;
  onCancel: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My leave</CardTitle>
        <CardDescription>
          <MyLeaveDescription isCoordinatorOrAdmin={isCoordinatorOrAdmin} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : myRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dates</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {myRows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    {formatDateGB(r.start_date)}
                    {r.half_day_start ? ` (${r.half_day_start === "am" ? "PM only" : "AM only"})` : ""}
                    {" → "}
                    {formatDateGB(r.end_date)}
                    {r.half_day_end ? ` (${r.half_day_end} only)` : ""}
                  </TableCell>
                  <TableCell className="capitalize">{r.type}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(r.status)} className="capitalize">
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-sm">
                    {r.conflict_notes && <div className="text-warning">⚠ {r.conflict_notes}</div>}
                    {r.decision_notes && <div>{r.decision_notes}</div>}
                    {r.reason && <div className="italic">{r.reason}</div>}
                  </TableCell>
                  <TableCell>
                    {r.status === "pending" && (
                      <Button variant="ghost" size="icon" onClick={() => onCancel(r.id)} title="Cancel">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
