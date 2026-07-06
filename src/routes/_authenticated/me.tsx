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
  head: () => ({ meta: [{ title: "My rota — Salisbury Anaesthetics Rota" }] }),
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
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    status: number;
    contentType: string;
    parses: boolean;
    eventCount: number;
    calName?: string;
    error?: string;
    durationMs: number;
  } | null>(null);

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

  async function runTest() {
    setBusy(true);
    setTestResult(null);
    const started = performance.now();
    try {
      let activeToken = token;
      if (!activeToken) {
        const res = await getToken();
        activeToken = res.token;
        setToken(activeToken);
      }
      const url = `${PUBLISHED_ORIGIN}/api/public/calendar/${activeToken}`;
      const resp = await fetch(url, { method: "GET", redirect: "follow" });
      const contentType = resp.headers.get("content-type") ?? "";
      const text = await resp.text();
      const durationMs = Math.round(performance.now() - started);

      // Basic RFC 5545 sanity: must start with BEGIN:VCALENDAR, end with END:VCALENDAR,
      // and have matching BEGIN/END counts for VEVENT.
      const trimmed = text.trim();
      const startsOk = /^BEGIN:VCALENDAR/m.test(trimmed.split(/\r?\n/)[0] ?? "");
      const endsOk = /END:VCALENDAR\s*$/.test(trimmed);
      const beginEvents = (text.match(/^BEGIN:VEVENT/gm) ?? []).length;
      const endEvents = (text.match(/^END:VEVENT/gm) ?? []).length;
      const calNameMatch = text.match(/^X-WR-CALNAME:(.+)$/m);
      const parses = resp.ok && startsOk && endsOk && beginEvents === endEvents;

      setTestResult({
        ok: resp.ok,
        status: resp.status,
        contentType,
        parses,
        eventCount: beginEvents,
        calName: calNameMatch?.[1]?.trim(),
        error: parses
          ? undefined
          : !resp.ok
            ? `HTTP ${resp.status}`
            : !startsOk
              ? "Missing BEGIN:VCALENDAR header"
              : !endsOk
                ? "Missing END:VCALENDAR footer"
                : `Unbalanced VEVENT blocks (${beginEvents} BEGIN / ${endEvents} END)`,
        durationMs,
      });
    } catch (e: any) {
      setTestResult({
        ok: false,
        status: 0,
        contentType: "",
        parses: false,
        eventCount: 0,
        error: e?.message ?? "Network error",
        durationMs: Math.round(performance.now() - started),
      });
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
          <Button variant="outline" onClick={runTest} disabled={busy}>
            <FlaskConical className="mr-2 h-4 w-4" /> Test feed
          </Button>
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
        {testResult && (
          <div
            className={`rounded-md border p-3 text-xs space-y-1 ${
              testResult.parses
                ? "border-green-500/40 bg-green-500/5"
                : "border-destructive/40 bg-destructive/5"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              {testResult.parses ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              {testResult.parses ? "Feed OK" : "Feed failed"}
              <span className="ml-auto font-mono text-muted-foreground">{testResult.durationMs}ms</span>
            </div>
            <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5 font-mono">
              <span className="text-muted-foreground">HTTP status</span>
              <span>{testResult.status || "—"}</span>
              <span className="text-muted-foreground">Content-Type</span>
              <span className="break-all">{testResult.contentType || "—"}</span>
              <span className="text-muted-foreground">VCALENDAR</span>
              <span>{testResult.parses ? "parses ✓" : "invalid ✗"}</span>
              <span className="text-muted-foreground">VEVENT count</span>
              <span>{testResult.eventCount}</span>
              {testResult.calName && (
                <>
                  <span className="text-muted-foreground">Calendar name</span>
                  <span className="break-all">{testResult.calName}</span>
                </>
              )}
              {testResult.error && (
                <>
                  <span className="text-muted-foreground">Error</span>
                  <span className="text-destructive break-all">{testResult.error}</span>
                </>
              )}
            </div>
          </div>
        )}

      </CardContent>
    </Card>
  );
}
