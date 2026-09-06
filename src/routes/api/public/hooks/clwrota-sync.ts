import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

/**
 * Cron-triggered CLWRota resync.
 *
 * Authenticated via the `CLWROTA_WEBHOOK_SECRET` server-only secret, supplied
 * in the `x-webhook-secret` header.
 *
 * Cloudflare Workers enforce a CPU time limit per invocation. Running all
 * three sync steps (staff + rota + leave, ~30k rows total) in one request
 * regularly trips that limit and returns 502, leaving the data in a
 * partially-synced state. To avoid that, callers SHOULD invoke this hook
 * three times with `?step=staff`, `?step=rota`, `?step=leave` so each step
 * gets its own fresh Worker invocation.
 *
 * Calling the hook without a `step` falls back to the legacy "run all three
 * sequentially" behaviour for backwards compatibility, but is liable to be
 * cancelled mid-flight by the Worker runtime on large datasets.
 */
type Step = "staff" | "rota" | "leave";
const VALID_STEPS: Step[] = ["staff", "rota", "leave"];

export const Route = createFileRoute("/api/public/hooks/clwrota-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-webhook-secret") ?? "";
        const expected = process.env.CLWROTA_WEBHOOK_SECRET ?? "";
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const params = new URL(request.url).searchParams;
        const stepParam = params.get("step");
        const steps: Step[] =
          stepParam && (VALID_STEPS as string[]).includes(stepParam)
            ? [stepParam as Step]
            : VALID_STEPS;

        if (stepParam && !(VALID_STEPS as string[]).includes(stepParam)) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: `Invalid step "${stepParam}". Use one of: ${VALID_STEPS.join(", ")}.`,
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        // Optional explicit date window for the rota step — used by
        // historical backfills to walk a long range in Worker-sized slices
        // (the default report URL spans 30 days back / 120 ahead).
        const fromDate = params.get("from");
        const toDate = params.get("to");
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if ((fromDate && !dateRe.test(fromDate)) || (toDate && !dateRe.test(toDate))) {
          return new Response(
            JSON.stringify({ ok: false, error: "from/to must be YYYY-MM-DD." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        // Dynamic import — keeps server-only modules out of the client bundle.
        const {
          performStaffSync,
          performRotaSync,
          performRotaSyncChunked,
          performRotaSyncIncremental,
          performLeaveSync,
        } = await import("@/features/clwrota/clwrota.functions");

        // Slices are deliberately small (≤14 days) so each upstream download
        // fits comfortably in the Worker's memory; several of them can then
        // run per invocation and the full window builds up over successive
        // runs.
        const sliceParam = params.get("sliceDays");
        const sliceDays = sliceParam
          ? Math.max(1, Math.min(14, Number(sliceParam) || 7))
          : undefined;
        const maxSlicesParam = params.get("maxSlices");
        const maxSlices = maxSlicesParam
          ? Math.max(1, Math.min(6, Number(maxSlicesParam) || 4))
          : undefined;

        // Rota mode:
        //   `mode=full`        — chunked pass over the whole configured window.
        //                        Each slice re-fetches and re-parses the full
        //                        upstream payload, so this is memory-heavy and
        //                        is capped by `maxSlices`.
        //   anything else      — incremental (default): a single small window
        //                        since the last successful run. One upstream
        //                        fetch, which keeps the Worker inside its
        //                        memory budget on routine (hourly) runs.
        // Ignored when an explicit from/to is given.
        const mode = (params.get("mode") ?? "").toLowerCase();
        const full = mode === "full";

        const runners: Record<Step, () => Promise<unknown>> = {
          staff: performStaffSync,
          rota: () =>
            fromDate && toDate
              ? performRotaSync({ from: fromDate, to: toDate })
              : full
                ? performRotaSyncChunked({ sliceDays, maxSlices })
                : performRotaSyncIncremental(),
          leave: performLeaveSync,
        };

        const result: Record<string, unknown> = {};
        const errors: Record<string, string> = {};

        for (const step of steps) {
          try {
            result[step] = await runners[step]();
          } catch (e) {
            errors[`${step}Error`] = e instanceof Error ? e.message : String(e);
          }
        }

        // Leave is best-effort; staff/rota failures fail the run.
        const blockingFailure =
          (steps.includes("staff") && errors.staffError) ||
          (steps.includes("rota") && errors.rotaError);
        const ok = !blockingFailure;

        return new Response(
          JSON.stringify({ ok, steps, ...result, ...errors }),
          {
            status: ok ? 200 : 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    },
  },
});
