import { createFileRoute, Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, MessageSquare, Trash2, PanelLeft } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({ meta: [{ title: "Chat — Salisbury Anaesthetics Rota" }] }),
  component: ChatLayout,
});

function ChatLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const params = useParams({ strict: false }) as { conversationId?: string };
  const activeId = params.conversationId;

  const {
    data: conversations,
    error: convError,
    refetch: refetchConvs,
  } = useQuery({
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
      setListOpen(false);
      await qc.invalidateQueries({ queryKey: ["ai-conversations"] });
      void navigate({ to: "/chat/$conversationId", params: { conversationId: id } });
    },
    onError: (e) =>
      toast.error(`Couldn't start a conversation: ${e instanceof Error ? e.message : String(e)}`),
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
    onError: (e) => toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`),
  });

  // Auto-create AT MOST ONCE per visit. A failed insert must not retry in a
  // loop — the user gets an error and an explicit retry button instead.
  const autoCreateTried = useRef(false);
  const [listOpen, setListOpen] = useState(false);
  const { mutate: createMutate, isPending: creating, isError: createFailed } = createConv;
  useEffect(() => {
    if (autoCreateTried.current) return;
    if (!activeId && conversations && conversations.length === 0) {
      autoCreateTried.current = true;
      createMutate();
    }
  }, [activeId, conversations, createMutate]);

  const sidebar = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">AI assistant</div>
          <div className="text-xs text-muted-foreground">Ask about rota & leave</div>
        </div>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={() => createMutate()}
          disabled={creating}
          title="New conversation"
          aria-label="New conversation"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {createFailed && (
        <div role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          Couldn't start a conversation.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => createMutate()}
            disabled={creating}
          >
            Try again
          </button>
        </div>
      )}
      <ScrollArea className="flex-1">
        <ul className="space-y-0.5 p-2">
          {(conversations ?? []).map((c) => {
            const active = c.id === activeId;
            return (
              <li key={c.id} className="group relative">
                <Link
                  onClick={() => setListOpen(false)}
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
                  type="button"
                  aria-label={`Delete conversation ${c.title || "Untitled"}`}
                  onClick={(e) => {
                    e.preventDefault();
                    if (confirm("Delete this conversation?")) deleteConv.mutate(c.id);
                  }}
                  className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
          {convError && (
            <li role="alert" className="px-2 py-3 text-xs text-destructive">
              Couldn't load conversations.{" "}
              <button type="button" className="underline" onClick={() => void refetchConvs()}>
                Retry
              </button>
            </li>
          )}
          {conversations?.length === 0 && (
            <li className="px-2 py-4 text-center text-xs text-muted-foreground">
              No conversations yet.
            </li>
          )}
        </ul>
      </ScrollArea>
    </div>
  );

  return (
    <div className="-m-4 flex h-[calc(100dvh-5rem)] min-w-0 flex-col gap-2 md:-m-8 md:grid md:grid-cols-[260px_minmax(0,1fr)] md:gap-4 md:p-4">
      <aside className="hidden min-h-0 rounded-lg border bg-card md:flex md:flex-col">
        {sidebar}
      </aside>

      {/* Mobile: conversations live in a drawer so the chat keeps full width. */}
      <div className="flex items-center gap-2 px-2 pt-2 md:hidden">
        <Sheet open={listOpen} onOpenChange={setListOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm">
              <PanelLeft className="mr-1 h-4 w-4" aria-hidden /> Conversations
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[85vw] max-w-xs p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Conversations</SheetTitle>
            </SheetHeader>
            {sidebar}
          </SheetContent>
        </Sheet>
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-card">
        <Outlet />
      </section>
    </div>
  );
}
