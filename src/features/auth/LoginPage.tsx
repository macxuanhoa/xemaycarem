import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, Field } from "@/components/ui";
import { isConfigured, supabase } from "@/lib/supabase";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "./AuthProvider";
const loginSchema = z.object({
  identifier: z
    .string()
    .min(3, "Vui lòng nhập tên đăng nhập hoặc email")
    .max(120, "Tối đa 120 ký tự"),
  password: z.string().min(1, "Nhập mật khẩu"),
  remember: z.boolean(),
});
export default function LoginPage() {
  // Signing in always lands on the dashboard first; deep links are not resumed.
  const { profile, refresh, error: authError, user, signOut } = useAuth();
  const [show, setShow] = useState(false),
    [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { remember: true },
  });
  if (profile) return <Navigate to="/" replace />;
  const login = handleSubmit(async (values) => {
    setError(null);
    if (!supabase) return;
    localStorage.setItem("xe-remember", String(values.remember));

    const raw = values.identifier.trim();
    let loginEmail = raw;

    if (raw.includes("@")) {
      // Real email login (Owner or email-based account)
      loginEmail = raw.toLowerCase();
    } else {
      // Internal username login (Staff or Owner username)
      const normalizedUsername = raw.toLowerCase();
      try {
        const { data: resolvedEmail, error: rpcErr } = await supabase.rpc(
          "resolve_login_email",
          { p_identifier: normalizedUsername },
        );
        if (!rpcErr && resolvedEmail) {
          loginEmail = resolvedEmail;
        } else {
          loginEmail = `${normalizedUsername}@internal.xecrm.app`;
        }
      } catch {
        loginEmail = `${normalizedUsername}@internal.xecrm.app`;
      }
    }

    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password: values.password,
    });
    if (signInErr) setError(signInErr);
    else await refresh();
  });
  return (
    <main className="login-page">
      <div className="login-story">
        <Link to="/" className="brand brand-glass">
          <span className="brand-icon">
            <img src="/logo.jpg" alt="Logo Cà Rem" className="brand-logo-img" />
          </span>
          <span>
            Cà Rem<small>HỆ THỐNG QUẢN LÝ</small>
          </span>
        </Link>
        <div className="login-footer login-footer-glass">
          <span>107 NGUYỄN TẤT THÀNH • HỘI AN</span>
          <span>HOTLINE: 0914.92.92.92</span>
        </div>
      </div>
      <div className="login-panel">
        <div className="login-form-wrap">
          <span className="login-lock">
            <LockKeyhole size={22} />
          </span>
          <h2>Chào mừng trở lại</h2>
          <p className="muted">Đăng nhập tài khoản nội bộ để bắt đầu làm việc.</p>
          {!isConfigured ? (
            <div className="setup-notice" role="status">
              <ShieldCheck size={24} />
              <div>
                <h3>Chưa kết nối cửa hàng</h3>
                <p>
                  Ứng dụng đã sẵn sàng để cấu hình. Cần kết nối Supabase và tạo
                  tài khoản chủ cửa hàng trước khi đăng nhập.
                </p>
                <p className="small">
                  Hướng dẫn thiết lập nằm trong README của dự án. Dữ liệu chỉ
                  được ghi khi kết nối thành công.
                </p>
              </div>
            </div>
          ) : null}
          <form onSubmit={login} className="stack">
            <Field
              label="Tên đăng nhập hoặc email"
              error={errors.identifier?.message}
            >
              <input
                type="text"
                autoComplete="username email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                placeholder="Nhập tên đăng nhập hoặc email"
                {...register("identifier")}
                disabled={!isConfigured}
              />
            </Field>
            <Field label="Mật khẩu" error={errors.password?.message}>
              <span className="password-field">
                <input
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="go"
                  placeholder="Nhập mật khẩu"
                  {...register("password")}
                  disabled={!isConfigured}
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                >
                  {show ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </Field>
            <div className="row between login-options">
              <label className="checkbox">
                <input type="checkbox" {...register("remember")} />
                <span>Duy trì đăng nhập</span>
              </label>
            </div>
            {!!(error || authError) && (
              <p className="field-error" role="alert">
                {friendlyError(error ?? authError)}
              </p>
            )}
            <Button
              type="submit"
              className="full-width login-submit"
              disabled={isSubmitting || !isConfigured}
            >
              <span>{isSubmitting ? "Đang xác thực…" : "Đăng nhập"}</span>
              <ArrowRight size={18} />
            </Button>
            {user && !profile && (
              <Button variant="secondary" onClick={() => void signOut()}>
                Dùng tài khoản khác
              </Button>
            )}
          </form>
          <div className="login-note">
            <ShieldCheck size={16} className="note-shield-icon" />
            <span>Hệ thống nội bộ Cửa hàng Xe Máy Cà Rem</span>
          </div>
        </div>
        <p className="login-bottom">
          Hotline hỗ trợ: <a href="tel:0914929292">0914.92.92.92</a>
        </p>
      </div>
    </main>
  );
}
// Supabase Auth recovery landing: the user arrives here already signed in via
// the emailed recovery link and only needs to set a new password.
export function PasswordPage() {
  const { user } = useAuth();
  const [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setMessage("Mật khẩu đã được cập nhật.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-simple">
      <div className="card stack">
        <h1>Đặt lại mật khẩu</h1>
        {!user ? (
          <p>Vui lòng mở liên kết đặt lại mật khẩu hợp lệ từ email.</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            <Field label="Mật khẩu mới">
              <input
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
                placeholder="Tối thiểu 6 ký tự"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || !isConfigured}>
              Tiếp tục
            </Button>
          </form>
        )}
        {message && <p role="status">{message}</p>}
        {error != null && <p className="field-error">{friendlyError(error)}</p>}
        <Link to="/login">Về đăng nhập</Link>
      </div>
    </div>
  );
}
