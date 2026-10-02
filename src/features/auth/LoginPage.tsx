import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  ArrowRight,
  Check,
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
  const location = useLocation();
  const from: unknown = location.state?.from;
  const returnTo = typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/login") ? from : "/";
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
  if (profile) return <Navigate to={returnTo} replace />;
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
        <Link to="/" className="brand">
          <span className="brand-icon">
            <img src="/logo.jpg" alt="Logo Cà Rem" className="brand-logo-img" />
          </span>
          <span>
            Cà Rem<small>VẬN HÀNH CỬA HÀNG</small>
          </span>
        </Link>
        <div className="login-story-content">
          <span className="eyebrow">HỆ THỐNG VẬN HÀNH KHO XE TOÀN DIỆN</span>
          <h1>
            Nắm rõ cửa hàng.
            <br />
            <em>Làm chủ giao dịch.</em>
          </h1>
          <p>
            Theo dõi chi tiết từng chiếc xe từ lúc nhập kho, tân trang,
            đến khi hoàn tất thủ tục bàn giao và đối soát dòng tiền minh bạch.
          </p>
          <div className="motorcycle-showcase-4k" aria-hidden="true">
            <div className="showcase-photo-container">
              <img
                src="/motorcycle-real-side.jpg"
                alt="Mô tô phân khối lớn tại showroom Xe Máy Cà Rem"
                className="showcase-real-img"
              />
              <div className="showcase-vignette" />
              <div className="showcase-tag-top">
                <span className="live-camera-pulse" />
                <span>ẢNH THỰC TẾ 4K • KHO XE CÀ REM</span>
              </div>
              <div className="showcase-telemetry">
                <div className="telemetry-item">
                  <span className="telemetry-label">TÌNH TRẠNG</span>
                  <span className="telemetry-val">NGUYÊN BẢN 100%</span>
                </div>
                <div className="telemetry-sep" />
                <div className="telemetry-item">
                  <span className="telemetry-label">KIỂM ĐỊNH</span>
                  <span className="telemetry-val">128 HẠNG MỤC</span>
                </div>
                <div className="telemetry-sep" />
                <div className="telemetry-item">
                  <span className="telemetry-label">PHÁP LÝ</span>
                  <span className="telemetry-val">SẴN SÀNG SANG TÊN</span>
                </div>
              </div>
            </div>
            <div className="showcase-bottom-bar">
              <span className="showcase-badge-active">
                <ShieldCheck size={14} className="badge-shield-icon" />
                TIÊU CHUẨN ĐỊNH DANH KHO XE CÀ REM
              </span>
              <span className="showcase-meta-vin">SỐ KHUNG & SỐ MÁY CHUẨN</span>
            </div>
          </div>
          <div className="story-points">
            <span>
              <Check size={16} /> Kiểm soát tồn kho & giấy tờ pháp lý
            </span>
            <span>
              <Check size={16} /> Tự động tính giá vốn & lợi nhuận gộp
            </span>
            <span>
              <Check size={16} /> Phân quyền an toàn & lưu vết giao dịch
            </span>
          </div>
        </div>
        <div className="login-footer">
          <span>HỆ THỐNG CRM XE MÁY NỘI BỘ</span>
          <span>PHIÊN BẢN 1.0</span>
        </div>
      </div>
      <div className="login-panel">
        <div className="login-form-wrap">
          <span className="login-lock">
            <LockKeyhole size={22} />
          </span>
          <h2>Chào mừng trở lại</h2>
          <p className="muted">Đăng nhập tài khoản nội bộ để bắt đầu ngày làm việc.</p>
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
            <span>Hệ thống nội bộ. Tài khoản do Chủ cửa hàng phân quyền và quản lý.</span>
          </div>
        </div>
        <p className="login-bottom">
          Cửa hàng Xe Máy Cà Rem • Hotline hỗ trợ: 0914.92.92.92
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
