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
import { toast } from "@/lib/toast";
import { isOwner, roleLabels } from "@/lib/permissions";
import { SharedScheduleCard } from "@/features/users/components/SharedScheduleCard";
import { DEFAULT_QUICKPICK_TEXT } from "@/components/ui/QuickChips";
import { AnnouncementManager } from "./AnnouncementManager";
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
  customer_messaging_enabled?: boolean;
  sale_thank_you_enabled?: boolean;
  primary_message_channel?: "DISABLED" | "ZALO_ZNS" | "SMS";
  fallback_channel?: "DISABLED" | "ZALO_ZNS" | "SMS";
  support_phone?: string;
  quickpick_brands?: string[];
  quickpick_models?: Record<string, string[]>;
};
export default function SettingsPage() {
  const { profile, user, refresh } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? ""),
    [password, setPassword] = useState(""),
    [currentPassword, setCurrentPassword] = useState(""),
    [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [activeTab, setActiveTab] = useState<
    "PROFILE" | "STORE" | "SCHEDULE" | "MESSAGES" | "QUICKPICK" | "DEVICE"
  >("PROFILE");

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
      toast.success("Đã lưu thông tin", {
        description: "Tên hiển thị đã được cập nhật.",
      });
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
      toast.success("Đã cập nhật mật khẩu.");
    },
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<Settings>("get_settings"),
    enabled: isOwner(profile),
  });

  const showStore = isOwner(profile) && activeTab === "STORE";
  const showSchedule = isOwner(profile) && activeTab === "SCHEDULE";
  const showMessages = isOwner(profile) && activeTab === "MESSAGES";
  const showQuickPick = isOwner(profile) && activeTab === "QUICKPICK";

  return (
    <div className="stack settings-shell">
      <PageHeader
        title="Cài đặt"
        description="Thông tin cá nhân và không gian làm việc của cửa hàng."
      />

      {/* CATEGORY TAB BAR */}
      <div
        className="settings-tabs-nav"
        role="tablist"
        aria-label="Danh mục cài đặt"
      >
        <button
          type="button"
          className={`settings-nav-item ${activeTab === "PROFILE" ? "active" : ""}`}
          onClick={() => setActiveTab("PROFILE")}
        >
          <span>Hồ sơ &amp; Đổi mật khẩu</span>
        </button>
        {isOwner(profile) && (
          <button
            type="button"
            className={`settings-nav-item ${activeTab === "STORE" ? "active" : ""}`}
            onClick={() => setActiveTab("STORE")}
          >
            <span>Thông tin cửa hàng</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            className={`settings-nav-item ${activeTab === "SCHEDULE" ? "active" : ""}`}
            onClick={() => setActiveTab("SCHEDULE")}
          >
            <span>Giờ làm việc</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            className={`settings-nav-item ${activeTab === "MESSAGES" ? "active" : ""}`}
            onClick={() => setActiveTab("MESSAGES")}
          >
            <span>Tin nhắn &amp; Bảng tin</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            className={`settings-nav-item ${activeTab === "QUICKPICK" ? "active" : ""}`}
            onClick={() => setActiveTab("QUICKPICK")}
          >
            <span>Chọn nhanh xe</span>
          </button>
        )}
        <button
          type="button"
          className={`settings-nav-item ${activeTab === "DEVICE" ? "active" : ""}`}
          onClick={() => setActiveTab("DEVICE")}
        >
          <span>Ứng dụng &amp; Dữ liệu</span>
        </button>
      </div>

      {activeTab === "PROFILE" && (
        <div className="settings-balance-grid">
          <Card>
            <h2>Hồ sơ của bạn</h2>
            <p className="muted small" style={{ marginBottom: "16px" }}>
              Quyền hạn trong hệ thống:{" "}
              <strong>{roleLabels[profile!.role]}</strong>
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
            <p className="muted small" style={{ marginBottom: "16px" }}>
              Đặt mật khẩu an toàn với tối thiểu 6 ký tự để bảo vệ tài khoản
              cửa hàng.
            </p>
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
                  minLength={6}
                  required
                  placeholder="Tối thiểu 6 ký tự"
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
        </div>
      )}

      {showStore &&
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
                toast.success("Đã lưu cài đặt cửa hàng.");
              }}
            />
          )
        ))}

      {showSchedule && (
        <SharedScheduleCard
          onSaved={(msg) => toast.success(msg)}
        />
      )}

      {showMessages && <AnnouncementManager />}

      {showQuickPick &&
        (settings.isPending ? (
          <Loading />
        ) : settings.error ? (
          <ErrorState error={settings.error} />
        ) : (
          settings.data && (
            <QuickPickEditor
              brands={settings.data.quickpick_brands ?? []}
              models={settings.data.quickpick_models ?? {}}
              onDone={() => {
                void client.invalidateQueries({ queryKey: ["settings"] });
                toast.success("Đã cập nhật danh mục chọn nhanh", {
                  description:
                    "Chip hãng và dòng xe ở form Thu vào, Nhập xe mới sẽ đổi ngay.",
                });
              }}
            />
          )
        ))}

      {activeTab === "DEVICE" && (
        <div className="settings-balance-grid">
          <Card className="install-card">
            <span className="install-icon">
              <Download size={24} />
            </span>
            <h2>Luôn sẵn sàng trên thiết bị</h2>
            <p className="muted">
              Cài Cà Rem để mở nhanh như một ứng dụng độc lập.
            </p>
            {prompt && (
              <Button
                onClick={async () => {
                  await prompt.prompt();
                  await prompt.userChoice;
                  setPrompt(null);
                }}
              >
                Cài đặt Cà Rem
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
            <div className="row" style={{ gap: "8px", alignItems: "center" }}>
              <ShieldCheck size={21} style={{ color: "#16a34a" }} />
              <h3>Dữ liệu &amp; An ninh</h3>
            </div>
            <p className="muted small" style={{ marginTop: "10px" }}>
              Dữ liệu cửa hàng được đồng bộ và lưu trữ bảo mật trên Supabase. Hệ
              thống yêu cầu kết nối mạng để ghi nhận giao dịch; dữ liệu tài
              chính không được lưu vào bộ nhớ ngoại tuyến để phòng ngừa gian
              lận.
            </p>
          </Card>
        </div>
      )}
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
      <p className="muted small" style={{ marginBottom: "18px" }}>
        Cấu hình thương hiệu cửa hàng, địa chỉ liên hệ và ngưỡng cảnh báo tồn
        kho xe.
      </p>
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

        <div className="form-grid">
          <Field label="Điện thoại">
            <input
              value={data.phone ?? ""}
              onChange={(e) => setData({ ...data, phone: e.target.value })}
              placeholder="VD: 0912 345 678"
            />
          </Field>
          <Field label="Địa chỉ">
            <input
              value={data.address ?? ""}
              onChange={(e) => setData({ ...data, address: e.target.value })}
              placeholder="Địa chỉ showroom xe máy"
            />
          </Field>
        </div>

        <div
          style={{
            borderTop: "1px solid var(--line, #e2e8f0)",
            paddingTop: "18px",
          }}
        >
          <h3 style={{ marginBottom: "6px" }}>Cảnh báo tồn kho</h3>
          <p className="muted small" style={{ marginBottom: "14px" }}>
            Thiết lập ngưỡng để hệ thống đánh dấu tình trạng kho trên Dashboard.
            Chỉ số được tính trên tổng số xe đang tại cửa hàng (gồm cả xe đang
            giữ chỗ). Số xe bằng đúng ngưỡng vẫn là Tồn kho bình thường. Hệ
            thống không gửi email, tin nhắn hay thông báo tự động.
          </p>
          <div className="form-grid">
            <Field label="Số xe tối thiểu nên có">
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
              <span className="field-hint">
                Khi số xe trong kho giảm xuống dưới mức này, Dashboard sẽ đánh
                dấu trạng thái Tồn kho thấp.
              </span>
            </Field>
            <Field label="Số xe tối đa nên giữ">
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
              <span className="field-hint">
                Khi số xe trong kho tăng vượt trên mức này, Dashboard sẽ đánh
                dấu trạng thái Tồn kho cao.
              </span>
            </Field>
          </div>
        </div>

        <div
          style={{
            borderTop: "1px solid var(--line, #e2e8f0)",
            paddingTop: "18px",
          }}
        >
          <h3 style={{ marginBottom: "6px" }}>Khách hàng &amp; Tin nhắn</h3>
          <p className="muted small" style={{ marginBottom: "14px" }}>
            Kênh gửi chưa được cấu hình. Khi được bật, lời cảm ơn chỉ được tạo
            sau khi giao dịch bán xe hoàn tất.
          </p>

          <div className="settings-field-group">
            <label className="settings-switch-card">
              <div className="settings-switch-content">
                <span className="settings-switch-title">
                  Bật tính năng nhắn tin khách hàng
                </span>
                <span className="settings-switch-desc">
                  Kích hoạt thông báo tự động cho khách mua xe.
                </span>
              </div>
              <input
                type="checkbox"
                checked={data.customer_messaging_enabled ?? false}
                onChange={(e) =>
                  setData({
                    ...data,
                    customer_messaging_enabled: e.target.checked,
                  })
                }
              />
            </label>

            <label className="settings-switch-card">
              <div className="settings-switch-content">
                <span className="settings-switch-title">
                  Tự động gửi lời cảm ơn sau khi bán
                </span>
                <span className="settings-switch-desc">
                  Tự động kích hoạt thông điệp tri ân ngay khi hợp đồng bán hoàn
                  tất.
                </span>
              </div>
              <input
                type="checkbox"
                checked={data.sale_thank_you_enabled ?? false}
                onChange={(e) =>
                  setData({
                    ...data,
                    sale_thank_you_enabled: e.target.checked,
                  })
                }
              />
            </label>

            <div className="form-grid">
              <Field label="Kênh ưu tiên">
                <select
                  value={data.primary_message_channel ?? "DISABLED"}
                  onChange={(e) =>
                    setData({
                      ...data,
                      primary_message_channel: e.target
                        .value as Settings["primary_message_channel"],
                    })
                  }
                >
                  <option value="DISABLED">Tắt</option>
                  <option value="ZALO_ZNS">Zalo ZNS</option>
                  <option value="SMS">SMS</option>
                </select>
              </Field>

              <Field label="Kênh dự phòng">
                <select
                  value={data.fallback_channel ?? "DISABLED"}
                  onChange={(e) =>
                    setData({
                      ...data,
                      fallback_channel: e.target
                        .value as Settings["fallback_channel"],
                    })
                  }
                >
                  <option value="DISABLED">Không dùng</option>
                  <option value="ZALO_ZNS">Zalo ZNS</option>
                  <option value="SMS">SMS</option>
                </select>
              </Field>
            </div>

            <Field label="Số điện thoại hỗ trợ">
              <input
                maxLength={40}
                value={data.support_phone ?? ""}
                onChange={(e) =>
                  setData({ ...data, support_phone: e.target.value })
                }
                placeholder="Hotline chăm sóc khách hàng"
              />
            </Field>

            <p className="muted small">
              Nhà cung cấp: Chưa cấu hình. Không có tin nhắn thật nào được gửi
              trong giai đoạn này.
            </p>
          </div>
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

/** Turn the current catalog into "<Brand>: m1, m2\n…" text. */
function serializeCatalog(
  brands: string[],
  models: Record<string, string[]>,
): string {
  const lines = brands
    .map((brand) => {
      const trimmed = brand.trim();
      if (!trimmed) return "";
      const list = models[trimmed.toLowerCase()] ?? [];
      const joined = list
        .map((m) => (typeof m === "string" ? m.trim() : ""))
        .filter(Boolean)
        .join(", ");
      return joined ? `${trimmed}: ${joined}` : `${trimmed}:`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : DEFAULT_QUICKPICK_TEXT;
}

/** Parse the textarea content back into structured arrays. Returns an error
 *  message (Vietnamese, user-facing) instead of throwing so the form keeps
 *  its draft text untouched on bad input. */
function parseCatalog(text: string):
  | { brands: string[]; models: Record<string, string[]> }
  | { error: string } {
  const brands: string[] = [];
  const models: Record<string, string[]> = {};
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      return {
        error: `Dòng ${i + 1} thiếu dấu ":" — cần viết "Honda: SH 160i, Vision".`,
      };
    }
    const brand = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!brand) return { error: `Dòng ${i + 1} thiếu tên hãng xe.` };
    if (brand.length > 40) {
      return {
        error: `Tên hãng "${brand}" vượt quá 40 ký tự.`,
      };
    }
    const key = brand.toLowerCase();
    if (seen.has(key)) {
      return { error: `Hãng "${brand}" bị lặp lại ở hai dòng.` };
    }
    seen.add(key);
    brands.push(brand);
    const rawList = rest
      ? rest
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : [];
    if (rawList.length > 60) {
      return {
        error: `Hãng "${brand}" có hơn 60 dòng xe (giới hạn để chip gọn gàng).`,
      };
    }
    const dedup: string[] = [];
    const listSeen = new Set<string>();
    for (const m of rawList) {
      if (m.length > 60) {
        return {
          error: `Dòng xe "${m}" vượt quá 60 ký tự.`,
        };
      }
      const mk = m.toLowerCase();
      if (listSeen.has(mk)) continue;
      listSeen.add(mk);
      dedup.push(m);
    }
    models[key] = dedup;
  }
  if (brands.length > 30) {
    return { error: "Chỉ nên có tối đa 30 hãng trong danh mục chọn nhanh." };
  }
  if (brands.length === 0) {
    return { error: "Danh mục trống — hãy nhập ít nhất một hãng." };
  }
  return { brands, models };
}

function QuickPickEditor({
  brands,
  models,
  onDone,
}: {
  brands: string[];
  models: Record<string, string[]>;
  onDone: () => void;
}) {
  const [text, setText] = useState(() => serializeCatalog(brands, models));
  const m = useMutation({
    mutationFn: async () => {
      const parsed = parseCatalog(text);
      if ("error" in parsed) throw new AppError(parsed.error);
      await api.call("save_settings", {
        p_data: {
          quickpick_brands: parsed.brands,
          quickpick_models: parsed.models,
        },
      });
    },
    onSuccess: onDone,
  });

  return (
    <Card>
      <h2>Chọn nhanh hãng &amp; dòng xe</h2>
      <p className="muted small" style={{ marginBottom: "12px" }}>
        Danh sách dưới đây hiển thị thành chip ở form <strong>Thu vào</strong>{" "}
        và <strong>Nhập xe mới</strong>, giúp nhân viên chỉ một chạm là điền
        đúng. Mỗi hãng một dòng theo khuôn:
      </p>
      <pre
        className="notice"
        style={{
          padding: "10px 12px",
          marginBottom: "12px",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "12.5px",
          whiteSpace: "pre-wrap",
        }}
      >
        Honda: SH 125i, SH 160i, Vision
      </pre>
      <p className="muted small" style={{ marginBottom: "12px" }}>
        Dòng trống được bỏ qua. Hãng chưa có dòng xe nào vẫn hiện chip hãng,
        không hiện chip dòng. Tên không phân biệt hoa/thường khi đối chiếu với
        ô nhập.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Danh mục chọn nhanh">
          <textarea
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            style={{
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: "13px",
              lineHeight: "1.6",
            }}
          />
        </Field>
        {m.error && <ErrorState error={m.error} />}
        <div className="row" style={{ gap: "8px", flexWrap: "wrap" }}>
          <Button type="submit" disabled={m.isPending}>
            Lưu danh mục
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setText(DEFAULT_QUICKPICK_TEXT)}
          >
            Khôi phục mặc định
          </Button>
        </div>
      </form>
    </Card>
  );
}
