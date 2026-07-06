import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/lib/auth-context";
import { getRememberMe, setRememberMe } from "@/lib/remember-me";
import {
  startPasskeyAuthentication,
  verifyPasskeyAuthentication,
  startPasskeyRegistration,
  verifyPasskeyRegistration,
  listMyPasskeys,
} from "@/lib/passkeys.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Fingerprint, Stethoscope } from "lucide-react";


export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const schema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(6).max(128),
});

function LoginPage() {
  const navigate = useNavigate();
  const { isAuthenticated, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => getRememberMe());
  const [busy, setBusy] = useState(false);
  const [offerPasskey, setOfferPasskey] = useState(false);
  const [enrolling, setEnrolling] = useState(false);

  useEffect(() => {
    if (!loading && isAuthenticated && !offerPasskey) {
      void navigate({ to: "/" });
    }
  }, [loading, isAuthenticated, navigate, offerPasskey]);

  const listPk = useServerFn(listMyPasskeys);
  const startReg = useServerFn(startPasskeyRegistration);
  const verifyReg = useServerFn(verifyPasskeyRegistration);

  const maybeOfferPasskey = async (): Promise<boolean> => {
    if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
    try {
      const available =
        await (window.PublicKeyCredential as any).isUserVerifyingPlatformAuthenticatorAvailable?.();
      if (!available) return false;
      const existing = await listPk();
      if (Array.isArray(existing) && existing.length === 0) {
        setOfferPasskey(true);
        return true;
      }
    } catch {
      // ignore — fall through to normal navigation
    }
    return false;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setBusy(true);
    setRememberMe(remember);
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const offered = await maybeOfferPasskey();
    if (!offered) void navigate({ to: "/" });
  };

  const enrollPasskeyNow = async () => {
    setEnrolling(true);
    try {
      const options = await startReg();
      const attResp = await startRegistration({ optionsJSON: options as any });
      const ua = navigator.userAgent;
      const deviceName = /iPhone|iPad|iPod/i.test(ua)
        ? "iOS device"
        : /Android/i.test(ua)
          ? "Android device"
          : /Mac/i.test(ua)
            ? "Mac"
            : /Windows/i.test(ua)
              ? "Windows device"
              : "This device";
      await verifyReg({ data: { response: attResp, deviceName } });
      toast.success("Passkey registered — you can use it next time");
      setOfferPasskey(false);
      void navigate({ to: "/" });
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        toast.error("Cancelled");
      } else {
        toast.error(e?.message ?? "Failed to register passkey");
      }
    } finally {
      setEnrolling(false);
    }
  };

  const skipPasskey = () => {
    setOfferPasskey(false);
    void navigate({ to: "/" });
  };

  const handleGoogle = async () => {
    setBusy(true);
    setRememberMe(remember);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      setBusy(false);
      toast.error(result.error.message ?? "Google sign-in failed");
      return;
    }
    if (result.redirected) return;
    void navigate({ to: "/" });
  };

  const startPk = useServerFn(startPasskeyAuthentication);
  const verifyPk = useServerFn(verifyPasskeyAuthentication);

  const handlePasskey = async () => {
    const parsed = z.string().trim().email().safeParse(email);
    if (!parsed.success) {
      toast.error("Enter your email first");
      return;
    }
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      toast.error("This device does not support passkeys.");
      return;
    }
    setBusy(true);
    setRememberMe(remember);
    try {
      const { options } = await startPk({ data: { email: parsed.data } });
      // No enumeration signal — always attempt the ceremony. If the account
      // has no passkey, verifyPasskeyAuthentication rejects uniformly.

      const assertion = await startAuthentication({ optionsJSON: options as any });
      const { tokenHash } = await verifyPk({
        data: { email: parsed.data, response: assertion },
      });
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });
      if (error) throw error;
      void navigate({ to: "/" });
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        toast.error("Cancelled");
      } else {
        toast.error(e?.message ?? "Passkey sign-in failed");
      }
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Stethoscope className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">Salisbury Anaesthetics Rota</CardTitle>
          <CardDescription>Sign in to manage and view the department rota.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {offerPasskey ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Fingerprint className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <p className="font-medium">Set up a passkey for faster sign-in?</p>
                <p className="text-sm text-muted-foreground">
                  Use Face ID, Touch ID, or Windows Hello to sign in without a password next time on this device.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Button onClick={enrollPasskeyNow} disabled={enrolling}>
                  {enrolling ? "Registering…" : "Register a passkey"}
                </Button>
                <Button variant="ghost" onClick={skipPasskey} disabled={enrolling}>
                  Not now
                </Button>
              </div>
            </div>
          ) : (
          <>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link
                  to="/reset-password"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Forgot?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="remember"
                checked={remember}
                onCheckedChange={(v) => setRemember(v === true)}
              />
              <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">
                Keep me signed in
              </Label>
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogle}
            disabled={busy}
          >
            Continue with Google
          </Button>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handlePasskey}
            disabled={busy}
          >
            <Fingerprint className="mr-2 h-4 w-4" />
            Sign in with passkey
          </Button>


          <p className="text-center text-sm text-muted-foreground">
            Need access?{" "}
            <Link to="/signup" className="font-medium text-foreground hover:underline">
              Request access
            </Link>
          </p>
          </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
