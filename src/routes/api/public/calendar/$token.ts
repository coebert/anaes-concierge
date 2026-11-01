import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { buildCalendarFeedForToken } from "@/lib/calendar-feed";

// Apple Calendar / iCal subscription feed: /api/public/calendar/<token>.ics
// The token is the credential — the handler itself verifies it, membership
// and every data source (fail closed). Rendering lives in @/lib/calendar-feed.

const NO_STORE = "private, no-store, max-age=0";

export const Route = createFileRoute("/api/public/calendar/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const raw = (params as unknown as Record<string, string>).token ?? "";
        const token = raw.replace(/\.ics$/i, "");
        const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const res = await buildCalendarFeedForToken(sb, token);
        if (res.kind === "not_found")
          return new Response("Not found", { status: 404, headers: { "Cache-Control": NO_STORE } });
        if (res.kind === "unavailable") {
          console.warn("calendar feed unavailable:", res.reason);
          return new Response("Calendar temporarily unavailable", {
            status: 503,
            headers: { "Cache-Control": NO_STORE, "Retry-After": "300" },
          });
        }
        return new Response(res.body, {
          status: 200,
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Cache-Control": NO_STORE,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Disposition": `inline; filename="rota.ics"`,
          },
        });
      },
    },
  },
});
