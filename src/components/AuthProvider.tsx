import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getSession, signOut, subscribeToAuthChanges } from "../lib/supabase";
import { syncEngine } from "../lib/syncEngine";
import type { SyncStateSnapshot } from "../types";

type AuthContextType = {
  user: any | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const initSession = async () => {
      try {
        const session = await getSession();
        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);
        syncEngine.startLifecycle(currentUser?.id ?? null);
      } catch (error) {
        console.error("Error checking session:", error);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    initSession();

    const unsubscribe = subscribeToAuthChanges((event, session) => {
      if (!mounted) return;
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      setLoading(false);

      if (event === "SIGNED_OUT") {
        syncEngine.stopLifecycle();
        syncEngine.startLifecycle(null);
      } else if (
        event === "SIGNED_IN" ||
        event === "TOKEN_REFRESHED" ||
        event === "USER_UPDATED" ||
        event === "INITIAL_SESSION"
      ) {
        syncEngine.startLifecycle(nextUser?.id ?? null);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
      syncEngine.stopLifecycle();
    };
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut();
      setUser(null);
      syncEngine.stopLifecycle();
      syncEngine.startLifecycle(null);
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

export function useSyncStatus(): SyncStateSnapshot {
  return useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);
}
