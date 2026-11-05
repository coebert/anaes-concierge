import { CHAT_LIMITS } from "@/lib/request-quota";

type Part = { type: string; text?: string; [k: string]: unknown };
type Msg = { id?: string; role: string; parts?: Part[]; [k: string]: unknown };

const TRUNC_NOTE = "\n…[truncated]";

function clip(text: string): string {
  const max = CHAT_LIMITS.maxTextCharsPerMessage;
  return text.length <= max ? text : text.slice(0, max - TRUNC_NOTE.length) + TRUNC_NOTE;
}

/**
 * Shrinks chat history so a follow-up always fits the server's request limits.
 * Older assistant turns keep only their text (tool calls/outputs and step markers
 * are dropped — they are already persisted server-side), long text is clipped,
 * and the oldest messages are dropped until count and byte budgets are met.
 * The latest message is always kept.
 */
export function compactChatHistory<M extends Msg>(
  messages: M[],
  byteBudget = CHAT_LIMITS.maxRequestBytes - 10_000,
): M[] {
  const compacted = messages.map((m) => {
    const parts = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => ({ type: "text", text: clip(p.text as string) }))
      .slice(-CHAT_LIMITS.maxPartsPerMessage);
    return { id: m.id, role: m.role, parts } as unknown as M;
  });
  let out = compacted.filter((m, i) => i === compacted.length - 1 || (m.parts?.length ?? 0) > 0);
  if (out.length > CHAT_LIMITS.maxMessages) out = out.slice(-CHAT_LIMITS.maxMessages);
  const size = (arr: M[]) => new TextEncoder().encode(JSON.stringify(arr)).length;
  while (out.length > 1 && size(out) > byteBudget) out = out.slice(1);
  return out;
}
