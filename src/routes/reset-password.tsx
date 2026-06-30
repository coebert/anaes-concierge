import { createFileRoute, Link } from "@tanstack/react-router";
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

type Mode = "request" | "update" | "error";

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

function ResetPasswordPage() {
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

    // Supabase may report a failed link via either query or hash fragment.
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(
      window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "",
    );
    const errorCode =
      url.searchParams.get("error") ?? hashParams.get("error") ?? hashParams.get("error_code");
    const errorDescription =
      url.searchParams.get("error_description") ?? hashParams.get("error_description");

    if (errorCode || errorDescription) {
      setErrorMessage(describeLinkError(errorCode, errorDescription));
      setMode("error");
      return;
    }

    // Legacy implicit flow: tokens arrive in the URL hash as #type=recovery.
    if (window.location.hash.includes("type=recovery")) {
      setMode("update");
    }

    // Current PKCE flow: the email link returns ?code=<otp>. Exchange it
    // for a session, then show the new-password form.
    const code = url.searchParams.get("code");
    if (code) {
      void (async () => {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          setErrorMessage(describeLinkError(null, error.message));
          setMode("error");
          return;
        }
        // Clean the code out of the URL so refresh doesn't re-exchange.
        url.searchParams.delete("code");
        window.history.replaceState({}, "", url.pathname + url.search + url.hash);
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
    const { error } = await supabase.auth.updateUser({ password: parsed.data });
    setBusy(false);
    if (error) toast.error(error.message);
    else toast.success("Password updated. You can sign in now.");
  };

  const startOver = () => {
    setErrorMessage(null);
    setPassword("");
    setConfirmPassword("");
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", "/reset-password");
    }
    setMode("request");
  };

  const title =
    mode === "request"
      ? "Reset password"
      : mode === "update"
        ? "Set a new password"
        : "Reset link not valid";
  const description =
    mode === "request"
      ? "We'll email you a link to reset your password."
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
