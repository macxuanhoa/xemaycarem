import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import type { User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AppError } from "@/lib/errors";
import type { Profile } from "@/types";
type AuthContextValue = {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [profile, setProfile] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  const client = useQueryClient();
  const identity = useRef<string | null>(null);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    if (!supabase) {
      setLoading(false);
      return;
    }
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (version !== refreshVersion.current) return;
      if (sessionError) throw sessionError;
      setUser(data.session?.user ?? null);
      if (!data.session) {
        if (identity.current) client.clear();
        identity.current = null;
        setProfile(null);
        setError(null);
        return;
      }
      if (!navigator.onLine) {
        if (identity.current?.startsWith(data.session.user.id + ":")) return;
        throw new AppError(
          "Không thể kết nối. Hãy mở lại ứng dụng khi có mạng để kiểm tra quyền truy cập.",
        );
      }
      const { data: row, error: profileError } = await supabase
        .from("profiles")
        .select("id,full_name,role,active,can_view_financials")
        .eq("id", data.session.user.id)
        .maybeSingle();
      if (version !== refreshVersion.current) return;
      if (profileError) throw profileError;
      if (!row?.active) {
        identity.current = null;
        setProfile(null);
        client.clear();
        throw new AppError(
          "Tài khoản chưa được cấp quyền hoặc đã bị khóa. Vui lòng liên hệ chủ cửa hàng.",
        );
      }
      const nextIdentity = `${row.id}:${row.role}:${row.can_view_financials}`;
      if (identity.current && identity.current !== nextIdentity) client.clear();
      identity.current = nextIdentity;
      setProfile(row as Profile);
      setError(null);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      setError(e);
      setProfile(null);
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const { data } = supabase?.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        refreshVersion.current += 1;
        identity.current = null;
        client.clear();
        setUser(null);
        setProfile(null);
      }
      setTimeout(() => void refresh(), 0);
    }) ?? { data: null };
    const id = setInterval(() => void refresh(), 60000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      data?.subscription.unsubscribe();
      clearInterval(id);
      window.removeEventListener("focus", focus);
    };
  }, [refresh, client]);
  async function signOut() {
    refreshVersion.current += 1;
    await supabase?.auth.signOut({ scope: "local" });
    client.clear();
    identity.current = null;
    setUser(null);
    setProfile(null);
  }
  return (
    <AuthContext.Provider
      value={{ user, profile, loading, error, refresh, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("AuthProvider required");
  return context;
}
