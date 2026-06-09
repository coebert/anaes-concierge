import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";
import { useAuth, type AuthState } from "@/lib/auth-context";
import { filterNavForUser, groupNav, NAV_GROUPS } from "@/lib/navigation";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { hasRole, grade } = useAuth();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = filterNavForUser({ hasRole, grade });
  const grouped = groupNav(items);

  const run = (to: string) => {
    setOpen(false);
    void navigate({ to });
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-9 w-full justify-start gap-2 text-muted-foreground sm:w-64"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Search tools…</span>
        <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] sm:inline">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Jump to a tool or view…" />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          {NAV_GROUPS.map((g, i) => {
            const groupItems = grouped.get(g.id) ?? [];
            if (groupItems.length === 0) return null;
            return (
              <div key={g.id}>
                {i > 0 && <CommandSeparator />}
                <CommandGroup heading={g.label}>
                  {groupItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <CommandItem
                        key={item.id}
                        value={`${item.label} ${(item.keywords ?? []).join(" ")} ${item.to}`}
                        onSelect={() => run(item.to)}
                      >
                        <Icon className="mr-2 h-4 w-4" />
                        {item.label}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </div>
            );
          })}
        </CommandList>
      </CommandDialog>
    </>
  );
}

// re-export to make TypeScript happy when AuthState isn't directly referenced
export type _UnusedAuthState = AuthState;
