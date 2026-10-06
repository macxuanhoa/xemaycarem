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
  endingSession: boolean;
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
  const [endingSession, setEndingSession] = useState(false);
  const client = useQueryClient();
  const identity = useRef<string | null>(null);
  const refreshVersion = useRef(0);
  const signedOutLocally = useRef(false);
  const signingOut = useRef(false);
  const refresh = useCallback(async () => {
    if (signedOutLocally.current) return;
    const version = ++refreshVersion.current;
    if (!supabase) {
      setLoading(false);
      return;
    }
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (version !== refreshVersion.current) return;
      if (sessionError) throw sessionError;
      const sessionUserId = data.session?.user.id ?? null;
      const verifiedUserId = identity.current?.split(":", 1)[0] ?? null;
      if (verifiedUserId && sessionUserId !== verifiedUserId) {
        identity.current = null;
        setProfile(null);
        client.clear();
      }
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
      // The profile row and the authoritative access RPC depend only on the
      // resolved session, so fetch them concurrently. This drops one full
      // network round-trip from the cold-start gate that keeps the app on the
      // loading screen; every validation below still runs in the same order.
      const uid = data.session.user.id;
      const [profileRes, accessRes] = await Promise.all([
        supabase
          .from("profiles")
          .select(
            "id,full_name,username,role,active,can_view_financials,must_change_password,disabled_until,allowed_from,allowed_until,working_days,deleted_at",
          )
          .eq("id", uid)
          .maybeSingle(),
        supabase.rpc("check_user_access"),
      ]);
      if (version !== refreshVersion.current) return;
      const { data: row, error: profileError } = profileRes;
      if (profileError) throw profileError;

      // Check if profile exists
      if (!row) {
        identity.current = null;
        setProfile(null);
        client.clear();
        throw new AppError(
          "Không tìm thấy hồ sơ người dùng. Vui lòng liên hệ chủ cửa hàng.",
        );
      }

      // Check soft-deleted
      if (row.deleted_at) {
        identity.current = null;
        setProfile(null);
        client.clear();
        throw new AppError(
          "Tài khoản đã bị vô hiệu hóa hoặc xóa khỏi hệ thống.",
        );
      }

      // Check master active flag
      if (!row.active) {
        identity.current = null;
        setProfile(null);
        client.clear();
        throw new AppError(
          "Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ chủ cửa hàng.",
        );
      }

      // Check authoritative server access evaluation
      const { data: accessData, error: accessErr } = accessRes;
      if (accessErr) {
        throw new AppError(
          "Không thể kiểm tra quyền truy cập. Vui lòng thử lại khi có kết nối.",
        );
      }
      if (!accessData || typeof accessData.allowed !== "boolean") {
        throw new AppError(
          "Không thể xác nhận quyền truy cập. Vui lòng thử lại.",
        );
      }
      if (!accessData.allowed) {
        identity.current = null;
        setProfile(null);
        client.clear();
        throw new AppError(
          accessData.message || "Tài khoản không được phép truy cập.",
        );
      }

      const nextIdentity = `${row.id}:${row.role}:${row.can_view_financials}:${row.must_change_password}:${row.disabled_until}:${row.deleted_at}:${row.active}`;
      if (identity.current && identity.current !== nextIdentity) client.clear();
      identity.current = nextIdentity;
      setProfile(row as Profile);
      setError(null);
    } catch (e) {
      if (version !== refreshVersion.current) return;
      setError(e);
      setProfile(null);
      identity.current = null;
      client.clear();
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const { data } = supabase?.auth.onAuthStateChange((event, session) => {
      refreshVersion.current += 1;
      if (event === "SIGNED_OUT") {
        signedOutLocally.current = true;
        identity.current = null;
        client.clear();
        setUser(null);
        setProfile(null);
        setLoading(false);
      } else if (event === "SIGNED_IN") {
        if (signingOut.current) return;
        signedOutLocally.current = false;
        const nextUserId = session?.user.id ?? null;
        const verifiedUserId = identity.current?.split(":", 1)[0] ?? null;
        if (!nextUserId || nextUserId !== verifiedUserId) {
          identity.current = null;
          client.clear();
          setProfile(null);
          setLoading(true);
        }
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
    if (signingOut.current) return;
    signingOut.current = true;
    setEndingSession(true);
    signedOutLocally.current = true;
    refreshVersion.current += 1;
    // Close the shared-device access gate immediately. Auth may be offline or
    // slow; neither its response nor a concurrent refresh may reveal old data.
    client.clear();
    identity.current = null;
    setUser(null);
    setProfile(null);
    setLoading(false);
    setError(null);
    try {
      const result = await supabase?.auth.signOut({ scope: "local" });
      if (result?.error)
        setError(
          new AppError(
            "Đã đóng phiên trên màn hình này, nhưng chưa xác nhận đăng xuất với máy chủ. Hãy kiểm tra kết nối và đăng xuất lại trước khi giao thiết bị cho người khác.",
          ),
        );
    } catch {
      setError(
        new AppError(
          "Không thể xóa hoàn toàn phiên đăng nhập trên trình duyệt. Hãy xóa dữ liệu trang web trước khi giao thiết bị cho người khác.",
        ),
      );
    } finally {
      signingOut.current = false;
      setEndingSession(false);
    }
  }
  return (
    <AuthContext.Provider
      value={{ user, profile, loading, endingSession, error, refresh, signOut }}
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
