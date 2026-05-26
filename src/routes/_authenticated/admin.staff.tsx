import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/admin/staff")({
  component: AdminStaffPage,
});

function AdminStaffPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id,email,full_name,grade,training_level,active")
        .order("full_name");
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All registered users</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data?.length ? (
            <p className="text-sm text-muted-foreground">No staff records yet.</p>
          ) : (
            <ul className="divide-y">
              {data.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <div className="font-medium">{p.full_name || p.email}</div>
                    <div className="text-xs text-muted-foreground">{p.email}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.grade && <Badge variant="outline">{p.grade}</Badge>}
                    {p.training_level && <Badge variant="secondary">{p.training_level}</Badge>}
                    {!p.active && <Badge variant="destructive">inactive</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-muted-foreground">
            Full staff & job-plan editing is the next iteration.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
