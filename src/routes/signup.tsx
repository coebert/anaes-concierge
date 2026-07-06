import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { submitAccessRequest } from "@/lib/access-requests.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Stethoscope } from "lucide-react";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [{ title: "Request access — Salisbury Anaesthetics Rota" }],
  }),
  component: RequestAccessPage,
});

const schema = z.object({
  full_name: z.string().trim().min(1, "Full name is required").max(120),
  email: z.string().trim().email("Enter a valid email").max(255),
  message: z.string().trim().max(1000).optional(),
});

function RequestAccessPage() {
  const submit = useServerFn(submitAccessRequest);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse({ full_name: fullName, email, message: message || undefined });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setBusy(true);
    try {
      await submit({ data: parsed.data });
      setSent(true);
      toast.success("Request submitted. An admin will be in touch.");
    } catch {
      toast.error("Could not submit request. Please try again.");
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
          <CardTitle className="text-2xl">Request access</CardTitle>
          <CardDescription>
            This app is invite-only. Tell us who you are and an admin will set up your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4 text-center text-sm text-muted-foreground">
              <p>Your request has been sent to the rota admins. You will receive an invitation email once it is approved.</p>
              <Button asChild className="w-full">
                <Link to="/login">Back to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Work email</Label>
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
                <Label htmlFor="message">Message (optional)</Label>
                <Textarea
                  id="message"
                  rows={3}
                  placeholder="Your role, department, or anything that helps an admin verify you."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={1000}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Sending request…" : "Request access"}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Already invited?{" "}
                <Link to="/login" className="font-medium text-foreground hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
