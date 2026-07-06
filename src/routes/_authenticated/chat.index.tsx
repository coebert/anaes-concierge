import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

export const Route = createFileRoute("/_authenticated/chat/")({
  head: () => ({ meta: [{ title: "Chat — Salisbury Anaesthetics Rota" }] }),
  component: ChatIndex,
});

function ChatIndex() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <MessageSquare className="h-10 w-10 text-muted-foreground/40" />
      <h2 className="text-lg font-medium">Pick a conversation</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Select an existing chat on the left, or start a new one to ask about your rota, leave
        balance, or who is on call today.
      </p>
    </div>
  );
}
