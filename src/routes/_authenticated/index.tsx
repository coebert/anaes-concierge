import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CalendarDays,
  ClipboardList,
  GraduationCap,
  MessageSquare,
  Building2,
  Users,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { user, roles } = useAuth();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">
            {user?.email} · {roles.length ? roles.join(", ") : "no role assigned yet"}
          </p>
        </div>
        <Badge variant="secondary">Salisbury DGH · Anaesthetics</Badge>
      </header>

      {!roles.length && (
        <Card className="border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
          <CardHeader>
            <CardTitle className="text-base">You don't have a role yet</CardTitle>
            <CardDescription className="text-amber-900 dark:text-amber-200">
              An administrator needs to assign you a role. The very first person to sign up
              should be granted the <code>admin</code> role from the backend to get started.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <DashCard icon={CalendarDays} title="Global calendar" body="See the full theatre grid by day, week or month." />
        <DashCard icon={ClipboardList} title="Leave" body="Submit or review annual, study and compassionate leave." />
        <DashCard icon={GraduationCap} title="Trainee progress" body="Track subspecialty exposure against curriculum targets." />
        <DashCard icon={MessageSquare} title="AI assistant" body="Ask questions about your rota or leave in plain English." />
        <DashCard icon={Users} title="Staff & job plans" body="Configure PAs, LTFT, and fixed weekly sessions." />
        <DashCard icon={Building2} title="Theatres" body="10 main theatres + Day Surgery A / B / F, AM and PM sessions." />
      </div>
    </div>
  );
}

function DashCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof CalendarDays;
  title: string;
  body: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}
