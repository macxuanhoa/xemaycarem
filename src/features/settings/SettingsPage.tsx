import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Button,
  Card,
  ErrorState,
  Field,
  PageHeader,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { AppError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { isOwner, roleLabels } from "@/lib/permissions";
import { SharedScheduleCard } from "@/features/users/components/SharedScheduleCard";
import { AnnouncementManager } from "./AnnouncementManager";
import { PaymentSettingsCard } from "./PaymentSettingsCard";
import { ShorthandDictionaryCard } from "./ShorthandDictionaryCard";
import { PushSettingsCard } from "./PushSettingsCard";
import { PaymentAutomationCard } from "./PaymentAutomationCard";
import { SeasonalThemeCard } from "./SeasonalThemeCard";
export default function SettingsPage() {
  const { profile, user, refresh } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? ""),
    [password, setPassword] = useState(""),
    [currentPassword, setCurrentPassword] = useState("");
  const [activeTab, setActiveTab] = useState<
    "PROFILE" | "PAYMENT" | "SCHEDULE" | "MESSAGES" | "AUTOMATION" | "THEME" | "SHORTHAND" | "NOTIFICATIONS"
  >("PROFILE");

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

  const showPayment = isOwner(profile) && activeTab === "PAYMENT";
  const showSchedule = isOwner(profile) && activeTab === "SCHEDULE";
  const showMessages = isOwner(profile) && activeTab === "MESSAGES";
  const showAutomation = isOwner(profile) && activeTab === "AUTOMATION";
  const showTheme = isOwner(profile) && activeTab === "THEME";
  // Bộ nhớ viết tắt thu xe là của riêng từng tài khoản trên máy này — mọi
  // role đều quản lý được, không cần quyền owner.
  const showShorthand = activeTab === "SHORTHAND";
  // Thông báo đẩy cũng là thiết bị riêng của từng người — mọi role tự bật/tắt.
  const showNotifications = activeTab === "NOTIFICATIONS";

  return (
    <div className="stack settings-shell">
      <PageHeader
        title="Cài đặt"
        description="Thông tin cá nhân và không gian làm việc của cửa hàng."
      />

      {/* CATEGORY TAB BAR */}
      <div
        className="settings-tabs-nav"
        role="group"
        aria-label="Danh mục cài đặt"
      >
        <button
          type="button"
          aria-pressed={activeTab === "PROFILE"}
          className={`settings-nav-item ${activeTab === "PROFILE" ? "active" : ""}`}
          onClick={() => setActiveTab("PROFILE")}
        >
          <span>Hồ sơ &amp; Đổi mật khẩu</span>
        </button>
        <button
          type="button"
          aria-pressed={activeTab === "SHORTHAND"}
          className={`settings-nav-item ${activeTab === "SHORTHAND" ? "active" : ""}`}
          onClick={() => setActiveTab("SHORTHAND")}
        >
          <span>Bộ nhớ viết tắt thu xe</span>
        </button>
        <button
          type="button"
          aria-pressed={activeTab === "NOTIFICATIONS"}
          className={`settings-nav-item ${activeTab === "NOTIFICATIONS" ? "active" : ""}`}
          onClick={() => setActiveTab("NOTIFICATIONS")}
        >
          <span>Thông báo đẩy</span>
        </button>
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "PAYMENT"}
            className={`settings-nav-item ${activeTab === "PAYMENT" ? "active" : ""}`}
            onClick={() => setActiveTab("PAYMENT")}
          >
            <span>Tài khoản nhận tiền</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "SCHEDULE"}
            className={`settings-nav-item ${activeTab === "SCHEDULE" ? "active" : ""}`}
            onClick={() => setActiveTab("SCHEDULE")}
          >
            <span>Giờ làm việc</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "MESSAGES"}
            className={`settings-nav-item ${activeTab === "MESSAGES" ? "active" : ""}`}
            onClick={() => setActiveTab("MESSAGES")}
          >
            <span>Bảng tin nội bộ</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "AUTOMATION"}
            className={`settings-nav-item ${activeTab === "AUTOMATION" ? "active" : ""}`}
            onClick={() => setActiveTab("AUTOMATION")}
          >
            <span>Thanh toán &amp; Đối soát</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "THEME"}
            className={`settings-nav-item ${activeTab === "THEME" ? "active" : ""}`}
            onClick={() => setActiveTab("THEME")}
          >
            <span>Giao diện hệ thống</span>
          </button>
        )}
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
              Đặt mật khẩu an toàn với tối thiểu 6 ký tự để bảo vệ tài khoản cửa
              hàng.
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

      {showPayment && <PaymentSettingsCard />}

      {showSchedule && (
        <SharedScheduleCard onSaved={(msg) => toast.success(msg)} />
      )}

      {showMessages && <AnnouncementManager />}

      {showAutomation && <PaymentAutomationCard onOpenPayment={() => setActiveTab("PAYMENT")} />}

      {showTheme && <SeasonalThemeCard />}

      {showShorthand && <ShorthandDictionaryCard />}

      {showNotifications && <PushSettingsCard />}
    </div>
  );
}

