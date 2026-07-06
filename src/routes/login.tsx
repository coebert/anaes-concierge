import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/lib/auth-context";
import { getRememberMe, setRememberMe } from "@/lib/remember-me";
import { listMyPasskeys } from "@/lib/passkeys.functions";
import {
  OfferPasskeyRegistration,
  shouldOfferPasskey,
} from "@/components/offer-passkey-registration";
import { PasskeyLoginButton } from "@/components/passkey-login-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Stethoscope } from "lucide-react";

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

  const listPk = useServerFn(listMyPasskeys);

  useEffect(() => {
    if (!loading && isAuthenticated && !offerPasskey) {
      void navigate({ to: "/" });
    }
  }, [loading, isAuthenticated, navigate, offerPasskey]);

  const goHome = () => {
    setOfferPasskey(false);
    void navigate({ to: "/" });
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
    const offer = await shouldOfferPasskey(listPk);
    if (offer) setOfferPasskey(true);
    else void navigate({ to: "/" });
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Stethoscope className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">Salisbury Anaesthetics Rota</CardTitle>
          <CardDescription>
            Sign in to manage and view the department rota.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {offerPasskey ? (
            <OfferPasskeyRegistration onDone={goHome} />
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username webauthn"
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
                    autoComplete="current-password webauthn"
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
                  <Label
                    htmlFor="remember"
                    className="text-sm font-normal cursor-pointer"
                  >
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

              <PasskeyLoginButton
                email={email}
                disabled={busy}
                onSuccess={() => {
                  setRememberMe(remember);
                  void navigate({ to: "/" });
                }}
              />

              <p className="text-center text-sm text-muted-foreground">
                Need access?{" "}
                <Link
                  to="/signup"
                  className="font-medium text-foreground hover:underline"
                >
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
