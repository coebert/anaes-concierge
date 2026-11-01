import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AuthIdentityGuard } from "@/lib/auth-identity";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { shouldDropSessionOnLoad } from "@/lib/remember-me";
import { describeRecoveryUrl, describeSession, trace, traceError } from "@/lib/auth-trace";

export type AppRole = "admin" | "rota_coordinator" | "staff";
export type StaffGrade = "consultant" | "sas" | "trainee";

export interface AuthState {
  session: Session | null;
  user: User | null;
  roles: AppRole[];
  grade: StaffGrade | null;
  fullName: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  hasRole: (role: AppRole) => boolean;
  isCoordinatorOrAdmin: () => boolean;
  isTrainee: () => boolean;
  signOut: () => Promise<void>;
  refreshRoles: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function isPasswordRecoveryUrl(): boolean {
  if (typeof window === "undefined") return false;
  // The reset-password route is the only place a Supabase recovery session
  // is ever legitimate. Never drop the session there — regardless of which
  // flow variant (PKCE / implicit / token_hash) the link uses, and even if
  // supabase-js has already consumed the URL fragment before we look. The
  // request-link sub-state is harmless because there's no session to drop.
  const match = window.location.pathname === "/reset-password";
  trace("auth-context.isPasswordRecoveryUrl", {
    pathname: window.location.pathname,
    matched: match,
    url: describeRecoveryUrl(window.location.href),
  });
  return match;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [grade, setGrade] = useState<StaffGrade | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();
  const guardRef = useRef<AuthIdentityGuard | null>(null);
  if (!guardRef.current) guardRef.current = new AuthIdentityGuard(queryClient);

  /**
   * Fetch roles/profile for `userId` and install them only if the identity is
   * still the one the load started for. Ends the loading gate for that load.
   */
  const loadProfile = async (
    userId: string | null,
    scheduledToken?: { userId: string | null; generation: number },
  ) => {
    const guard = guardRef.current!;
    // Token is captured when the load is SCHEDULED, so a deferred load for a
    // superseded identity (e.g. sign-out's null load firing after B signed in)
    // can never touch B's loading gate.
    const token = scheduledToken ?? guard.beginLoad(userId);
    if (!userId) {
      if (guard.isCurrent(token)) setLoading(false);
      return;
    }
    try {
      const [{ data: roleRows, error: rolesErr }, { data: profile, error: profErr }] =
        await Promise.all([
          supabase.from("user_roles").select("role").eq("user_id", userId),
          supabase.from("profiles").select("grade, full_name").eq("id", userId).maybeSingle(),
        ]);
      // Identity moved on while we were fetching: never install stale roles.
      if (!guard.isCurrent(token)) return;
      if (rolesErr) console.error("Failed to load roles", rolesErr);
      if (profErr) console.error("Failed to load profile", profErr);
      setRoles((roleRows ?? []).map((r) => r.role as AppRole));
      setGrade((profile?.grade ?? null) as StaffGrade | null);
      setFullName(profile?.full_name ?? null);
    } catch (err) {
      if (!guard.isCurrent(token)) return;
      console.error("Failed to load roles/profile", err);
    }
    if (guard.isCurrent(token)) setLoading(false);
  };

  /**
   * Install a session. On an identity change everything derived from the
   * previous identity is reset IN THE SAME SYNCHRONOUS BATCH as publishing the
   * new session, and the loading gate closes before B is visible, so no render
   * ever pairs B's session with A's roles/name/cache. Same-user events (token
   * refresh) only swap the session object.
   */
  const applySession = (next: Session | null, source: string) => {
    const guard = guardRef.current!;
    const nextId = next?.user.id ?? null;
    if (!guard.isChange(nextId)) {
      setSession(next);
      return;
    }
    guard.setIdentity(nextId); // sync: bumps generation, purges cache
    setRoles([]);
    setGrade(null);
    setFullName(null);
    setLoading(nextId !== null);
    setSession(next);
    trace("auth-context.identityChanged", { source, hasUser: nextId !== null });
    // Defer network work out of the auth callback (supabase-js lock rule);
    // the generation token makes a superseded load a no-op.
    const token = guard.beginLoad(nextId);
    setTimeout(() => void loadProfile(nextId, token), 0);
  };
  const applyRef = useRef(applySession);
  applyRef.current = applySession;

  useEffect(() => {
    trace("auth-context.mount", {
      url: typeof window !== "undefined" ? describeRecoveryUrl(window.location.href) : null,
    });
    let authEventSeen = false;
    let disposed = false;
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      trace("auth-context.onAuthStateChange", {
        event,
        session: describeSession(newSession),
        pathname: typeof window !== "undefined" ? window.location.pathname : null,
      });
      authEventSeen = true;
      applyRef.current(newSession, `event:${event}`);
    });

    // If the user previously unchecked "Keep me signed in" AND this is a fresh
    // browser session (no sessionStorage marker), drop the persisted session
    // before restoring it. Otherwise restore normally.
    const isRecovery = isPasswordRecoveryUrl();
    const wantsDrop = shouldDropSessionOnLoad();
    const dropSession = !isRecovery && wantsDrop;
    trace("auth-context.dropSessionDecision", {
      isRecovery,
      shouldDropSessionOnLoad: wantsDrop,
      dropSession,
    });
    const init = async () => {
      if (dropSession) {
        trace("auth-context.init.signOut.begin", { reason: "remember-me-cleared" });
        try {
          await supabase.auth.signOut();
          trace("auth-context.init.signOut.done");
        } catch (err) {
          traceError("auth-context.init.signOut.error", err);
        }
        if (!disposed) applyRef.current(null, "init:drop");
        return;
      }
      let initial: Session | null = null;
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) traceError("auth-context.init.getSession.error", error);
        initial = data.session;
      } catch (err) {
        traceError("auth-context.init.getSession.throw", err);
      }
      trace("auth-context.init.getSession", { session: describeSession(initial) });
      // An auth event that arrived while getSession was pending is newer;
      // never let the (possibly stale) initial snapshot overwrite it.
      if (disposed || authEventSeen) return;
      applyRef.current(initial, "init:getSession");
    };
    void init();

    return () => {
      disposed = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(() => {
    const hasRole = (role: AppRole) => roles.includes(role);
    return {
      session,
      user: session?.user ?? null,
      roles,
      grade,
      fullName,
      isAuthenticated: !!session,
      loading,
      hasRole,
      isCoordinatorOrAdmin: () => hasRole("admin") || hasRole("rota_coordinator"),
      isTrainee: () => grade === "trainee",
      signOut: async () => {
        trace("auth-context.signOut", {
          pathname: typeof window !== "undefined" ? window.location.pathname : null,
          session: describeSession(session),
        });
        // Purge local identity first so nothing private renders while the
        // network sign-out is pending (or if it fails).
        applySession(null, "signOut");
        await supabase.auth.signOut();
      },
      refreshRoles: async () => {
        await loadProfile(session?.user.id ?? null);
      },
    };
  }, [session, roles, grade, fullName, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
