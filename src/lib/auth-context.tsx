import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "admin" | "rota_coordinator" | "staff";

export interface AuthState {
  session: Session | null;
  user: User | null;
  roles: AppRole[];
  isAuthenticated: boolean;
  loading: boolean;
  hasRole: (role: AppRole) => boolean;
  isCoordinatorOrAdmin: () => boolean;
  signOut: () => Promise<void>;
  refreshRoles: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRoles = async (userId: string | undefined) => {
    if (!userId) {
      setRoles([]);
      return;
    }
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    if (error) {
      console.error("Failed to load roles", error);
      setRoles([]);
      return;
    }
    setRoles((data ?? []).map((r) => r.role as AppRole));
  };

  useEffect(() => {
    // Set up listener FIRST
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Defer Supabase calls to avoid deadlocks in the callback
      setTimeout(() => {
        void loadRoles(newSession?.user.id);
      }, 0);
    });

    // Then fetch existing session
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      void loadRoles(data.session?.user.id).finally(() => setLoading(false));
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthState>(() => {
    const hasRole = (role: AppRole) => roles.includes(role);
    return {
      session,
      user: session?.user ?? null,
      roles,
      isAuthenticated: !!session,
      loading,
      hasRole,
      isCoordinatorOrAdmin: () => hasRole("admin") || hasRole("rota_coordinator"),
      signOut: async () => {
        await supabase.auth.signOut();
      },
      refreshRoles: async () => {
        await loadRoles(session?.user.id);
      },
    };
  }, [session, roles, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
