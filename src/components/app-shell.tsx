import { Link, useLocation, useRouterState } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";
import { Stethoscope, ChevronRight, Search, X } from "lucide-react";
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
  useSidebar,
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

  const isAdmin = hasRole("admin");
  const visibleItems = filterNavForUser({ hasRole, grade });

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

        <SidebarNavBody visibleItems={visibleItems} />

        <SidebarFooter className="border-t">
          <div className="px-2 py-1 group-data-[collapsible=icon]:hidden">
            <div className="truncate text-sm font-medium">{identityLine}</div>
            <div className="text-xs text-muted-foreground">{roleLabel}</div>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <a href="#main-content" className="skip-to-content">Skip to content</a>
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-card/70">
          <SidebarTrigger aria-label="Toggle navigation" />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <CommandPalette />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-7xl p-3 sm:p-4 md:p-8 focus:outline-none"
        >
          <Breadcrumbs pathname={location.pathname} items={visibleItems} />
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function normaliseSearch(s: string) {
  return s.toLowerCase().trim();
}

function itemMatchesQuery(item: NavItem, q: string) {
  if (!q) return true;
  const hay = [item.label, ...(item.keywords ?? [])].join(" ").toLowerCase();
  return hay.includes(q);
}

function SidebarNavBody({ visibleItems }: { visibleItems: NavItem[] }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [query, setQuery] = useState("");
  const q = normaliseSearch(query);

  const filteredItems = useMemo(
    () => (q ? visibleItems.filter((i) => itemMatchesQuery(i, q)) : visibleItems),
    [visibleItems, q],
  );
  const grouped = useMemo(() => groupNav(filteredItems), [filteredItems]);
  const hasResults = filteredItems.length > 0;

  return (
    <SidebarContent>
      {/* Quick search — collapses away when the sidebar is in icon-only mode
          but stays visible on mobile (drawer) and expanded desktop. */}
      <div className="px-2 pt-2 pb-1 group-data-[collapsible=icon]:hidden">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            role="searchbox"
            aria-label="Search menu"
            placeholder="Search menu…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-7 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {!hasResults && q ? (
        <div className="px-3 py-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          No matches for &ldquo;{query}&rdquo;.
        </div>
      ) : null}

      {NAV_GROUPS.map((group) => {
        const items = grouped.get(group.id) ?? [];
        if (items.length === 0) return null;
        return (
          <NavSectionGroup
            key={group.id}
            group={group}
            items={items}
            pathname={pathname}
            forceOpen={Boolean(q)}
          />
        );
      })}
    </SidebarContent>
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
  forceOpen = false,
}: {
  group: NavGroup;
  items: NavItem[];
  pathname: string;
  /** When true (e.g. an active search), the group and its rare bucket
   *  are forced open so every matching item is visible without extra clicks. */
  forceOpen?: boolean;
}) {
  const common = items.filter((i) => !i.rare);
  const rare = items.filter((i) => i.rare);
  const hasActiveCommon = common.some((i) => isActive(pathname, i.to));
  const hasActiveRare = rare.some((i) => isActive(pathname, i.to));
  const defaultOpen = group.defaultOpen ?? true;
  const open = forceOpen || hasActiveCommon || hasActiveRare || defaultOpen;

  return (
    <Collapsible key={forceOpen ? "open" : "auto"} defaultOpen={open} className="group/collapsible">
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
              {common.map((item) => (
                <NavLeaf key={item.id} item={item} pathname={pathname} />
              ))}
              {rare.length > 0 ? (
                <RareItems
                  items={rare}
                  pathname={pathname}
                  expandedByDefault={forceOpen || hasActiveRare}
                />
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function RareItems({
  items,
  pathname,
  expandedByDefault,
}: {
  items: NavItem[];
  pathname: string;
  expandedByDefault: boolean;
}) {
  return (
    <Collapsible defaultOpen={expandedByDefault} className="group/rare">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            tooltip="More"
            className="text-muted-foreground"
          >
            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]/rare:rotate-90" />
            <span>More</span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
      </SidebarMenuItem>
      <CollapsibleContent>
        {items.map((item) => (
          <NavLeaf key={item.id} item={item} pathname={pathname} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function NavLeaf({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const active = isActive(pathname, item.to);
  const { isMobile, setOpenMobile } = useSidebar();
  const handleClick = () => {
    // Auto-close the mobile drawer when a nav link is tapped, so the user
    // sees the destination page instead of the sheet.
    if (isMobile) setOpenMobile(false);
  };
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link to={item.to} onClick={handleClick} className={cn("flex items-center gap-2")}>
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

  // Section label from the matched item's group. Strip the "Admin · "
  // prefix used in the sidebar to keep the trail compact ("Analytics"
  // rather than "Admin · Analytics"); the top-level Home already anchors
  // the trail.
  const groupLabel = match
    ? NAV_GROUPS.find((g) => g.id === match.group)?.label.replace(/^Admin\s·\s/, "") ?? null
    : null;

  const itemLabel = match?.label ?? prettifySegment(pathname);

  // Any pathname segments beyond the matched nav item become extra crumbs,
  // e.g. matched item /admin/staff, current /admin/staff/$id → append the
  // trailing segments so users can see nested position.
  const extraSegments = match
    ? pathname
        .slice(match.to.length)
        .split("/")
        .filter(Boolean)
        .map((seg) => prettifySegment("/" + seg))
    : [];

  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground md:mb-4"
    >
      <Link to="/" className="hover:text-foreground">Home</Link>
      {groupLabel ? (
        <>
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{groupLabel}</span>
        </>
      ) : null}
      <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      {match ? (
        <Link
          to={match.to}
          className={cn(
            "truncate hover:text-foreground",
            extraSegments.length === 0 && "text-foreground",
          )}
          aria-current={extraSegments.length === 0 ? "page" : undefined}
        >
          {itemLabel}
        </Link>
      ) : (
        <span className="truncate text-foreground" aria-current="page">
          {itemLabel}
        </span>
      )}
      {extraSegments.map((seg, i) => {
        const isLast = i === extraSegments.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span
              className={cn("truncate", isLast && "text-foreground")}
              aria-current={isLast ? "page" : undefined}
            >
              {seg}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

function prettifySegment(pathname: string) {
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
