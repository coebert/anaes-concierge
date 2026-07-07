import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/loading";
import { RecognitionDialog, RECOGNITION_CATEGORIES } from "@/components/wellbeing/RecognitionDialog";
import { Sparkles } from "lucide-react";
import { formatDateWithWeekdayGB } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/recognition")({
  head: () => ({
    meta: [
      { title: "Recognition — Salisbury Anaesthetics" },
      { name: "description", content: "Peer kudos and recognition feed." },
    ],
  }),
  component: RecognitionPage,
});

const CATEGORY_LABEL = Object.fromEntries(
  RECOGNITION_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<string, string>;

function RecognitionPage() {
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["recognition-feed"],
    queryFn: async () => {
      const [feedRes, profilesRes] = await Promise.all([
        supabase.rpc("get_recognition_decrypted", { p_limit: 100 }),
        supabase.from("profiles").select("id,full_name,email"),
      ]);
      if (feedRes.error) throw feedRes.error;
      if (profilesRes.error) throw profilesRes.error;
      const nameById = new Map(
        (profilesRes.data ?? []).map((p) => [
          p.id,
          p.full_name || p.email || "Unknown",
        ]),
      );
      return {
        entries: (feedRes.data ?? []) as Array<{
          id: string;
          staff_id: string;
          from_user_id: string;
          category: string;
          message: string | null;
          is_public: boolean;
          created_at: string;
        }>,
        nameById,
      };
    },
  });

  if (isLoading) return <PageLoading />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recognition"
        description="Peer kudos across the department. Public messages appear here; private kudos are visible only to the recipient."
      />

      <div className="flex justify-end">
        <Button onClick={() => setDialogOpen(true)}>
          <Sparkles className="mr-2 h-4 w-4" /> Send a kudos
        </Button>
      </div>

      {data && data.entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No recognition yet. Be the first to send a kudos.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data?.entries.map((e) => (
            <Card key={e.id}>
              <CardContent className="p-4">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">
                    {data.nameById.get(e.from_user_id) ?? "Someone"}
                  </span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-medium">
                    {data.nameById.get(e.staff_id) ?? "Colleague"}
                  </span>
                  <Badge variant="secondary" className="capitalize">
                    {CATEGORY_LABEL[e.category] ?? e.category}
                  </Badge>
                  {!e.is_public && (
                    <Badge variant="outline" className="text-xs">Private</Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDateWithWeekdayGB(e.created_at.slice(0, 10))}
                  </span>
                </div>
                <div className="text-sm">
                  {e.message ?? <em className="text-muted-foreground">Message unavailable.</em>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <RecognitionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => refetch()}
      />
    </div>
  );
}
