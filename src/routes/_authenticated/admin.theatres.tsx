import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/admin/theatres")({
  component: AdminTheatresPage,
});

function AdminTheatresPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["theatres"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("theatres")
        .select("id,name,kind,active,sort_order")
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Theatres</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Theatre list</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ul className="divide-y">
              {data?.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-medium">{t.name}</span>
                  <Badge variant={t.kind === "main" ? "outline" : "secondary"}>{t.kind}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
