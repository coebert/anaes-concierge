import { describe, expect, it } from "vitest";
import { compactChatHistory } from "./chat-history-compact";
import { ChatBody } from "@/routes/api/chat";

const CID = "00000000-0000-4000-8000-000000000001";

describe("compactChatHistory", () => {
  it("makes a history with a tool-heavy, long assistant turn pass server validation", () => {
    const heavy = {
      id: "a1",
      role: "assistant",
      parts: [
        ...Array.from({ length: 60 }, (_, i) =>
          i % 2 ? { type: "step-start" } : { type: "tool-find_rota_assignments", output: "x".repeat(5000) },
        ),
        { type: "text", text: "y".repeat(20_000) },
      ],
    };
    const msgs = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }, heavy, {
      id: "u2", role: "user", parts: [{ type: "text", text: "follow up" }],
    }];
    expect(() => ChatBody.parse({ messages: msgs, conversationId: CID })).toThrow();
    const out = compactChatHistory(msgs);
    const body = { messages: out, conversationId: CID };
    expect(() => ChatBody.parse(body)).not.toThrow();
    expect(JSON.stringify(body).length).toBeLessThan(200_000);
    expect((out.at(-1)?.parts?.[0] as { text?: string } | undefined)?.text).toBe("follow up");
  });

  it("drops oldest messages to stay within 100 messages and the byte budget", () => {
    const msgs = Array.from({ length: 150 }, (_, i) => ({
      id: `m${i}`, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: "z".repeat(7000) }],
    }));
    const out = compactChatHistory(msgs);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.at(-1)?.id).toBe("m149");
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(190_000);
  });
});
