import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import {
  Button,
  Card,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { AppError } from "@/lib/errors";
import { isOwner, roleLabels } from "@/lib/permissions";
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
type Settings = {
  store_name: string;
  phone?: string;
  address?: string;
  low_stock_threshold?: number;
  high_stock_threshold?: number;
};
export default function SettingsPage() {
  const { profile, user, refresh } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? ""),
    [password, setPassword] = useState(""),
    [currentPassword, setCurrentPassword] = useState(""),
    [prompt, setPrompt] = useState<InstallPrompt | null>(null),
    [message, setMessage] = useState("");
  const client = useQueryClient();
  useEffect(() => {
    const handle = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", handle);
    return () => window.removeEventListener("beforeinstallprompt", handle);
  }, []);
  const profileMutation = useMutation({
    mutationFn: () =>
      api.call("update_profile", {
        p_id: profile?.id,
        p_data: { full_name: name },
      }),
    onSuccess: () => {
      void refresh();
      setMessage("Đã lưu tên hiển thị.");
    },
  });
  const passwordMutation = useMutation({
    mutationFn: async () => {
      if (!navigator.onLine)
        throw new AppError("Đang mất kết nối. Mật khẩu chưa được cập nhật.");
      if (!user?.email)
        throw new AppError("Hãy đăng nhập lại để đổi mật khẩu.");
      const { error: loginError } = await supabase!.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (loginError) throw loginError;
      const { error } = await supabase!.auth.updateUser({ password });
      if (error) throw error;
    },
    onSuccess: () => {
      setPassword("");
      setCurrentPassword("");
      setMessage("Đã cập nhật mật khẩu.");
    },
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<Settings>("get_settings"),
    enabled: isOwner(profile),
  });
  return (
    <div className="stack">
      <PageHeader
        title="Cài đặt"
        description="Thông tin cá nhân và không gian làm việc của cửa hàng."
      />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <div className="detail-grid">
        <div className="stack">
          <Card>
            <h2>Hồ sơ của bạn</h2>
            <p className="muted small">
              Quyền hiện tại: {roleLabels[profile!.role]}
            </p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                profileMutation.mutate();
              }}
            >
              <Field label="Họ và tên">
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              {profileMutation.error && (
                <ErrorState error={profileMutation.error} />
              )}
              <div>
                <Button type="submit" disabled={profileMutation.isPending}>
                  Lưu thông tin
                </Button>
              </div>
            </form>
          </Card>
          <Card>
            <h2>Đổi mật khẩu</h2>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                passwordMutation.mutate();
              }}
            >
              <Field label="Mật khẩu hiện tại">
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </Field>
              <Field label="Mật khẩu mới">
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  placeholder="Tối thiểu 12 ký tự"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {passwordMutation.error && (
                <ErrorState error={passwordMutation.error} />
              )}
              <div>
                <Button type="submit" disabled={passwordMutation.isPending}>
                  Cập nhật mật khẩu
                </Button>
              </div>
            </form>
          </Card>
          {isOwner(profile) &&
            (settings.isPending ? (
              <Loading />
            ) : settings.error ? (
              <ErrorState error={settings.error} />
            ) : (
              settings.data && (
                <StoreSettings
                  settings={settings.data}
                  onDone={() => {
                    void client.invalidateQueries({ queryKey: ["settings"] });
                    setMessage("Đã lưu cài đặt cửa hàng.");
                  }}
                />
              )
            ))}
        </div>
        <div className="stack">
          <Card className="install-card">
            <span className="install-icon">
              <Download size={24} />
            </span>
            <h2>Luôn sẵn sàng trên thiết bị</h2>
            <p className="muted">Cài Xe CRM để mở nhanh như một ứng dụng.</p>
            {prompt && (
              <Button
                onClick={async () => {
                  await prompt.prompt();
                  await prompt.userChoice;
                  setPrompt(null);
                }}
              >
                Cài đặt Xe CRM
              </Button>
            )}
            <div className="install-step">
              <Monitor size={21} />
              <div>
                <h3>Trên máy tính</h3>
                <p>
                  Mở bằng Chrome hoặc Edge, chọn biểu tượng cài đặt trên thanh
                  địa chỉ. Sau khi cài, có thể ghim ứng dụng vào thanh tác vụ.
                </p>
              </div>
            </div>
            <div className="install-step">
              <Smartphone size={21} />
              <div>
                <h3>Trên điện thoại</h3>
                <p>
                  Android: chọn “Cài đặt ứng dụng” trong menu trình duyệt.
                  iPhone: mở bằng Safari → Chia sẻ → Thêm vào màn hình chính.
                </p>
              </div>
            </div>
          </Card>
          <Card>
            <div className="row">
              <ShieldCheck size={21} />
              <h3>Dữ liệu của cửa hàng</h3>
            </div>
            <p className="muted small">
              Dữ liệu được lưu tại Supabase. Ứng dụng cần kết nối mạng để ghi
              nhận nghiệp vụ; dữ liệu tài chính không được lưu vào bộ nhớ ngoại
              tuyến.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
function StoreSettings({
  settings,
  onDone,
}: {
  settings: Settings;
  onDone: () => void;
}) {
  const [data, setData] = useState(settings);
  const m = useMutation({
    mutationFn: () => api.call("save_settings", { p_data: data }),
    onSuccess: onDone,
  });
  return (
    <Card>
      <h2>Thông tin cửa hàng</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Tên cửa hàng">
          <input
            required
            maxLength={150}
            value={data.store_name}
            onChange={(e) => setData({ ...data, store_name: e.target.value })}
          />
        </Field>
        <Field label="Điện thoại">
          <input
            value={data.phone ?? ""}
            onChange={(e) => setData({ ...data, phone: e.target.value })}
          />
        </Field>
        <Field label="Địa chỉ">
          <input
            value={data.address ?? ""}
            onChange={(e) => setData({ ...data, address: e.target.value })}
          />
        </Field>
        <div className="form-grid">
          <Field label="Ngưỡng tồn kho thấp">
            <input
              type="number"
              min="0"
              value={data.low_stock_threshold ?? 5}
              onChange={(e) =>
                setData({
                  ...data,
                  low_stock_threshold: Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Ngưỡng tồn kho cao">
            <input
              type="number"
              min={data.low_stock_threshold ?? 0}
              value={data.high_stock_threshold ?? 100}
              onChange={(e) =>
                setData({
                  ...data,
                  high_stock_threshold: Number(e.target.value),
                })
              }
            />
          </Field>
        </div>
        {m.error && <ErrorState error={m.error} />}
        <div>
          <Button type="submit" disabled={m.isPending}>
            Lưu cài đặt
          </Button>
        </div>
      </form>
    </Card>
  );
}
