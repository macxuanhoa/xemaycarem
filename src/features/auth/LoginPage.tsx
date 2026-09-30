import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  LockKeyhole,
  Bike,
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
  email: z.email("Email chưa hợp lệ"),
  password: z.string().min(1, "Nhập mật khẩu"),
  remember: z.boolean(),
});
export default function LoginPage() {
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
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });
    if (error) setError(error);
    else await refresh();
  });
  return (
    <main className="login-page">
      <div className="login-story">
        <Link to="/" className="brand">
          <span className="brand-icon">
            <Bike size={27} />
          </span>
          <span>
            Xe CRM<small>VẬN HÀNH CỬA HÀNG</small>
          </span>
        </Link>
        <div className="login-story-content">
          <span className="eyebrow">MỌI CHIẾC XE. MỌI GIAO DỊCH.</span>
          <h1>
            Nắm rõ cửa hàng.
            <br />
            <em>Chủ động mỗi ngày.</em>
          </h1>
          <p>
            Từ lúc xe về đến khi giao chìa khóa.
            <br />
            Một nơi để quản lý kho xe, bán hàng và dòng tiền.
          </p>
          <div className="road-illustration" aria-hidden="true">
            <div className="road-line" />
            <Bike size={160} strokeWidth={1} />
            <span className="road-dot" />
            <span className="road-caption">HÀNH TRÌNH CỦA MỖI CHIẾC XE</span>
          </div>
          <div className="story-points">
            <span>
              <Check size={16} /> Kho xe rõ ràng
            </span>
            <span>
              <Check size={16} /> Số liệu nhất quán
            </span>
            <span>
              <Check size={16} /> Phân quyền an toàn
            </span>
          </div>
        </div>
        <div className="login-footer">
          QUẢN LÝ CỬA HÀNG XE <span>Phiên bản 1.0</span>
        </div>
      </div>
      <div className="login-panel">
        <div className="login-form-wrap">
          <span className="login-lock">
            <LockKeyhole size={23} />
          </span>
          <h2>Chào mừng trở lại</h2>
          <p className="muted">Đăng nhập để bắt đầu ngày làm việc của bạn.</p>
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
            <Field label="Email" error={errors.email?.message}>
              <input
                type="email"
                autoComplete="username"
                placeholder="ban@cuahang.vn"
                {...register("email")}
                disabled={!isConfigured}
              />
            </Field>
            <Field label="Mật khẩu" error={errors.password?.message}>
              <span className="password-field">
                <input
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Nhập mật khẩu của bạn"
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
            <div className="row between">
              <label className="checkbox">
                <input type="checkbox" {...register("remember")} /> Duy trì đăng
                nhập
              </label>
              {import.meta.env.VITE_ENABLE_PASSWORD_RESET === "true" && (
                <Link className="text-link" to="/forgot-password">
                  Quên mật khẩu?
                </Link>
              )}
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
              {isSubmitting ? "Đang đăng nhập…" : "Đăng nhập"}
              <ArrowRight size={18} />
            </Button>
            {user && !profile && (
              <Button variant="secondary" onClick={() => void signOut()}>
                Dùng tài khoản khác
              </Button>
            )}
          </form>
          <div className="login-note">
            <ShieldCheck size={17} />
            <span>Hệ thống nội bộ. Tài khoản do chủ cửa hàng cấp.</span>
          </div>
        </div>
        <p className="login-bottom">
          Công việc gọn gàng. Kinh doanh vững vàng.
        </p>
      </div>
    </main>
  );
}
export function PasswordPage({ reset = false }: { reset?: boolean }) {
  const { user } = useAuth();
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = reset
        ? await supabase.auth.updateUser({ password })
        : await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: location.origin + "/reset-password",
          });
      if (error) throw error;
      setMessage(
        reset
          ? "Mật khẩu đã được cập nhật."
          : "Nếu email có trong hệ thống, hướng dẫn đặt lại mật khẩu sẽ được gửi tới bạn.",
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-simple">
      <div className="card stack">
        <h1>{reset ? "Đặt lại mật khẩu" : "Quên mật khẩu"}</h1>
        {reset && !user ? (
          <p>Vui lòng mở liên kết đặt lại mật khẩu hợp lệ từ email.</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            {reset ? (
              <Field label="Mật khẩu mới">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            ) : (
              <Field label="Email">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            )}
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
