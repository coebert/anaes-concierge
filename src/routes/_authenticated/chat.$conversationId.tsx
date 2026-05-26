import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Badge } from "@/components/ui/badge";
import { Wrench } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/chat/$conversationId")({
  component: ConversationPage,
});

const SUGGESTIONS = [
  "What's on my rota next week?",
  "How many days of annual leave do I have left?",
  "Who is on call today?",
];

function ConversationPage() {
  const { conversationId } = Route.useParams();
  const navigate = useNavigate();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { data: existing, isLoading } = useQuery({
    queryKey: ["ai-messages", conversationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_messages")
        .select("id,role,parts,created_at")
        .eq("conversation_id", conversationId)
        .order("created_at");
      if (error) throw error;
      return (data ?? []).map(
        (m) =>
          ({
            id: m.id,
            role: m.role as UIMessage["role"],
            parts: (m.parts as any) ?? [],
          }) as UIMessage,
      );
    },
  });

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: async ({ messages, body }) => {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          return {
            body: { messages, conversationId, ...(body ?? {}) },
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          };
        },
      }),
    [conversationId],
  );

  const { messages, sendMessage, status, error } = useChat({
    id: conversationId,
    messages: existing ?? [],
    transport,
    onError: (err) => {
      console.error(err);
      toast.error("Chat error", { description: err.message });
    },
  });

  const [input, setInput] = useState("");

  const isBusy = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (!isBusy) textareaRef.current?.focus();
  }, [isBusy, conversationId]);

  // If conversation was deleted out from under us, bounce out
  useEffect(() => {
    if (error?.message?.includes("Forbidden")) {
      void navigate({ to: "/chat" });
    }
  }, [error, navigate]);

  const onSubmit = async ({ text }: { text: string }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput("");
    await sendMessage({ text: trimmed });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" key={conversationId}>
      <Conversation className="flex-1">
        <ConversationContent>
          {isLoading ? (
            <div className="p-8 text-sm text-muted-foreground">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-start gap-3 p-6">
              <div className="text-sm text-muted-foreground">
                Try one of these to get started:
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void sendMessage({ text: s })}
                    className="rounded-full border bg-background px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} />)
          )}
          {status === "submitted" && (
            <div className="px-4 py-2">
              <Shimmer>Thinking…</Shimmer>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="border-t p-3">
        <PromptInput onSubmit={onSubmit}>
          <PromptInputTextarea
            ref={textareaRef as any}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your rota, leave, or the team…"
            disabled={isBusy}
          />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit status={status} disabled={!input.trim() && !isBusy} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return <MessageResponse key={i}>{part.text}</MessageResponse>;
          }
          if (part.type?.startsWith("tool-")) {
            const toolName = part.type.replace(/^tool-/, "");
            const state = (part as any).state as string | undefined;
            return (
              <div key={i} className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Wrench className="h-3 w-3" />
                <span>Used tool</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {toolName}
                </Badge>
                {state && state !== "output-available" && (
                  <span className="italic">{state}</span>
                )}
              </div>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}
