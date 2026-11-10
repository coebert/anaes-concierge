import { CHAT_LIMITS } from "@/lib/request-quota";

type Part = { type: string; text?: string };
type Msg = { id?: string; role: string; parts?: readonly object[] };

const TRUNC_NOTE = "\n…[truncated]";

function clip(text: string): string {
  const max = CHAT_LIMITS.maxTextCharsPerMessage;
  return text.length <= max ? text : text.slice(0, max - TRUNC_NOTE.length) + TRUNC_NOTE;
}

const isText = (p: Part) => p.type === "text";
const isStepMarker = (p: Part) => p.type === "step-start";

/**
 * Fit one message to the per-message limits with the least loss:
 * clip over-long text, then drop step markers, then the OLDEST tool parts.
 * Messages already within limits keep every part (tool calls and results
 * included) — the server rebuilds model context only from this history.
 */
function fitMessage(parts: Part[]): Part[] {
  let out = parts.map((p) =>
    isText(p) && typeof p.text === "string" && p.text.length > CHAT_LIMITS.maxTextCharsPerMessage
      ? { ...p, text: clip(p.text) }
      : p,
  );
  const max = CHAT_LIMITS.maxPartsPerMessage;
  if (out.length > max) out = out.filter((p) => !isStepMarker(p));
  if (out.length > max) {
    let excess = out.length - max;
    out = out.filter((p) => {
      if (excess > 0 && !isText(p)) {
        excess--;
        return false;
      }
      return true;
    });
  }
  // Only text parts left and still too many: keep the most recent.
  if (out.length > max) out = out.slice(-max);
  return out;
}

const textOnly = (parts: Part[]) => parts.filter((p) => isText(p) && typeof p.text === "string");

/**
 * Shrinks chat history only as far as needed to fit the server's request
 * limits. In order: per-message fitting (above); then, while the request is
 * over the byte budget, earlier messages lose their tool parts oldest-first
 * (the newest turns keep their lookups); then the oldest messages are dropped.
 * The latest message is always kept. A history already within limits is sent
 * unchanged, so follow-ups ("yes, delete it") still see earlier tool results.
 */
export function compactChatHistory<M extends Msg>(
  messages: M[],
  byteBudget = CHAT_LIMITS.maxRequestBytes - 10_000,
): M[] {
  const size = (arr: unknown[]) => new TextEncoder().encode(JSON.stringify(arr)).length;
  let out = messages.map((m) => {
    const parts = (m.parts ?? []) as Part[];
    const fitted = fitMessage(parts);
    return fitted.length === parts.length && fitted.every((p, i) => p === parts[i])
      ? m
      : ({ ...m, parts: fitted } as M);
  });
  if (out.length > CHAT_LIMITS.maxMessages) out = out.slice(-CHAT_LIMITS.maxMessages);

  for (let i = 0; i < out.length - 1 && size(out) > byteBudget; i++) {
    const parts = (out[i].parts ?? []) as Part[];
    const kept = textOnly(parts);
    if (kept.length !== parts.length) out[i] = { ...out[i], parts: kept } as M;
  }
  out = out.filter((m, i) => i === out.length - 1 || (m.parts?.length ?? 0) > 0);
  while (out.length > 1 && size(out) > byteBudget) out = out.slice(1);
  return out;
}
