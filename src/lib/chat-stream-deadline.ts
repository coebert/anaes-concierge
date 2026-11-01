/**
 * Hard wall-clock bound for an assistant reply stream.
 *
 * A stream that outlives its concurrency lease would let replacement streams
 * exceed the per-user cap. This wraps the outgoing Response body so that, at
 * `deadlineMs` (kept well below the lease TTL):
 *   1. the upstream model/tool work is aborted via `upstream`, and
 *   2. the outgoing body is errored (the client sees the stream end), and
 *   3. `onTerminate` runs exactly once AFTER the abort was signalled.
 * Normal completion and client cancellation also run `onTerminate` once.
 * The lease is therefore never released while the stream is still running.
 */
import { CHAT_STREAM_LIMITS } from "./chat-stream-lease";

/** 4 minutes — comfortably below the 600 s lease TTL. */
export const CHAT_STREAM_DEADLINE_MS = 240_000;

if (CHAT_STREAM_DEADLINE_MS >= CHAT_STREAM_LIMITS.leaseTtlSeconds * 1000) {
  throw new Error("chat stream deadline must be shorter than the lease TTL");
}

export class StreamDeadlineError extends Error {
  constructor(ms: number) {
    super(`Assistant reply exceeded the ${Math.round(ms / 1000)} s time limit.`);
    this.name = "StreamDeadlineError";
  }
}

export interface DeadlineOptions {
  deadlineMs: number;
  /** Aborting this stops the upstream (model + tools) work. */
  upstream: AbortController;
  /** Runs once when the stream has ended for any reason. */
  onTerminate: () => void | Promise<void>;
}

export function withStreamDeadline(res: Response, opts: DeadlineOptions): Response {
  const source = res.body;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    void opts.onTerminate();
  };
  if (!source) {
    finish();
    return res;
  }
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      timer = setTimeout(() => {
        if (done) return;
        const err = new StreamDeadlineError(opts.deadlineMs);
        opts.upstream.abort(err);
        try {
          ctrl.error(err);
        } catch {
          /* already closed */
        }
        void reader.cancel(err).catch(() => undefined);
        finish();
      }, opts.deadlineMs);
    },
    async pull(ctrl) {
      try {
        const { value, done: end } = await reader.read();
        if (done) return;
        if (end) {
          ctrl.close();
          finish();
        } else {
          ctrl.enqueue(value);
        }
      } catch (e) {
        if (done) return;
        opts.upstream.abort(e);
        ctrl.error(e);
        finish();
      }
    },
    cancel(reason) {
      opts.upstream.abort(reason);
      void reader.cancel(reason).catch(() => undefined);
      finish();
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
