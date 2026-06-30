import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { shouldDropSessionOnLoad } from "@/lib/remember-me";

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
  if (window.location.pathname !== "/reset-password") return false;

  const url = new URL(window.location.href);
  const hashParams = new URLSearchParams(
    window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "",
  );

  return (
    url.searchParams.has("code") ||
    url.searchParams.get("type") === "recovery" ||
    url.searchParams.has("token_hash") ||
    hashParams.get("type") === "recovery" ||
    hashParams.has("access_token") ||
    hashParams.has("error")
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [grade, setGrade] = useState<StaffGrade | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = async (userId: string | undefined) => {
    if (!userId) {
      setRoles([]);
      setGrade(null);
      setFullName(null);
      return;
    }
    const [{ data: roleRows, error: rolesErr }, { data: profile, error: profErr }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.from("profiles").select("grade, full_name").eq("id", userId).maybeSingle(),
    ]);
    if (rolesErr) console.error("Failed to load roles", rolesErr);
    if (profErr) console.error("Failed to load profile", profErr);
    setRoles((roleRows ?? []).map((r) => r.role as AppRole));
    setGrade((profile?.grade ?? null) as StaffGrade | null);
    setFullName(profile?.full_name ?? null);
  };

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setTimeout(() => {
        void loadProfile(newSession?.user.id);
      }, 0);
    });

    // If the user previously unchecked "Keep me signed in" AND this is a fresh
    // browser session (no sessionStorage marker), drop the persisted session
    // before restoring it. Otherwise restore normally.
    const dropSession = !isPasswordRecoveryUrl() && shouldDropSessionOnLoad();
    const init = async () => {
      if (dropSession) {
        await supabase.auth.signOut();
        setSession(null);
        setLoading(false);
        return;
      }
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      await loadProfile(data.session?.user.id);
      setLoading(false);
    };
    void init();

    return () => sub.subscription.unsubscribe();
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
        await supabase.auth.signOut();
      },
      refreshRoles: async () => {
        await loadProfile(session?.user.id);
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
