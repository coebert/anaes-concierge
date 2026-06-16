import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useAuth } from "@/lib/auth-context";
import { StaffWeekView } from "@/components/rota-views";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar, Copy, RefreshCw, Check, FlaskConical, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  getCalendarFeedToken,
  regenerateCalendarFeedToken,
} from "@/lib/calendar-feed.functions";

export const Route = createFileRoute("/_authenticated/me")({
  component: MyRotaPage,
});

function MyRotaPage() {
  const { user } = useAuth();
  if (!user) {
    return (
      <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent></Card>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">My rota</h1>
      <CalendarSubscribeCard />
      <StaffWeekView staffId={user.id} />
    </div>
  );
}

function CalendarSubscribeCard() {
  const getToken = useServerFn(getCalendarFeedToken);
  const regen = useServerFn(regenerateCalendarFeedToken);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Always use the published domain — Apple Calendar can't authenticate against
  // the preview host (id-preview--…lovable.app), which would redirect to the
  // Lovable auth bridge and fail. The published site serves /api/public/* without auth.
  const PUBLISHED_ORIGIN = "https://anaes-concierge.lovable.app";
  const httpUrl = token ? `${PUBLISHED_ORIGIN}/api/public/calendar/${token}` : "";
  const webcalUrl = httpUrl.replace(/^https?:/, "webcal:");

  async function load() {
    setBusy(true);
    try {
      const res = await getToken();
      setToken(res.token);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not generate calendar feed");
    } finally {
      setBusy(false);
    }
  }

  async function subscribe() {
    if (!token) {
      await load();
    }
    // Open webcal: link — Apple Calendar (and most desktop calendar apps) will intercept
    if (typeof window !== "undefined") {
      const url = token ? webcalUrl : null;
      if (url) window.location.href = url;
    }
  }

  async function copyLink() {
    if (!token) await load();
    if (httpUrl) {
      await navigator.clipboard.writeText(httpUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  async function regenerate() {
    if (!confirm("Regenerate the calendar link? Any existing calendar subscriptions will stop updating.")) return;
    setBusy(true);
    try {
      const res = await regen();
      setToken(res.token);
      toast.success("New calendar link generated");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not regenerate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calendar className="h-4 w-4" /> Subscribe in Apple Calendar
        </CardTitle>
        <CardDescription>
          Adds your rota (sessions, on-call, leave) to Apple Calendar as a live subscription. Apple refreshes the feed
          automatically — changes flow through without re-importing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button onClick={subscribe} disabled={busy}>
            <Calendar className="mr-2 h-4 w-4" />
            {token ? "Open in Apple Calendar" : "Generate & subscribe"}
          </Button>
          <Button variant="secondary" onClick={copyLink} disabled={busy}>
            {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            Copy link
          </Button>
          {token && (
            <Button variant="ghost" onClick={regenerate} disabled={busy}>
              <RefreshCw className="mr-2 h-4 w-4" /> Regenerate
            </Button>
          )}
        </div>
        {token && (
          <div className="space-y-1">
            <Input readOnly value={httpUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <p className="text-xs text-muted-foreground">
              On iPhone/iPad: tap the link above. On a Mac: File → New Calendar Subscription, paste the link. Keep this URL
              private — anyone with it can read your rota.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
