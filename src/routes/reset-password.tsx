import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const [mode, setMode] = useState<"request" | "update">("request");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Legacy implicit flow: tokens arrive in the URL hash as #type=recovery.
    // Supabase parses them automatically and fires PASSWORD_RECOVERY.
    if (window.location.hash.includes("type=recovery")) {
      setMode("update");
    }

    // Current PKCE flow: the email link returns ?code=<otp>. Exchange it
    // for a session, then show the new-password form.
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const errorDescription = url.searchParams.get("error_description");
    if (errorDescription) {
      toast.error(errorDescription);
    }
    if (code) {
      void (async () => {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          toast.error(error.message);
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
    const parsed = z.string().min(8).max(128).safeParse(password);
    if (!parsed.success) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: parsed.data });
    setBusy(false);
    if (error) toast.error(error.message);
    else toast.success("Password updated. You can sign in now.");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{mode === "request" ? "Reset password" : "Set a new password"}</CardTitle>
          <CardDescription>
            {mode === "request"
              ? "We'll email you a link to reset your password."
              : "Choose a new password for your account."}
          </CardDescription>
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
          ) : (
            <form onSubmit={handleUpdate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Updating…" : "Update password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
