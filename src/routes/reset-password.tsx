import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { z } from "zod";
import { AlertCircle, Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

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

type Mode = "request" | "checking" | "update" | "error";

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
    url.searchParams.get("error") ?? hashParams.get("error") ?? hashParams.get("error_code");
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
  const [mode, setMode] = useState<Mode>("request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const passwordChecks = useMemo(() => evaluatePassword(password), [password]);
  const passwordStrongEnough = passwordChecks.every((c) => c.ok);
  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const canSubmitUpdate = passwordStrongEnough && passwordsMatch && !busy;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const linkState = getResetLinkState(window.location.href);

    if (linkState.kind === "error") {
      setErrorMessage(linkState.message);
      setMode("error");
      cleanResetLinkUrl();
      return;
    }

    if (linkState.kind === "none") {
      if (!hasResetSessionReadyFlag()) {
        setMode("request");
      } else {
        setMode("checking");
        void (async () => {
          const { data, error } = await supabase.auth.getSession();
          if (error || !data.session) {
            setResetSessionReady(false);
            setMode("request");
            return;
          }
          setMode("update");
        })();
      }
    } else {
      setMode("checking");
      void (async () => {
        let exchangeError: string | null = null;

        if (linkState.kind === "pkce") {
          exchangeError = await exchangeResetLinkOnce(`pkce:${linkState.code}`, async () => {
            const { error } = await supabase.auth.exchangeCodeForSession(linkState.code);
            return error?.message ?? null;
          });
        } else if (linkState.kind === "token_hash") {
          exchangeError = await exchangeResetLinkOnce(`token_hash:${linkState.tokenHash}`, async () => {
            const { error } = await supabase.auth.verifyOtp({
              token_hash: linkState.tokenHash,
              type: "recovery",
            });
            return error?.message ?? null;
          });
        } else if (linkState.kind === "implicit") {
          const { error } = await supabase.auth.setSession({
            access_token: linkState.accessToken,
            refresh_token: linkState.refreshToken,
          });
          exchangeError = error?.message ?? null;
        } else if (linkState.kind === "recovery_session") {
          const { data, error } = await supabase.auth.getSession();
          exchangeError = error?.message ?? (!data.session ? "No reset session was found." : null);
        }

        if (exchangeError) {
          setErrorMessage(describeLinkError(null, exchangeError));
          setMode("error");
          return;
        }

        cleanResetLinkUrl();
        setResetSessionReady(true);
        setMode("update");
      })();
    }

    // Also catch the recovery event fired after Supabase auto-parses tokens.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setMode("update");
    });
    return () => sub.subscription.unsubscribe();
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
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setBusy(false);
      setErrorMessage(
        "Your reset session has expired or could not be verified. Please request a new reset link.",
      );
      setMode("error");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: parsed.data });
    if (error) {
      setBusy(false);
      toast.error(error.message);
      return;
    }
    // Sign the recovery session out so the user must log in with the new password.
    await supabase.auth.signOut();
    setResetSessionReady(false);
    setBusy(false);
    toast.success("Password updated. Please sign in with your new password.");
    void navigate({ to: "/login" });
  };

  const startOver = () => {
    setErrorMessage(null);
    setPassword("");
    setConfirmPassword("");
    setResetSessionReady(false);
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/reset-password");
    }
    setMode("request");
  };

  const title =
    mode === "request"
      ? "Reset password"
      : mode === "checking"
        ? "Verifying reset link"
      : mode === "update"
        ? "Set a new password"
        : "Reset link not valid";
  const description =
    mode === "request"
      ? "We'll email you a link to reset your password."
      : mode === "checking"
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
          ) : mode === "checking" ? (
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
