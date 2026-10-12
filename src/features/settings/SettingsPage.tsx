import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { UNCLASSIFIED_TYPE_NAME } from "@/lib/shorthand/vocabulary";
import {
  useVehicleTypes,
  VEHICLE_TYPES_QUERY_KEY,
} from "@/lib/useVehicleTypes";
import { AnnouncementManager } from "./AnnouncementManager";
import { PaymentSettingsCard } from "./PaymentSettingsCard";
import { ShorthandDictionaryCard } from "./ShorthandDictionaryCard";
import { SmartSalesAutomationCard } from "./SmartSalesAutomationCard";
import { SeasonalThemeCard } from "./SeasonalThemeCard";
export default function SettingsPage() {
  const { profile, user, refresh } = useAuth();
  const [name, setName] = useState(profile?.full_name ?? ""),
    [password, setPassword] = useState(""),
    [currentPassword, setCurrentPassword] = useState("");
  const [activeTab, setActiveTab] = useState<
    "PROFILE" | "PAYMENT" | "SCHEDULE" | "MESSAGES" | "AUTOMATION" | "VEHICLE_TYPES" | "THEME" | "SHORTHAND"
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
  const showVehicleTypes = isOwner(profile) && activeTab === "VEHICLE_TYPES";
  const showTheme = isOwner(profile) && activeTab === "THEME";
  // Bộ nhớ viết tắt thu xe là của riêng từng tài khoản trên máy này — mọi
  // role đều quản lý được, không cần quyền owner.
  const showShorthand = activeTab === "SHORTHAND";

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
            <span>Tin nhắn &amp; Bảng tin</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "AUTOMATION"}
            className={`settings-nav-item ${activeTab === "AUTOMATION" ? "active" : ""}`}
            onClick={() => setActiveTab("AUTOMATION")}
          >
            <span>Tự động bán hàng</span>
          </button>
        )}
        {isOwner(profile) && (
          <button
            type="button"
            aria-pressed={activeTab === "VEHICLE_TYPES"}
            className={`settings-nav-item ${activeTab === "VEHICLE_TYPES" ? "active" : ""}`}
            onClick={() => setActiveTab("VEHICLE_TYPES")}
          >
            <span>Loại xe</span>
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

      {showAutomation && <SmartSalesAutomationCard />}

      {showVehicleTypes && <VehicleTypeCatalogEditor />}

      {showTheme && <SeasonalThemeCard />}

      {showShorthand && <ShorthandDictionaryCard />}
    </div>
  );
}

/** Chuẩn hoá tên loại xe để đối chiếu trùng — đúng như index
 * `vehicle_types_name_norm` và RPC `save_vehicle_type` đang làm trong database. */
function normalizeTypeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Danh mục loại xe (bảng `public.vehicle_types`). OWNER thêm/đổi tên/xoá tại
 * đây; các vai trò khác chỉ chọn trong form. Vì danh mục nằm trong database
 * nên thêm loại xe mới KHÔNG cần nâng cấp ứng dụng, và mọi form đang mở cập
 * nhật ngay sau khi lưu (query key dùng chung `VEHICLE_TYPES_QUERY_KEY`).
 */
function VehicleTypeCatalogEditor() {
  const client = useQueryClient();
  const { items, isLoading } = useVehicleTypes();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const refreshCatalog = () =>
    void client.invalidateQueries({ queryKey: VEHICLE_TYPES_QUERY_KEY });
  const saved = useMutation({
    mutationFn: (input: { id: string | null; name: string }) =>
      api.saveVehicleType(input.id, input.name),
    onSuccess: () => {
      setDrafts({});
      setNewName("");
      refreshCatalog();
      toast.success("Đã lưu danh mục loại xe.", {
        description:
          "Bộ chọn Loại xe ở form Thu vào, Nhập xe mới và bộ lọc kho đổi ngay.",
      });
    },
  });
  const removed = useMutation({
    mutationFn: (id: string) => api.deleteVehicleType(id),
    onSuccess: () => {
      refreshCatalog();
      toast.success("Đã xoá loại xe khỏi danh mục.");
    },
  });
  const busy = saved.isPending || removed.isPending;
  const catalogError = saved.error ?? removed.error;
  const clashWith = (name: string, exceptId?: string) =>
    items.some(
      (item) =>
        item.id !== exceptId &&
        normalizeTypeName(item.name) === normalizeTypeName(name),
    );

  const askDelete = async (id: string, name: string) => {
    const confirmed = await confirmAction({
      title: `Xoá loại "${name}"?`,
      description:
        "Loại xe chỉ xoá được khi không còn hồ sơ xe nào thuộc loại này. Danh mục dùng chung cho toàn cửa hàng.",
      confirmLabel: "Xoá loại xe",
      cancelLabel: "Giữ lại",
    });
    if (confirmed) removed.mutate(id);
  };

  const candidate = newName.trim().replace(/\s+/g, " ");
  const newClash = candidate.length > 0 && clashWith(candidate);

  return (
    <Card>
      <h2>Loại xe</h2>
      <p className="muted small" style={{ marginBottom: "16px" }}>
        Danh mục này là nguồn duy nhất cho bộ chọn <strong>Loại xe</strong> ở
        form <strong>Thu vào</strong>, <strong>Nhập xe mới</strong> và bộ lọc
        kho. Nhân viên chỉ được chọn, không gõ tên tự do; hàng đợi{" "}
        <strong>{UNCLASSIFIED_TYPE_NAME}</strong> luôn tồn tại để chứa những xe
        chưa phân loại lại sau khi chuyển đổi dữ liệu.
      </p>
      {isLoading && !items.length ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="vehicle-type-list">
            {items.map((item) => {
              const protectedType =
                normalizeTypeName(item.name) ===
                normalizeTypeName(UNCLASSIFIED_TYPE_NAME);
              const draft = drafts[item.id] ?? item.name;
              const next = draft.trim().replace(/\s+/g, " ");
              const changed = next !== item.name;
              const duplicate = changed && clashWith(next, item.id);
              return (
                <div className="vehicle-type-row" key={item.id}>
                  <input
                    aria-label={`Tên loại xe ${item.name}`}
                    value={draft}
                    maxLength={60}
                    disabled={protectedType || busy}
                    onChange={(event) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [item.id]: event.target.value,
                      }))
                    }
                  />
                  <span className="vehicle-type-meta muted small">
                    {protectedType
                      ? "Hàng đợi bắt buộc — không đổi tên, không xoá"
                      : `${item.vehicle_count ?? 0} xe đang thuộc loại này`}
                  </span>
                  {!protectedType && (
                    <span className="vehicle-type-actions">
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={!changed || duplicate || busy}
                        onClick={() =>
                          saved.mutate({ id: item.id, name: next })
                        }
                      >
                        Lưu tên
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        disabled={busy || (item.vehicle_count ?? 0) > 0}
                        onClick={() => void askDelete(item.id, item.name)}
                      >
                        Xoá
                      </Button>
                    </span>
                  )}
                  {duplicate && (
                    <small className="vehicle-type-warn" role="alert">
                      Trùng tên một loại đã có sau khi bỏ phân biệt hoa/thường
                      và khoảng trắng.
                    </small>
                  )}
                </div>
              );
            })}
          </div>

          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!candidate || candidate.length < 2 || newClash) return;
              saved.mutate({ id: null, name: candidate });
            }}
          >
            <Field label="Thêm loại xe mới">
              <input
                value={newName}
                maxLength={60}
                placeholder="Ví dụ: Xe số 50cc"
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            {newClash && (
              <p className="notice danger" role="alert">
                Tên này trùng một loại đã có (chỉ khác hoa/thường hoặc khoảng
                trắng) — hãy đặt tên khác.
              </p>
            )}
            <div>
              <Button
                type="submit"
                disabled={busy || candidate.length < 2 || newClash}
              >
                Thêm vào danh mục
              </Button>
            </div>
          </form>
          {catalogError && <ErrorState error={catalogError} />}
        </div>
      )}
    </Card>
  );
}
