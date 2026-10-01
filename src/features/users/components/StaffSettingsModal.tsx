import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  Crown,
  Key,
  Lock,
  RotateCcw,
  Shield,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { Button, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { roleLabels } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import type { Profile, Role } from "@/types";
import { WorkingDaysPicker } from "./WorkingDaysPicker";

interface StaffSettingsModalProps {
  user: Profile;
  isSelf: boolean;
  isOwnerAcc: boolean;
  onClose: () => void;
  onUpdated: (msg: string) => void;
}

type TabKey = "role" | "schedule" | "security";

export function StaffSettingsModal({
  user,
  isSelf,
  isOwnerAcc,
  onClose,
  onUpdated,
}: StaffSettingsModalProps) {
  const { profile: currentUser } = useAuth();
  const client = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("role");

  // Tab 1: Role & financials
  const [role, setRole] = useState<Role>(user.role);
  const [canViewFinancials, setCanViewFinancials] = useState(
    Boolean(user.can_view_financials),
  );

  // Tab 2: Schedule
  const [allowedFrom, setAllowedFrom] = useState(
    user.allowed_from?.slice(0, 5) || "07:00",
  );
  const [allowedUntil, setAllowedUntil] = useState(
    user.allowed_until?.slice(0, 5) || "20:00",
  );
  const [workingDays, setWorkingDays] = useState<number[]>([
    ...(user.working_days || [1, 2, 3, 4, 5, 6, 7]),
  ]);

  // Tab 3: Security & lock
  const [newPassword, setNewPassword] = useState("");
  const [disableUntil, setDisableUntil] = useState(
    user.disabled_until ? user.disabled_until.slice(0, 16) : "",
  );
  const [disableReason, setDisableReason] = useState(user.disable_reason || "");
  const [hardDelete, setHardDelete] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");

  const isLocked =
    user.disabled_until && new Date(user.disabled_until) > new Date();

  // Mutation 1: Update profile role & financials (via manage-users for role changes)
  const updateProfileMutation = useMutation({
    mutationFn: (data: Partial<Profile>) => {
      // If role is changing, use manage-users edge function (OWNER-only with audit)
      if (data.role && data.role !== user.role) {
        return api.manageUser({
          action: "change_role",
          user_id: user.id,
          role: data.role,
        });
      }
      // For non-role changes (like can_view_financials), use update_profile RPC
      return api.call("update_profile", { p_id: user.id, p_data: data });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã cập nhật quyền hạn cho ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể cập nhật quyền tài khoản.",
      );
    },
  });

  // Mutation 2: Update schedule
  const updateScheduleMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "update_schedule",
        user_id: user.id,
        allowed_from: allowedFrom + ":00",
        allowed_until: allowedUntil + ":00",
        working_days: workingDays,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã cập nhật giờ và lịch làm việc cho ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể cập nhật giờ làm việc.",
      );
    },
  });

  // Mutation 3: Reset password
  const resetPasswordMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "reset_password",
        user_id: user.id,
        password: newPassword,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã đặt lại mật khẩu tạm thời cho ${user.full_name}. Hãy gửi mật khẩu mới cho nhân viên.`);
      setNewPassword("");
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể đặt lại mật khẩu.",
      );
    },
  });

  // Mutation 4: Lock / Disable
  const disableMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "disable",
        user_id: user.id,
        disabled_until: disableUntil ? new Date(disableUntil).toISOString() : null,
        disable_reason: disableReason || null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã cập nhật trạng thái hoạt động của ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể cập nhật trạng thái khóa.",
      );
    },
  });

  // Mutation 5: Unlock immediately
  const unlockMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "disable",
        user_id: user.id,
        disabled_until: null,
        disable_reason: null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã mở khóa tài khoản cho ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể mở khóa tài khoản.",
      );
    },
  });

  // Mutation 6: Delete or Restore
  const deleteMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: hardDelete ? "hard_delete" : "delete",
        user_id: user.id,
        disable_reason: disableReason || null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã hoàn tất thao tác với tài khoản ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể thực hiện thao tác xóa.",
      );
    },
  });

  // Mutation 7: Promote to OWNER
  const promoteToOwnerMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "promote_to_owner",
        user_id: user.id,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã nâng ${user.full_name} thành Chủ cửa hàng.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể nâng cấp tài khoản.",
      );
    },
  });

  // Mutation 8: Force password change
  const forcePasswordChangeMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "force_password_change",
        user_id: user.id,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã yêu cầu ${user.full_name} đổi mật khẩu khi đăng nhập tiếp theo.`);
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể yêu cầu đổi mật khẩu.",
      );
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () =>
      api.call("update_profile", {
        p_id: user.id,
        p_data: { deleted_at: null, active: true },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã khôi phục tài khoản cho ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể khôi phục tài khoản.",
      );
    },
  });

  const handleSaveRole = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    updateProfileMutation.mutate({
      role,
      can_view_financials: role === "MANAGER" ? canViewFinancials : false,
    });
  };

  const handleSaveSchedule = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    updateScheduleMutation.mutate();
  };

  const handleResetPassword = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    if (newPassword.length < 12) {
      setErrorMessage("Mật khẩu mới phải có tối thiểu 12 ký tự.");
      return;
    }
    resetPasswordMutation.mutate();
  };

  const isBusy =
    updateProfileMutation.isPending ||
    updateScheduleMutation.isPending ||
    resetPasswordMutation.isPending ||
    disableMutation.isPending ||
    unlockMutation.isPending ||
    deleteMutation.isPending ||
    restoreMutation.isPending ||
    promoteToOwnerMutation.isPending ||
    forcePasswordChangeMutation.isPending;

  return (
    <div
      className="modal-backdrop user-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-settings-title"
    >
      <div
        className="modal-card user-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="user-settings-header">
          <div className="user-settings-avatar-wrap">
            <span className="avatar large user-modal-avatar">
              {user.full_name.split(" ").at(-1)?.[0] ?? "U"}
            </span>
            <span
              className={`user-modal-status-dot ${user.active && !user.deleted_at && !isLocked ? "active" : "disabled"}`}
            />
          </div>

          <div className="user-settings-title-group">
            <div className="row" style={{ gap: "8px", alignItems: "center" }}>
              <h2 id="staff-settings-title" className="user-settings-name">
                {user.full_name}
              </h2>
              {isSelf && (
                <span className="badge badge-active" style={{ fontSize: "11px" }}>
                  Bạn
                </span>
              )}
            </div>
            <div className="user-settings-meta">
              <span>@{user.username}</span>
              <span>·</span>
              <span className="user-settings-role-tag">
                {roleLabels[user.role]}
              </span>
              {user.deleted_at ? (
                <span className="badge badge-cancelled" style={{ fontSize: "10.5px" }}>
                  Đã vô hiệu hóa
                </span>
              ) : isLocked ? (
                <span className="badge badge-cancelled" style={{ fontSize: "10.5px" }}>
                  Đang khóa tạm
                </span>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            className="icon-button user-settings-close-btn"
            onClick={onClose}
            aria-label="Đóng"
          >
            <X size={20} />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="user-settings-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "role"}
            className={`user-tab-btn ${activeTab === "role" ? "active" : ""}`}
            onClick={() => setActiveTab("role")}
          >
            <Shield size={15} />
            <span>Quyền &amp; Vai trò</span>
          </button>

          {!isOwnerAcc && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "schedule"}
              className={`user-tab-btn ${activeTab === "schedule" ? "active" : ""}`}
              onClick={() => setActiveTab("schedule")}
            >
              <Clock size={15} />
              <span>Giờ &amp; Lịch làm việc</span>
            </button>
          )}

          {!isSelf && !isOwnerAcc && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "security"}
              className={`user-tab-btn ${activeTab === "security" ? "active" : ""}`}
              onClick={() => setActiveTab("security")}
            >
              <Lock size={15} />
              <span>Bảo mật &amp; Khóa</span>
            </button>
          )}
        </div>

        {/* Global Error Banner */}
        {errorMessage && (
          <div style={{ padding: "0 24px", marginTop: "14px" }}>
            <ErrorState error={new Error(errorMessage)} />
          </div>
        )}

        {/* Body content based on active tab */}
        <div className="user-settings-body">
          {/* TAB 1: ROLE & FINANCIALS */}
          {activeTab === "role" && (
            <form onSubmit={handleSaveRole} className="stack">
              <div className="user-tab-lead">
                <strong>Phân quyền truy cập hệ thống</strong>
                <p className="muted small">
                  Chọn vai trò quy định tính năng và dữ liệu nhân sự này được phép thao tác.
                </p>
              </div>

              <Field label="Vai trò tài khoản">
                <select
                  aria-label={`Vai trò ${user.full_name}`}
                  value={role}
                  disabled={isBusy || isOwnerAcc || user.deleted_at !== null}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {/* Don't show OWNER in normal dropdown - use special "Promote to OWNER" button instead */}
                  {Object.entries(roleLabels)
                    .filter(([k]) => k !== "OWNER")
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </Field>

              {role === "MANAGER" && (
                <div className="user-settings-subcard">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={canViewFinancials}
                      disabled={isBusy || user.deleted_at !== null}
                      onChange={(e) => setCanViewFinancials(e.target.checked)}
                    />
                    <strong>Cho phép xem giá mua xe và lợi nhuận</strong>
                  </label>
                  <p className="muted small" style={{ margin: "4px 0 0 24px" }}>
                    Khi bật, Quản lý này sẽ thấy giá nhập vốn, tổng lãi gộp của từng xe và các báo cáo tài chính nội bộ.
                  </p>
                </div>
              )}

              {isOwnerAcc ? (
                <p className="notice" style={{ margin: "8px 0" }}>
                  Tài khoản Chủ cửa hàng (OWNER) có toàn quyền quản trị cao nhất trên toàn hệ thống Cà Rem.
                </p>
              ) : (
                <>
                  {/* Special "Promote to OWNER" button for current OWNER */}
                  {currentUser?.role === "OWNER" && user.role !== "OWNER" && user.active && user.deleted_at === null && (
                    <div className="user-settings-subcard" style={{ marginBottom: "16px", padding: "12px", backgroundColor: "var(--primary-bg, #f0f9ff)", border: "1px solid var(--primary, #4f46e5)" }}>
                      <div className="row" style={{ gap: "8px", alignItems: "center", marginBottom: "8px" }}>
                        <Crown size={16} style={{ color: "var(--primary, #4f46e5)" }} />
                        <strong style={{ color: "var(--primary, #4f46e5)" }}>Quyền Chủ cửa hàng</strong>
                      </div>
                      <p className="muted small" style={{ marginBottom: "12px" }}>
                        Nâng cấp tài khoản này thành Chủ cửa hàng với toàn quyền quản trị hệ thống.
                      </p>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={isBusy}
                        onClick={() => promoteToOwnerMutation.mutate()}
                      >
                        <Crown size={14} /> Nâng thành Chủ cửa hàng
                      </Button>
                    </div>
                  )}

                  <div className="user-tab-actions">
                    <Button
                      type="submit"
                      disabled={isBusy || user.deleted_at !== null}
                    >
                      Lưu phân quyền
                    </Button>
                  </div>
                </>
              )}
            </form>
          )}

          {/* TAB 2: SCHEDULE & HOURS */}
          {activeTab === "schedule" && !isOwnerAcc && (
            <form onSubmit={handleSaveSchedule} className="stack">
              <div className="user-tab-lead">
                <strong>Khung giờ &amp; Ngày cho phép đăng nhập</strong>
                <p className="muted small">
                  Ngoài khung giờ này, nhân sự sẽ không thể đăng nhập hoặc thực hiện giao dịch trên hệ thống.
                </p>
              </div>

              <div className="form-grid">
                <Field label="Giờ bắt đầu làm việc">
                  <input
                    type="time"
                    value={allowedFrom}
                    disabled={isBusy}
                    onChange={(e) => setAllowedFrom(e.target.value)}
                  />
                </Field>

                <Field label="Giờ kết thúc làm việc">
                  <input
                    type="time"
                    value={allowedUntil}
                    disabled={isBusy}
                    onChange={(e) => setAllowedUntil(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Các ngày làm việc trong tuần">
                <WorkingDaysPicker
                  value={workingDays}
                  onChange={(days) => setWorkingDays(days)}
                />
              </Field>

              <div className="user-tab-actions">
                <Button type="submit" disabled={isBusy}>
                  Lưu lịch làm việc
                </Button>
              </div>
            </form>
          )}

          {/* TAB 3: SECURITY, LOCK & STATUS */}
          {activeTab === "security" && !isSelf && !isOwnerAcc && (
            <div className="stack" style={{ gap: "24px" }}>
              {/* Reset Password Section */}
              <div className="user-security-block">
                <div className="user-tab-lead">
                  <div className="row" style={{ gap: "6px", alignItems: "center" }}>
                    <Key size={16} style={{ color: "var(--primary, #4f46e5)" }} />
                    <strong>Đặt lại mật khẩu tạm thời</strong>
                  </div>
                  <p className="muted small">
                    Cung cấp mật khẩu mới cho nhân sự khi quên hoặc cấp lại tài khoản.
                  </p>
                </div>

                <form onSubmit={handleResetPassword} className="row" style={{ gap: "10px", alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <Field label="Mật khẩu mới (tối thiểu 12 ký tự)">
                      <input
                        type="password"
                        placeholder="••••••••••••"
                        value={newPassword}
                        disabled={isBusy}
                        onChange={(e) => setNewPassword(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Button type="submit" disabled={isBusy || newPassword.length < 12}>
                    Cập nhật mật khẩu
                  </Button>
                </form>
                <div style={{ marginTop: "12px" }}>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isBusy}
                    onClick={() => forcePasswordChangeMutation.mutate()}
                  >
                    <Key size={14} /> Yêu cầu đổi mật khẩu (không đặt mới)
                  </Button>
                </div>
              </div>

              {/* Temporary Lock Section */}
              <div className="user-security-block">
                <div className="user-tab-lead">
                  <div className="row" style={{ gap: "6px", alignItems: "center" }}>
                    {isLocked ? (
                      <Unlock size={16} style={{ color: "#10b981" }} />
                    ) : (
                      <Lock size={16} style={{ color: "#f59e0b" }} />
                    )}
                    <strong>Khóa tạm thời tài khoản</strong>
                  </div>
                  <p className="muted small">
                    Tạm dừng quyền truy cập khi nhân sự tạm nghỉ phép hoặc cần đình chỉ tạm thời.
                  </p>
                </div>

                {isLocked ? (
                  <div className="user-lock-active-banner">
                    <div>
                      <strong>Tài khoản đang bị khóa tạm thời</strong>
                      <p className="small muted" style={{ margin: "2px 0 0" }}>
                        Khóa đến:{" "}
                        {new Date(user.disabled_until!).toLocaleString("vi-VN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={isBusy}
                      onClick={() => unlockMutation.mutate()}
                    >
                      <Unlock size={15} /> Mở khóa ngay
                    </Button>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      disableMutation.mutate();
                    }}
                    className="stack"
                  >
                    <Field label="Khóa tạm đến thời điểm (để trống nếu muốn khóa đến khi mở lại)">
                      <input
                        type="datetime-local"
                        value={disableUntil}
                        disabled={isBusy}
                        onChange={(e) => setDisableUntil(e.target.value)}
                      />
                    </Field>
                    <Field label="Lý do khóa">
                      <input
                        type="text"
                        placeholder="Ví dụ: Nghỉ phép dài ngày..."
                        value={disableReason}
                        disabled={isBusy}
                        onChange={(e) => setDisableReason(e.target.value)}
                      />
                    </Field>
                    <div>
                      <Button type="submit" variant="secondary" disabled={isBusy}>
                        <Lock size={14} /> Xác nhận khóa tạm
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              {/* Deactivate or Restore Section */}
              <div className="user-security-block user-danger-block">
                <div className="user-tab-lead">
                  <div className="row" style={{ gap: "6px", alignItems: "center" }}>
                    {user.deleted_at ? (
                      <RotateCcw size={16} style={{ color: "#10b981" }} />
                    ) : (
                      <Trash2 size={16} style={{ color: "#ef4444" }} />
                    )}
                    <strong>
                      {user.deleted_at
                        ? "Khôi phục tài khoản nhân sự"
                        : "Vô hiệu hóa hoặc xóa tài khoản"}
                    </strong>
                  </div>
                  <p className="muted small">
                    {user.deleted_at
                      ? "Khôi phục tài khoản này để nhân sự có thể tiếp tục đăng nhập và làm việc."
                      : "Vô hiệu hóa sẽ khóa tài khoản vĩnh viễn nhưng vẫn giữ nguyên lịch sử bán hàng và chứng từ để đối soát."}
                  </p>
                </div>

                {user.deleted_at ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isBusy}
                    onClick={() => restoreMutation.mutate()}
                  >
                    <RotateCcw size={15} /> Khôi phục tài khoản này
                  </Button>
                ) : (
                  <div className="stack" style={{ gap: "10px" }}>
                    <Field label="Lý do vô hiệu hóa (tùy chọn)">
                      <input
                        type="text"
                        placeholder="Ví dụ: Đã nghỉ việc..."
                        value={disableReason}
                        disabled={isBusy}
                        onChange={(e) => setDisableReason(e.target.value)}
                      />
                    </Field>

                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={hardDelete}
                        disabled={isBusy}
                        onChange={(e) => setHardDelete(e.target.checked)}
                      />
                      <span style={{ color: "#dc2626", fontSize: "12.5px" }}>
                        Xóa hoàn toàn khỏi cơ sở dữ liệu (chỉ dùng nếu tài khoản chưa từng phát sinh giao dịch)
                      </span>
                    </label>

                    <div>
                      <Button
                        type="button"
                        variant="danger"
                        disabled={isBusy}
                        onClick={() => deleteMutation.mutate()}
                      >
                        <Trash2 size={14} /> Xác nhận vô hiệu hóa
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="user-settings-footer">
          <Button variant="secondary" onClick={onClose} disabled={isBusy}>
            Đóng
          </Button>
        </div>
      </div>
    </div>
  );
}
