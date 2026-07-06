import { Link, useLocation, useRouterState } from "@tanstack/react-router";
import { type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { Stethoscope, ChevronRight } from "lucide-react";
import { UserMenu } from "@/components/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  filterNavForUser,
  groupNav,
  NAV_GROUPS,
  type NavGroup,
  type NavItem,
} from "@/lib/navigation";
import { CommandPalette } from "@/components/command-palette";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, roles, hasRole, grade, fullName } = useAuth();
  const location = useLocation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isAdmin = hasRole("admin");
  const visibleItems = filterNavForUser({ hasRole, grade });
  const grouped = groupNav(visibleItems);

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

  const identityLine = fullName || user?.email || "Signed in";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="border-b">
          <div className="flex items-center gap-2 px-2 py-1">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Stethoscope className="h-4 w-4" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <div className="truncate text-sm font-semibold">Anaesthetics Audit</div>
              <div className="truncate text-xs text-muted-foreground">Salisbury DGH</div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {NAV_GROUPS.map((group) => {
            const items = grouped.get(group.id) ?? [];
            if (items.length === 0) return null;
            return (
              <NavSectionGroup
                key={group.id}
                group={group}
                items={items}
                pathname={pathname}
              />
            );
          })}
        </SidebarContent>

        <SidebarFooter className="border-t">
          <div className="px-2 py-1 group-data-[collapsible=icon]:hidden">
            <div className="truncate text-sm font-medium">{identityLine}</div>
            <div className="text-xs text-muted-foreground">{roleLabel}</div>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card/95 px-3 py-2 backdrop-blur">
          <SidebarTrigger />
          <div className="ml-auto flex items-center gap-2">
            <CommandPalette />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl p-3 sm:p-4 md:p-8">
          <Breadcrumbs pathname={location.pathname} items={visibleItems} />
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function isActive(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(to + "/");
}

function NavSectionGroup({
  group,
  items,
  pathname,
}: {
  group: NavGroup;
  items: NavItem[];
  pathname: string;
}) {
  const hasActive = items.some((i) => isActive(pathname, i.to));
  const defaultOpen = group.defaultOpen ?? true;
  const open = hasActive || defaultOpen;

  // Home and Account groups are single-item — render flat without collapsible chrome.
  if (items.length === 1 && (group.id === "home" || group.id === "account")) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((item) => (
              <NavLeaf key={item.id} item={item} pathname={pathname} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <Collapsible defaultOpen={open} className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="flex w-full items-center justify-between">
            <span>{group.label}</span>
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <NavLeaf key={item.id} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function NavLeaf({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const active = isActive(pathname, item.to);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link to={item.to} className={cn("flex items-center gap-2")}>
          <Icon className="h-4 w-4" />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Breadcrumbs({ pathname, items }: { pathname: string; items: NavItem[] }) {
  if (pathname === "/") return null;
  // Find the nav item whose `to` is the longest prefix of pathname.
  const match = items
    .filter((i) => i.to !== "/" && (pathname === i.to || pathname.startsWith(i.to + "/")))
    .sort((a, b) => b.to.length - a.to.length)[0];
  const label = match?.label ?? prettifySegment(pathname);
  return (
    <nav className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground md:mb-4">
      <Link to="/" className="hover:text-foreground">Home</Link>
      <ChevronRight className="h-3 w-3" />
      <span className="text-foreground">{label}</span>
    </nav>
  );
}

function prettifySegment(pathname: string) {
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
