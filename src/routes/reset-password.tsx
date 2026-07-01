import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { AlertCircle, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { describeRecoveryUrl, describeSession, trace, traceError } from "@/lib/auth-trace";

type PasswordCheck = { id: string; label: string; ok: boolean };

function evaluatePassword(pw: string): PasswordCheck[] {
  return [
    { id: "len", label: "At least 8 characters", ok: pw.length >= 8 && pw.length <= 128 },
    { id: "upper", label: "An uppercase letter (A–Z)", ok: /[A-Z]/.test(pw) },
    { id: "lower", label: "A lowercase letter (a–z)", ok: /[a-z]/.test(pw) },
    { id: "digit", label: "A number (0–9)", ok: /[0-9]/.test(pw) },
  ];
}

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

/**
 * Deterministic state machine for the reset-password page.
 *
 * Design goal: the page must never commit to `request` or `update` until it
 * has PROVEN which one is correct. Two independent races are in play:
 *
 *   1. supabase-js's `detectSessionInUrl` parses `#access_token=…` async and
 *      may materialize a session AFTER the component mounts.
 *   2. The user may hard-refresh after a successful verification — the URL is
 *      clean but a recovery session still lives in storage.
 *
 * States:
 *   - `initializing`  → deciding from the URL / ready-flag (synchronous).
 *   - `probing`       → no recovery indicators; probing `getSession()` before
 *                       falling back to the request form.
 *   - `verifying`     → a recovery indicator is present; running the correct
 *                       exchange (pkce / token_hash / setSession / poll) and
 *                       waiting for `SESSION_MATERIALIZED`.
 *   - `request`       → terminal-until-submit. Committed only when we have
 *                       proof there is no recovery flow in progress.
 *   - `update`        → terminal-until-submit. Committed only when a Supabase
 *                       session is confirmed present.
 *   - `error`         → terminal-until-startOver. The link is unusable.
 *
 * Two independent signals dispatch `SESSION_MATERIALIZED`:
 *   - `supabase.auth.onAuthStateChange` fires PASSWORD_RECOVERY / SIGNED_IN.
 *   - An explicit `getSession()` from the verifying or probing branch.
 * Whichever wins the race, the machine settles on `update` exactly once.
 */
type MachineState =
  | { status: "initializing" }
  | { status: "probing" }
  | { status: "verifying"; kind: Exclude<ResetLinkState["kind"], "none" | "error"> }
  | { status: "request" }
  | { status: "update" }
  | { status: "error"; message: string };

type MachineEvent =
  | { type: "DECIDED_NO_RECOVERY_PROBE" }
  | { type: "DECIDED_NO_RECOVERY_COMMIT" }
  | {
      type: "DECIDED_RECOVERY";
      kind: Exclude<ResetLinkState["kind"], "none" | "error">;
    }
  | { type: "LINK_ERROR"; message: string }
  | { type: "SESSION_MATERIALIZED" }
  | { type: "NO_SESSION" }
  | { type: "EXCHANGE_FAILED"; message: string }
  | { type: "USER_START_OVER" };

function machineReducer(state: MachineState, event: MachineEvent): MachineState {
  // `SESSION_MATERIALIZED` and `USER_START_OVER` are terminal transitions
  // that can arrive from anywhere; handle them uniformly.
  if (event.type === "SESSION_MATERIALIZED") {
    if (state.status === "update" || state.status === "error") return state;
    return { status: "update" };
  }
  if (event.type === "USER_START_OVER") {
    return { status: "request" };
  }

  switch (state.status) {
    case "initializing":
      if (event.type === "DECIDED_RECOVERY") return { status: "verifying", kind: event.kind };
      if (event.type === "DECIDED_NO_RECOVERY_PROBE") return { status: "probing" };
      if (event.type === "DECIDED_NO_RECOVERY_COMMIT") return { status: "request" };
      if (event.type === "LINK_ERROR") return { status: "error", message: event.message };
      return state;
    case "probing":
      if (event.type === "NO_SESSION") return { status: "request" };
      return state;
    case "verifying":
      if (event.type === "EXCHANGE_FAILED") return { status: "error", message: event.message };
      return state;
    default:
      return state;
  }
}

type Mode = MachineState["status"];

type ResetLinkState =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "pkce"; code: string }
  | { kind: "token_hash"; tokenHash: string }
  | { kind: "implicit"; accessToken: string; refreshToken: string }
  | { kind: "recovery_session" };

const resetLinkExchangeCache = new Map<string, Promise<string | null>>();
const RESET_SESSION_READY_KEY = "auth.passwordResetSessionReady";

/**
 * Map Supabase / OAuth error codes & descriptions to a short, user-friendly
 * sentence. Anything we don't recognise falls back to the raw description.
 */
function describeLinkError(code: string | null, description: string | null): string {
  const text = `${code ?? ""} ${description ?? ""}`.toLowerCase();
  if (text.includes("expired") || text.includes("otp_expired")) {
    return "This password reset link has expired. Reset links are valid for a limited time — please request a new one.";
  }
  if (text.includes("invalid") || text.includes("used") || text.includes("flow_state_not_found")) {
    return "This password reset link is no longer valid. It may have already been used or opened in a different browser. Please request a new one.";
  }
  if (description) return description;
  return "We couldn't verify this password reset link. Please request a new one.";
}

function getResetLinkState(href: string): ResetLinkState {
  const url = new URL(href);
  const hashParams = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : "",
  );

  const errorCode =
    url.searchParams.get("error") ??
    url.searchParams.get("error_code") ??
    hashParams.get("error") ??
    hashParams.get("error_code");
  const errorDescription =
    url.searchParams.get("error_description") ?? hashParams.get("error_description");
  if (errorCode || errorDescription) {
    return { kind: "error", message: describeLinkError(errorCode, errorDescription) };
  }

  const code = url.searchParams.get("code");
  if (code) return { kind: "pkce", code };

  const tokenHash = url.searchParams.get("token_hash") ?? hashParams.get("token_hash");
  const type = url.searchParams.get("type") ?? hashParams.get("type");
  if (tokenHash && type === "recovery") return { kind: "token_hash", tokenHash };

  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");
  if ((type === "recovery" || url.hash.includes("type=recovery")) && accessToken && refreshToken) {
    return { kind: "implicit", accessToken, refreshToken };
  }

  if (type === "recovery" || url.hash.includes("type=recovery")) {
    return { kind: "recovery_session" };
  }

  return { kind: "none" };
}

function cleanResetLinkUrl() {
  if (typeof window === "undefined") return;
  window.history.replaceState({}, "", window.location.pathname);
}

function setResetSessionReady(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(RESET_SESSION_READY_KEY, "1");
    else window.sessionStorage.removeItem(RESET_SESSION_READY_KEY);
  } catch {
    // Storage can be unavailable in hardened browsers; the link still works.
  }
}

function hasResetSessionReadyFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(RESET_SESSION_READY_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Captured synchronously at module load — BEFORE supabase-js's
 * `detectSessionInUrl` runs on first client access. supabase-js consumes
 * `#access_token=…&type=recovery` hashes asynchronously and rewrites the URL,
 * so a child component effect that reads `window.location.href` can miss the
 * recovery indicators. Reading once here guarantees we see the original link.
 */
const INITIAL_RESET_URL =
  typeof window !== "undefined" ? window.location.href : "";

if (typeof window !== "undefined") {
  trace("reset-password.module.init", {
    initialUrl: describeRecoveryUrl(INITIAL_RESET_URL),
  });
}

/**
 * If the initial URL looks like any kind of recovery link, mark the reset
 * session as "ready" up-front. The effect below will then call
 * `supabase.auth.getSession()` — by that time supabase-js will have parsed
 * the hash into a real session and we land on the update form even if the
 * PASSWORD_RECOVERY event fired before our listener attached.
 */
(function preflightRecoveryFlag() {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== "/reset-password") return;
  const state = getResetLinkState(INITIAL_RESET_URL);
  trace("reset-password.preflight", { stateKind: state.kind });
  if (state.kind === "implicit" || state.kind === "recovery_session") {
    try {
      window.sessionStorage.setItem(RESET_SESSION_READY_KEY, "1");
      trace("reset-password.preflight.flagSet");
    } catch (err) {
      traceError("reset-password.preflight.flagSet.error", err);
    }
  }
})();

async function exchangeResetLinkOnce(
  cacheKey: string,
  exchange: () => Promise<string | null>,
): Promise<string | null> {
  const cached = resetLinkExchangeCache.get(cacheKey);
  if (cached) return cached;

  const promise = exchange();
  resetLinkExchangeCache.set(cacheKey, promise);
  const result = await promise;
  if (result) resetLinkExchangeCache.delete(cacheKey);
  return result;
}

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(machineReducer, { status: "initializing" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const mode: Mode = state.status;
  const errorMessage = state.status === "error" ? state.message : null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const passwordChecks = useMemo(() => evaluatePassword(password), [password]);
  const passwordStrongEnough = passwordChecks.every((c) => c.ok);
  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmitUpdate = passwordStrongEnough && passwordsMatch && !busy;

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Prefer the URL captured at module-load: supabase-js's
    // `detectSessionInUrl` strips the recovery hash asynchronously, so a
    // late `window.location.href` read can miss the indicators entirely.
    const liveState = getResetLinkState(window.location.href);
    const initialState =
      liveState.kind === "none" ? getResetLinkState(INITIAL_RESET_URL) : liveState;

    trace("reset-password.effect.enter", {
      liveUrl: describeRecoveryUrl(window.location.href),
      initialUrl: describeRecoveryUrl(INITIAL_RESET_URL),
      liveKind: liveState.kind,
      chosenKind: initialState.kind,
      hasReadyFlag: hasResetSessionReadyFlag(),
    });

    let cancelled = false;
    const safeDispatch = (event: MachineEvent) => {
      if (cancelled) return;
      trace("reset-password.dispatch", { event: event.type, from: stateRef.current.status });
      dispatch(event);
    };

    // Two signals can materialize the session: the auth listener (fires
    // PASSWORD_RECOVERY / SIGNED_IN once supabase-js finishes parsing the
    // URL) OR the explicit exchange below. Either one settles the machine
    // deterministically via SESSION_MATERIALIZED; the reducer ignores
    // duplicates.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      trace("reset-password.onAuthStateChange", {
        event,
        session: describeSession(session),
        cancelled,
        status: stateRef.current.status,
      });
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) {
        cleanResetLinkUrl();
        setResetSessionReady(true);
        safeDispatch({ type: "SESSION_MATERIALIZED" });
      }
    });

    const cleanup = () => {
      trace("reset-password.effect.cleanup");
      cancelled = true;
      sub.subscription.unsubscribe();
    };

    // --- Synchronous decision from the URL --------------------------------
    if (initialState.kind === "error") {
      cleanResetLinkUrl();
      safeDispatch({ type: "LINK_ERROR", message: initialState.message });
      return cleanup;
    }

    if (initialState.kind === "none") {
      if (!hasResetSessionReadyFlag()) {
        // No URL indicators and no persisted "ready" flag → commit to the
        // request form immediately. Determinism is preserved because the
        // `onAuthStateChange` listener above stays subscribed and will
        // still dispatch `SESSION_MATERIALIZED` if supabase-js parses a
        // late-arriving recovery session, flipping us to `update`.
        safeDispatch({ type: "DECIDED_NO_RECOVERY_COMMIT" });
        return cleanup;
      }
      // Refresh after a previous successful verification — confirm the
      // session is still there before showing the update form.
      safeDispatch({ type: "DECIDED_RECOVERY", kind: "recovery_session" });
      void (async () => {
        const { data, error } = await supabase.auth.getSession();
        if (cancelled) return;
        trace("reset-password.recheck.getSession", {
          session: describeSession(data.session),
          error: error?.message ?? null,
        });
        if (error || !data.session) {
          setResetSessionReady(false);
          safeDispatch({ type: "EXCHANGE_FAILED", message: "No reset session was found." });
          return;
        }
        cleanResetLinkUrl();
        safeDispatch({ type: "SESSION_MATERIALIZED" });
      })();
      return cleanup;
    }

    // --- A recovery indicator is present; run the appropriate exchange ---
    safeDispatch({ type: "DECIDED_RECOVERY", kind: initialState.kind });
    void (async () => {
      let exchangeError: string | null = null;

      if (initialState.kind === "pkce") {
        exchangeError = await exchangeResetLinkOnce(`pkce:${initialState.code}`, async () => {
          const { error } = await supabase.auth.exchangeCodeForSession(initialState.code);
          trace("reset-password.exchange.pkce.result", { error: error?.message ?? null });
          return error?.message ?? null;
        });
      } else if (initialState.kind === "token_hash") {
        exchangeError = await exchangeResetLinkOnce(
          `token_hash:${initialState.tokenHash}`,
          async () => {
            const { error } = await supabase.auth.verifyOtp({
              token_hash: initialState.tokenHash,
              type: "recovery",
            });
            trace("reset-password.exchange.token_hash.result", { error: error?.message ?? null });
            return error?.message ?? null;
          },
        );
      } else if (initialState.kind === "implicit") {
        const { error } = await supabase.auth.setSession({
          access_token: initialState.accessToken,
          refresh_token: initialState.refreshToken,
        });
        exchangeError = error?.message ?? null;
        trace("reset-password.exchange.implicit.result", { error: exchangeError });
      } else if (initialState.kind === "recovery_session") {
        // No tokens to exchange — poll briefly for supabase-js's async parse
        // to land. The onAuthStateChange listener will also fire, and
        // whichever wins the race dispatches SESSION_MATERIALIZED.
        let found = false;
        let iterations = 0;
        for (let i = 0; i < 30; i++) {
          if (cancelled) return;
          iterations = i + 1;
          const { data } = await supabase.auth.getSession();
          if (data.session) { found = true; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        trace("reset-password.exchange.recovery_session.result", { found, iterations });
        if (!found) exchangeError = "No reset session was found.";
      }

      if (cancelled) return;

      if (exchangeError) {
        safeDispatch({
          type: "EXCHANGE_FAILED",
          message: describeLinkError(null, exchangeError),
        });
        return;
      }

      // An exchange that resolved without an error establishes the session
      // by construction (pkce/token_hash/implicit) or by the just-completed
      // getSession poll (recovery_session). Commit deterministically — the
      // listener may also fire SESSION_MATERIALIZED and the reducer will
      // ignore the duplicate.
      cleanResetLinkUrl();
      setResetSessionReady(true);
      safeDispatch({ type: "SESSION_MATERIALIZED" });
    })();

    return cleanup;
  }, []);

  const handleRequest = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = z.string().trim().email().safeParse(email);
    if (!parsed.success) {
      toast.error("Please enter a valid email");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) toast.error(error.message);
    else toast.success("Check your inbox for the reset link.");
  };

  const handleUpdate = async (e: FormEvent) => {
    e.preventDefault();
    if (!passwordStrongEnough) {
      toast.error("Please choose a stronger password");
      return;
    }
    if (!passwordsMatch) {
      toast.error("Passwords do not match");
      return;
    }
    const parsed = z.string().min(8).max(128).safeParse(password);
    if (!parsed.success) {
      toast.error("Password must be 8–128 characters");
      return;
    }
    setBusy(true);
    trace("reset-password.handleUpdate.begin");
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    trace("reset-password.handleUpdate.getSession", {
      session: describeSession(sessionData.session),
      error: sessionError?.message ?? null,
    });
    if (sessionError || !sessionData.session) {
      setBusy(false);
      dispatch({
        type: "EXCHANGE_FAILED",
        message:
          "Your reset session has expired or could not be verified. Please request a new reset link.",
      });
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: parsed.data });
    trace("reset-password.handleUpdate.updateUser", { error: error?.message ?? null });
    if (error) {
      setBusy(false);
      toast.error(error.message);
      return;
    }
    // Sign the recovery session out so the user must log in with the new password.
    trace("reset-password.handleUpdate.signOut.begin", { reason: "post-password-update" });
    await supabase.auth.signOut();
    trace("reset-password.handleUpdate.signOut.done");
    setResetSessionReady(false);
    setBusy(false);
    toast.success("Password updated. Please sign in with your new password.");
    void navigate({ to: "/login" });
  };

  const startOver = () => {
    trace("reset-password.startOver", {
      url: typeof window !== "undefined" ? describeRecoveryUrl(window.location.href) : null,
    });
    setPassword("");
    setConfirmPassword("");
    setResetSessionReady(false);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/reset-password");
    }
    dispatch({ type: "USER_START_OVER" });
  };

  const isChecking =
    mode === "initializing" || mode === "probing" || mode === "verifying";
  const title =
    mode === "request"
      ? "Reset password"
      : isChecking
        ? "Verifying reset link"
        : mode === "update"
          ? "Set a new password"
          : "Reset link not valid";
  const description =
    mode === "request"
      ? "We'll email you a link to reset your password."
      : isChecking
        ? "Please wait while we verify your password reset link."
        : mode === "update"
          ? "Choose a new password for your account."
          : "The link you followed can't be used to reset your password.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {mode === "request" ? (
            <form onSubmit={handleRequest} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Sending…" : "Send reset link"}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="font-medium text-foreground hover:underline">
                  Back to sign in
                </Link>
              </p>
            </form>
          ) : isChecking ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground" role="status">
              Verifying your reset link…
            </div>
          ) : mode === "update" ? (
            <form onSubmit={handleUpdate} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={password.length > 0 && !passwordStrongEnough}
                  aria-describedby="password-requirements"
                  required
                />
                <ul
                  id="password-requirements"
                  data-testid="password-requirements"
                  className="space-y-1 text-xs"
                  aria-live="polite"
                >
                  {passwordChecks.map((c) => (
                    <li
                      key={c.id}
                      data-testid={`pw-check-${c.id}`}
                      data-ok={c.ok ? "true" : "false"}
                      className={`flex items-center gap-1.5 ${
                        c.ok ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                      }`}
                    >
                      {c.ok ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span>{c.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  aria-invalid={confirmPassword.length > 0 && !passwordsMatch}
                  aria-describedby="confirm-password-error"
                  required
                />
                {confirmPassword.length > 0 && !passwordsMatch ? (
                  <p
                    id="confirm-password-error"
                    data-testid="confirm-password-error"
                    className="text-xs text-destructive"
                  >
                    Passwords do not match.
                  </p>
                ) : null}
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={!canSubmitUpdate}
                aria-disabled={!canSubmitUpdate}
              >
                {busy ? "Updating…" : "Update password"}
              </Button>
            </form>
          ) : (
            <div className="space-y-4" role="alert" aria-live="polite" data-testid="reset-link-error">
              <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{errorMessage ?? "We couldn't verify this password reset link."}</p>
              </div>
              <Button type="button" className="w-full" onClick={startOver}>
                Request a new reset link
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <Link to="/login" className="font-medium text-foreground hover:underline">
                  Back to sign in
                </Link>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
