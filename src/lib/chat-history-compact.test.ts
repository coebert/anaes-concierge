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
          i % 2
            ? { type: "step-start" }
            : { type: "tool-find_rota_assignments", output: "x".repeat(5000) },
        ),
        { type: "text", text: "y".repeat(20_000) },
      ],
    };
    const msgs = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      heavy,
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "follow up" }],
      },
    ];
    expect(() => ChatBody.parse({ messages: msgs, conversationId: CID })).toThrow();
    const out = compactChatHistory(msgs);
    const body = { messages: out, conversationId: CID };
    expect(() => ChatBody.parse(body)).not.toThrow();
    expect(JSON.stringify(body).length).toBeLessThan(200_000);
    expect((out.at(-1)?.parts?.[0] as { text?: string } | undefined)?.text).toBe("follow up");
  });

  it("drops oldest messages to stay within 100 messages and the byte budget", () => {
    const msgs = Array.from({ length: 150 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? "assistant" : "user",
      parts: [{ type: "text", text: "z".repeat(7000) }],
    }));
    const out = compactChatHistory(msgs);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.at(-1)?.id).toBe("m149");
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(190_000);
  });
});

describe("compactChatHistory keeps earlier lookups when within limits", () => {
  const lookup = {
    type: "tool-find_rota_assignments",
    toolCallId: "call-1",
    state: "output-available",
    input: { date: "2030-01-07" },
    output: { assignments: [{ id: "synthetic-assignment-1" }] },
  };
  const msgs = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "find my Monday assignment" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "step-start" }, lookup, { type: "text", text: "Found it. Delete?" }],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "yes, delete it" }] },
  ];

  it("sends a short chat unchanged, tool result included", () => {
    const out = compactChatHistory(msgs);
    expect(out).toEqual(msgs);
    expect(JSON.stringify(out)).toContain("synthetic-assignment-1");
  });

  it("over the byte budget, strips tool parts from older turns before dropping messages", () => {
    const old = {
      id: "a0",
      role: "assistant",
      parts: [
        { ...lookup, toolCallId: "old", output: "x".repeat(150_000) },
        { type: "text", text: "old" },
      ],
    };
    const out = compactChatHistory([msgs[0], old, ...msgs.slice(1)]);
    expect(out.map((m) => m.id)).toEqual(["u1", "a0", "a1", "u2"]);
    expect(out[1].parts).toEqual([{ type: "text", text: "old" }]);
    expect(JSON.stringify(out)).toContain("synthetic-assignment-1");
  });

  it("over the part limit, drops step markers before tool parts", () => {
    const parts = [
      ...Array.from({ length: 10 }, (_, i) => [
        { type: "step-start" },
        { ...lookup, toolCallId: `c${i}` },
      ]).flat(),
      { type: "text", text: "done" },
    ];
    const out = compactChatHistory([{ id: "a", role: "assistant", parts }, msgs[2]]);
    const kept = out[0].parts as Array<{ type: string }>;
    expect(kept).toHaveLength(11);
    expect(kept.filter((p) => p.type === "step-start")).toHaveLength(0);
    expect(() => ChatBody.parse({ messages: out, conversationId: CID })).not.toThrow();
  });
});
