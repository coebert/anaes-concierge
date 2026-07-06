import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  listAccessRequests, decideAccessRequest, deleteAccessRequest,
} from "@/features/access-requests/admin-access-requests.functions";
import { toast } from "sonner";
import { Check, X, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/access-requests")({
  head: () => ({ meta: [{ title: "Access requests — Salisbury Anaesthetics Rota" }] }),
  component: AdminAccessRequestsPage,
});

function AdminAccessRequestsPage() {
  const list = useServerFn(listAccessRequests);
  const decide = useServerFn(decideAccessRequest);
  const remove = useServerFn(deleteAccessRequest);
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["access-requests"],
    queryFn: () => list(),
  });

  const decideMut = useMutation({
    mutationFn: (vars: { id: string; decision: "approved" | "declined" }) =>
      decide({ data: { ...vars, send_invite: true } }),
    onSuccess: (res, vars) => {
      if (res?.error) {
        toast.error(res.error);
        return;
      }
      toast.success(
        vars.decision === "approved"
          ? res?.inviteError
            ? `Approved, but invite email failed: ${res.inviteError}`
            : "Approved and invitation sent"
          : "Request declined",
      );
      void qc.invalidateQueries({ queryKey: ["access-requests"] });
    },
    onError: () => toast.error("Could not update request"),
    onSettled: () => setBusyId(null),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => {
      toast.success("Request removed");
      void qc.invalidateQueries({ queryKey: ["access-requests"] });
    },
    onError: () => toast.error("Could not remove request"),
    onSettled: () => setBusyId(null),
  });

  const requests = data?.requests ?? [];
  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Access requests</h1>
        <p className="text-sm text-muted-foreground">
          Approve people who have requested access. Approving sends them an invitation email.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending ({pending.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending requests.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="w-40 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.full_name}</TableCell>
                    <TableCell>{r.email}</TableCell>
                    <TableCell className="max-w-sm whitespace-pre-wrap text-sm text-muted-foreground">
                      {r.message || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        size="sm"
                        disabled={busyId === r.id}
                        onClick={() => {
                          setBusyId(r.id);
                          decideMut.mutate({ id: r.id, decision: "approved" });
                        }}
                      >
                        <Check className="mr-1 h-4 w-4" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === r.id}
                        onClick={() => {
                          setBusyId(r.id);
                          decideMut.mutate({ id: r.id, decision: "declined" });
                        }}
                      >
                        <X className="mr-1 h-4 w-4" /> Decline
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History ({decided.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {decided.length === 0 ? (
            <p className="text-sm text-muted-foreground">No prior decisions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Decided</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {decided.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.full_name}</TableCell>
                    <TableCell>{r.email}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "approved" ? "default" : "secondary"}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.decided_at ? new Date(r.decided_at).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={busyId === r.id}
                        onClick={() => {
                          setBusyId(r.id);
                          removeMut.mutate(r.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
