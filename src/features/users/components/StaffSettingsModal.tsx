import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Crown, Key, RotateCcw, Shield, Trash2, X } from "lucide-react";
import { Button, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { roleLabels } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import type { Profile, Role } from "@/types";

interface StaffSettingsModalProps {
  user: Profile;
  isSelf: boolean;
  isOwnerAcc: boolean;
  onClose: () => void;
  onUpdated: (msg: string) => void;
}

type TabKey = "role" | "security";

/** Ban duration presets. "today" ends at 23:59 Asia/Ho_Chi_Minh. */
type BanPreset = "today" | "week" | "month" | "custom";

const BAN_PRESETS: { key: BanPreset; label: string }[] = [
  { key: "today", label: "Hết hôm nay" },
  { key: "week", label: "7 ngày" },
  { key: "month", label: "30 ngày" },
  { key: "custom", label: "Tinh chỉnh thời gian" },
];

// Vietnam is UTC+7 year-round; derive the wall-clock end of today from that.
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function banExpiry(preset: BanPreset, custom: string): string | null {
  switch (preset) {
    case "today": {
      const vnNow = new Date(Date.now() + VN_OFFSET_MS);
      const endOfDayUtcMs = Date.UTC(
        vnNow.getUTCFullYear(),
        vnNow.getUTCMonth(),
        vnNow.getUTCDate(),
        23,
        59,
        59,
      );
      return new Date(endOfDayUtcMs - VN_OFFSET_MS).toISOString();
    }
    case "week":
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    case "month":
      return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    case "custom":
      return custom ? new Date(custom).toISOString() : null;
  }
}

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

  const isActorOwner = currentUser?.role === "OWNER";
  const isActorManager = currentUser?.role === "MANAGER";

  // Tab 1: Role & financials
  const [role, setRole] = useState<Role>(user.role);
  const [canViewFinancials, setCanViewFinancials] = useState(
    Boolean(user.can_view_financials),
  );

  // Tab 2: Security & status
  const [newPassword, setNewPassword] = useState("");
  const [banPreset, setBanPreset] = useState<BanPreset>("today");
  const [banCustom, setBanCustom] = useState("");
  const [banReason, setBanReason] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");

  const isBanned =
    Boolean(user.disabled_until) && new Date(user.disabled_until!) > new Date();
  const isDeleted = Boolean(user.deleted_at);

  // A manager may only re-assign the role of STAFF accounts (their juniors).
  const canChooseRole =
    !isSelf &&
    !isDeleted &&
    ((isActorOwner && !isOwnerAcc) ||
      (isActorManager && user.role === "STAFF"));

  // Mutation 1: Update profile role & financials (via manage-users for role changes)
  const updateProfileMutation = useMutation({
    mutationFn: (data: Partial<Profile>) => {
      // If role is changing, use manage-users edge function (audited, hierarchy-checked)
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

  // Mutation 2: Reset password
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

  // Mutation 3: Temporary usage ban (cấm sử dụng có thời hạn)
  const banMutation = useMutation({
    mutationFn: (until: string) =>
      api.manageUser({
        action: "disable",
        user_id: user.id,
        disabled_until: until,
        disable_reason: banReason || null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã cấm ${user.full_name} sử dụng hệ thống tạm thời.`);
      setBanReason("");
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể áp dụng lệnh cấm.",
      );
    },
  });

  // Mutation 4: Lift the ban immediately
  const unbanMutation = useMutation({
    mutationFn: () =>
      api.manageUser({ action: "enable_user", user_id: user.id }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã gỡ lệnh cấm cho ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể gỡ lệnh cấm.",
      );
    },
  });

  // Mutation 5: Delete account (history preserved)
  const deleteMutation = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "delete",
        user_id: user.id,
        disable_reason: deleteReason || null,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(`Đã xóa tài khoản của ${user.full_name}.`);
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể xóa tài khoản.",
      );
    },
  });

  // Mutation 6: Restore a deleted account
  const restoreMutation = useMutation({
    mutationFn: () => api.manageUser({ action: "restore", user_id: user.id }),
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

  // Mutation 7: Transfer OWNER status to this account (single owner system)
  const transferOwnerMutation = useMutation({
    mutationFn: () =>
      api.manageUser({ action: "promote_to_owner", user_id: user.id }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      onUpdated(
        `Đã chuyển giao quyền Chủ cửa hàng cho ${user.full_name}. Bạn làm việc với vai trò Quản lý.`,
      );
      onClose();
    },
    onError: (err: unknown) => {
      setErrorMessage(
        err instanceof Error ? err.message : "Không thể chuyển giao quyền Chủ cửa hàng.",
      );
    },
  });

  const handleSaveRole = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    updateProfileMutation.mutate({
      role,
      // Managers must not touch the financial-visibility flag.
      ...(isActorOwner
        ? { can_view_financials: role === "MANAGER" ? canViewFinancials : false }
        : {}),
    });
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

  const handleApplyBan = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");
    const until = banExpiry(banPreset, banCustom);
    if (!until) {
      setErrorMessage("Hãy chọn thời điểm kết thúc lệnh cấm.");
      return;
    }
    if (new Date(until) <= new Date()) {
      setErrorMessage("Thời điểm kết thúc phải ở tương lai.");
      return;
    }
    banMutation.mutate(until);
  };

  const isBusy =
    updateProfileMutation.isPending ||
    resetPasswordMutation.isPending ||
    banMutation.isPending ||
    unbanMutation.isPending ||
    deleteMutation.isPending ||
    restoreMutation.isPending ||
    transferOwnerMutation.isPending;

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
              className={`user-modal-status-dot ${user.active && !isDeleted && !isBanned ? "active" : "disabled"}`}
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
              {isDeleted ? (
                <span className="badge badge-cancelled" style={{ fontSize: "10.5px" }}>
                  Đã xóa
                </span>
              ) : isBanned ? (
                <span className="badge badge-cancelled" style={{ fontSize: "10.5px" }}>
                  Đang bị cấm
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

          {isActorOwner && !isSelf && !isOwnerAcc && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "security"}
              className={`user-tab-btn ${activeTab === "security" ? "active" : ""}`}
              onClick={() => setActiveTab("security")}
            >
              <Ban size={15} />
              <span>Bảo mật &amp; Trạng thái</span>
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
                  disabled={!canChooseRole || isBusy}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {/* OWNER is never assigned from the dropdown; the system keeps
                      exactly one Chủ cửa hàng, changed only via handover below. */}
                  {Object.entries(roleLabels)
                    .filter(([k]) => k !== "OWNER")
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
                {!canChooseRole && !isOwnerAcc && (
                  <small className="muted">
                    {isSelf
                      ? "Bạn không thể tự thay đổi vai trò của chính mình."
                      : isDeleted
                        ? "Khôi phục tài khoản trước khi thay đổi vai trò."
                        : "Chỉ Chủ cửa hàng mới được thay đổi vai trò của tài khoản này."}
                  </small>
                )}
              </Field>

              {role === "MANAGER" && isActorOwner && (
                <div className="user-settings-subcard">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={canViewFinancials}
                      disabled={isBusy || isDeleted}
                      onChange={(e) => setCanViewFinancials(e.target.checked)}
                    />
                    <strong>Cho phép xem giá mua xe và lợi nhuận</strong>
                  </label>
                  <p className="muted small" style={{ margin: "4px 0 0 24px" }}>
                    Khi bật, Quản lý này sẽ thấy giá nhập vốn và tổng lãi gộp của từng xe.
                  </p>
                </div>
              )}

              {isOwnerAcc ? (
                <p className="notice" style={{ margin: "8px 0" }}>
                  Đây là tài khoản Chủ cửa hàng — người phân quyền cho tất cả các vai trò còn lại.
                </p>
              ) : (
                <>
                  {/* Owner handover: the system keeps a single OWNER account. */}
                  {isActorOwner && !isSelf && user.active && !isDeleted && (
                    <div className="user-settings-subcard user-owner-handover">
                      <div className="row" style={{ gap: "8px", alignItems: "center", marginBottom: "8px" }}>
                        <Crown size={16} />
                        <strong>Chuyển giao quyền Chủ cửa hàng</strong>
                      </div>
                      <p className="muted small" style={{ marginBottom: "12px" }}>
                        Hệ thống chỉ giữ một tài khoản Chủ cửa hàng. Sau khi chuyển giao,
                        bạn sẽ làm việc với vai trò Quản lý.
                      </p>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={isBusy}
                        onClick={() => transferOwnerMutation.mutate()}
                      >
                        <Crown size={14} /> Chuyển giao cho {user.full_name}
                      </Button>
                    </div>
                  )}

                  {canChooseRole && (
                    <div className="user-tab-actions">
                      <Button type="submit" disabled={isBusy}>
                        Lưu phân quyền
                      </Button>
                    </div>
                  )}
                </>
              )}
            </form>
          )}

          {/* TAB 2: SECURITY & STATUS (OWNER only) */}
          {activeTab === "security" && isActorOwner && !isSelf && !isOwnerAcc && (
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

                <form
                  onSubmit={handleResetPassword}
                  className="row user-pass-reset-form"
                  style={{ gap: "10px", alignItems: "flex-end" }}
                >
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
              </div>

              {/* Temporary Usage Ban Section */}
              <div className="user-security-block">
                <div className="user-tab-lead">
                  <div className="row" style={{ gap: "6px", alignItems: "center" }}>
                    <Ban size={16} style={{ color: isBanned ? "#10b981" : "#f59e0b" }} />
                    <strong>Cấm sử dụng tạm thời</strong>
                  </div>
                  <p className="muted small">
                    Chặn đăng nhập và thao tác trong một khoảng thời gian (nghỉ phép,
                    đình chỉ...). Hết thời hạn, tài khoản tự động được phép trở lại.
                  </p>
                </div>

                {isBanned ? (
                  <div className="user-lock-active-banner">
                    <div>
                      <strong>Tài khoản đang bị cấm sử dụng</strong>
                      <p className="small muted" style={{ margin: "2px 0 0" }}>
                        Cấm đến:{" "}
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
                      onClick={() => unbanMutation.mutate()}
                    >
                      Gỡ cấm ngay
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={handleApplyBan} className="stack">
                    <div className="filter-pills-bar" role="radiogroup" aria-label="Thời hạn cấm">
                      {BAN_PRESETS.map((preset) => (
                        <button
                          key={preset.key}
                          type="button"
                          role="radio"
                          aria-checked={banPreset === preset.key}
                          className={`filter-pill ${banPreset === preset.key ? "active" : ""}`}
                          disabled={isBusy}
                          onClick={() => setBanPreset(preset.key)}
                        >
                          <span>{preset.label}</span>
                        </button>
                      ))}
                    </div>

                    {banPreset === "custom" && (
                      <Field label="Cấm sử dụng đến thời điểm">
                        <input
                          type="datetime-local"
                          value={banCustom}
                          disabled={isBusy}
                          onChange={(e) => setBanCustom(e.target.value)}
                        />
                      </Field>
                    )}

                    <Field label="Lý do cấm (tùy chọn)">
                      <input
                        type="text"
                        placeholder="Ví dụ: Nghỉ phép dài ngày..."
                        value={banReason}
                        disabled={isBusy}
                        onChange={(e) => setBanReason(e.target.value)}
                      />
                    </Field>

                    <div>
                      <Button type="submit" variant="secondary" disabled={isBusy}>
                        <Ban size={14} /> Áp dụng lệnh cấm
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              {/* Delete / Restore Section */}
              <div className="user-security-block user-danger-block">
                <div className="user-tab-lead">
                  <div className="row" style={{ gap: "6px", alignItems: "center" }}>
                    {isDeleted ? (
                      <RotateCcw size={16} style={{ color: "#10b981" }} />
                    ) : (
                      <Trash2 size={16} style={{ color: "#ef4444" }} />
                    )}
                    <strong>
                      {isDeleted ? "Khôi phục tài khoản nhân sự" : "Xóa tài khoản"}
                    </strong>
                  </div>
                  <p className="muted small">
                    {isDeleted
                      ? "Khôi phục tài khoản này để nhân sự có thể tiếp tục đăng nhập và làm việc."
                      : "Tài khoản sẽ ngừng hoạt động và không còn đăng nhập được; lịch sử bán hàng và chứng từ vẫn giữ nguyên để đối soát."}
                  </p>
                </div>

                {isDeleted ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={isBusy}
                    onClick={() => restoreMutation.mutate()}
                  >
                    <RotateCcw size={15} /> Khôi phục tài khoản này
                  </Button>
                ) : confirmDelete ? (
                  <div className="row" style={{ gap: "10px", flexWrap: "wrap" }}>
                    <Button
                      type="button"
                      variant="danger"
                      disabled={isBusy}
                      onClick={() => deleteMutation.mutate()}
                    >
                      <Trash2 size={14} /> Xác nhận xóa tài khoản
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={isBusy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Quay lại
                    </Button>
                  </div>
                ) : (
                  <div className="stack" style={{ gap: "10px" }}>
                    <Field label="Lý do xóa (tùy chọn)">
                      <input
                        type="text"
                        placeholder="Ví dụ: Đã nghỉ việc..."
                        value={deleteReason}
                        disabled={isBusy}
                        onChange={(e) => setDeleteReason(e.target.value)}
                      />
                    </Field>

                    <div>
                      <Button
                        type="button"
                        variant="danger"
                        disabled={isBusy}
                        onClick={() => setConfirmDelete(true)}
                      >
                        <Trash2 size={14} /> Xóa tài khoản
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
