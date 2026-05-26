import { createFileRoute, Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, MessageSquare, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/chat")({
  component: ChatLayout,
});

function ChatLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { conversationId?: string };
  const activeId = params.conversationId;

  const { data: conversations } = useQuery({
    queryKey: ["ai-conversations"],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_conversations")
        .select("id,title,updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const createConv = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("ai_conversations")
        .insert({ user_id: user.id, title: "New conversation" })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: async (id) => {
      await qc.invalidateQueries({ queryKey: ["ai-conversations"] });
      void navigate({ to: "/chat/$conversationId", params: { conversationId: id } });
    },
  });

  const deleteConv = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("ai_conversations").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: async (id) => {
      await qc.invalidateQueries({ queryKey: ["ai-conversations"] });
      if (activeId === id) void navigate({ to: "/chat" });
    },
  });

  // Auto-create a conversation if none exists and we're on the empty route
  useEffect(() => {
    if (!activeId && conversations && conversations.length === 0 && !createConv.isPending) {
      createConv.mutate();
    }
  }, [activeId, conversations, createConv]);

  return (
    <div className="grid h-[calc(100vh-5rem)] grid-cols-[260px_1fr] gap-4 -m-4 md:-m-8 md:p-4">
      <aside className="flex flex-col rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b p-3">
          <div>
            <div className="text-sm font-semibold">AI assistant</div>
            <div className="text-xs text-muted-foreground">Ask about rota & leave</div>
          </div>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => createConv.mutate()}
            disabled={createConv.isPending}
            title="New conversation"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <ul className="space-y-0.5 p-2">
            {(conversations ?? []).map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id} className="group relative">
                  <Link
                    to="/chat/$conversationId"
                    params={{ conversationId: c.id }}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-md px-2 py-2 pr-8 text-sm transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <span className="flex items-center gap-1.5 truncate font-medium">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{c.title || "Untitled"}</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(c.updated_at), { addSuffix: true })}
                    </span>
                  </Link>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      if (confirm("Delete this conversation?")) deleteConv.mutate(c.id);
                    }}
                    className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
            {conversations?.length === 0 && (
              <li className="px-2 py-4 text-center text-xs text-muted-foreground">
                No conversations yet.
              </li>
            )}
          </ul>
        </ScrollArea>
      </aside>

      <section className="flex min-h-0 flex-col rounded-lg border bg-card">
        <Outlet />
      </section>
    </div>
  );
}
