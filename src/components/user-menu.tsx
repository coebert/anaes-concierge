import { useNavigate, Link } from "@tanstack/react-router";
import { LogOut, User as UserIcon, Settings } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

function initialsFrom(name: string | null | undefined, email: string | null | undefined) {
  const source = (name && name.trim()) || (email ?? "");
  if (!source) return "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || source[0]?.toUpperCase() || "?";
}

export function UserMenu() {
  const { user, roles, grade, fullName, signOut, hasRole } = useAuth();
  const navigate = useNavigate();

  const isAdmin = hasRole("admin");
  const roleLabel = isAdmin
    ? "Admin"
    : roles.includes("rota_coordinator")
    ? "Coordinator"
    : grade === "trainee"
    ? "Trainee"
    : grade === "consultant"
    ? "Consultant"
    : grade === "sas"
    ? "SAS"
    : "Staff";

  const initials = initialsFrom(fullName, user?.email);
  const displayName = fullName || user?.email || "Signed in";

  const onSignOut = async () => {
    await signOut();
    void navigate({ to: "/login" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-2 pl-1 pr-2"
          aria-label="Open account menu"
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="bg-primary text-[11px] font-semibold text-primary-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
            {roleLabel}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="space-y-0.5">
          <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
          {user?.email && fullName ? (
            <div className="truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </div>
          ) : null}
          <div className="pt-1 text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
            {roleLabel}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/me" className="flex items-center gap-2">
            <UserIcon className="h-4 w-4" />
            <span>My profile</span>
          </Link>
        </DropdownMenuItem>
        {isAdmin ? (
          <DropdownMenuItem asChild>
            <Link to="/admin/settings" className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              <span>Admin settings</span>
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut} className="flex items-center gap-2">
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
