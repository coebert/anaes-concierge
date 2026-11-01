import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_STREAM_DEADLINE_MS,
  StreamDeadlineError,
  withStreamDeadline,
} from "./chat-stream-deadline";
import { CHAT_STREAM_LIMITS } from "./chat-stream-lease";

const enc = new TextEncoder();

/** Source that emits `chunks` at the given fake-clock delays, then optionally hangs. */
function source(steps: { at: number; text: string }[], hang: boolean) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const s of steps) setTimeout(() => !cancelled && ctrl.enqueue(enc.encode(s.text)), s.at);
      if (!hang) {
        const last = steps.length ? steps[steps.length - 1].at : 0;
        setTimeout(() => !cancelled && ctrl.close(), last + 1);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(body), isCancelled: () => cancelled };
}

async function drain(r: Response): Promise<{ text: string; error: unknown }> {
  const reader = r.body!.getReader();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { text, error: null };
      text += new TextDecoder().decode(value);
    }
  } catch (e) {
    return { text, error: e };
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("chat stream deadline", () => {
  it("is shorter than the lease TTL", () => {
    expect(CHAT_STREAM_DEADLINE_MS).toBeLessThan(CHAT_STREAM_LIMITS.leaseTtlSeconds * 1000);
  });

  it("hung stream: aborts upstream, errors the client stream, then releases once", async () => {
    const upstream = new AbortController();
    const order: string[] = [];
    upstream.signal.addEventListener("abort", () => order.push("abort"));
    const onTerminate = vi.fn(() => {
      order.push("release");
    });
    const src = source([{ at: 10, text: "hi" }], true);
    const out = withStreamDeadline(src.res, { deadlineMs: 1000, upstream, onTerminate });
    const p = drain(out);
    await vi.advanceTimersByTimeAsync(999);
    expect(onTerminate).not.toHaveBeenCalled();
    expect(upstream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r.text).toBe("hi");
    expect(r.error).toBeInstanceOf(StreamDeadlineError);
    expect(upstream.signal.reason).toBeInstanceOf(StreamDeadlineError);
    expect(src.isCancelled()).toBe(true);
    expect(order).toEqual(["abort", "release"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("slow but finishing stream inside the deadline passes through untouched", async () => {
    const upstream = new AbortController();
    const onTerminate = vi.fn();
    const src = source(
      [
        { at: 300, text: "a" },
        { at: 900, text: "b" },
      ],
      false,
    );
    const out = withStreamDeadline(src.res, { deadlineMs: 1000, upstream, onTerminate });
    const p = drain(out);
    await vi.advanceTimersByTimeAsync(950);
    const r = await p;
    expect(r).toEqual({ text: "ab", error: null });
    expect(upstream.signal.aborted).toBe(false);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); // deadline timer was cleared
    expect(upstream.signal.aborted).toBe(false);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("client cancel aborts upstream and releases once", async () => {
    const upstream = new AbortController();
    const onTerminate = vi.fn();
    const src = source([], true);
    const out = withStreamDeadline(src.res, { deadlineMs: 1000, upstream, onTerminate });
    await out.body!.cancel("client went away");
    expect(upstream.signal.aborted).toBe(true);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("upstream stream error aborts work and releases once", async () => {
    const upstream = new AbortController();
    const onTerminate = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        setTimeout(() => c.error(new Error("model failed")), 50);
      },
    });
    const out = withStreamDeadline(new Response(body), { deadlineMs: 1000, upstream, onTerminate });
    const p = drain(out);
    await vi.advanceTimersByTimeAsync(60);
    expect((await p).error).toBeInstanceOf(Error);
    expect(upstream.signal.aborted).toBe(true);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });
});
