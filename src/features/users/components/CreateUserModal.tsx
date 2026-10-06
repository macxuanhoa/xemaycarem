import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { Button, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { roleLabels } from "@/lib/permissions";
import { useDialog } from "@/lib/useDialog";

export function CreateUserModal({ onDone }: { onDone: () => void }) {
  const client = useQueryClient();
  const [form, setForm] = useState({
    full_name: "",
    username: "",
    password: "",
    role: "STAFF",
    can_view_financials: false,
  });
  const [error, setError] = useState("");
  const m = useMutation({
    mutationFn: () => api.createUser(form),
    onSuccess: () => {
      // Refresh the staff grid so the new account is on-screen immediately —
      // no manual reload required. Toast confirms; inline banner is retired.
      void client.invalidateQueries({ queryKey: ["profiles"] });
      toast.success(`Đã tạo tài khoản cho ${form.full_name || form.username}`, {
        description:
          "Chuyển mật khẩu ban đầu cho nhân viên qua kênh bảo mật.",
      });
      onDone();
    },
    onError: (err: unknown) => {
      if (err instanceof Error) {
        setError(friendlyError(err));
      } else {
        setError("Không thể tạo tài khoản. Vui lòng kiểm tra lại thông tin.");
      }
    },
  });
  const dialogRef = useDialog<HTMLFormElement>(true, onDone, m.isPending);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!/^[a-z0-9_.]{3,30}$/.test(form.username)) {
      setError(
        "Tên đăng nhập từ 3 đến 30 ký tự, chỉ gồm chữ thường, số, dấu gạch dưới (_) hoặc dấu chấm (.).",
      );
      return;
    }

    if (form.password.length < 6) {
      setError("Mật khẩu ban đầu phải có ít nhất 6 ký tự.");
      return;
    }

    m.mutate();
  };

  return (
    <div
      className="modal-backdrop user-modal-backdrop"
      onClick={onDone}
      role="presentation"
    >
      {/* The <form> wraps the whole sheet so the action footer can sit as a
          sibling of the scrolling body — same pattern as StaffSettingsModal.
          A footer inside the scroll container clipped off-screen on phones. */}
      <form
        ref={dialogRef}
        className="modal-card user-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-user-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="user-settings-header">
          <div className="user-settings-avatar-wrap">
            <span className="avatar large user-modal-avatar">
              <UserPlus size={20} />
            </span>
          </div>
          <div className="user-settings-title-group">
            <h2 id="create-user-title" className="user-settings-name">
              Tạo tài khoản nhân viên mới
            </h2>
            <div className="user-settings-meta">
              <span>Cấp quyền truy cập hệ thống theo vai trò rõ ràng</span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button user-settings-close-btn"
            onClick={onDone}
            aria-label="Đóng"
          >
            <X size={20} />
          </button>
        </div>

        <div className="user-settings-body stack">
          <div className="form-grid">
            <Field label="Họ và tên nhân viên">
              <input
                required
                maxLength={120}
                placeholder="Nguyễn Văn A"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              />
            </Field>
            <Field label="Tên đăng nhập (Username)">
              <input
                type="text"
                required
                minLength={3}
                maxLength={30}
                placeholder="nguyena"
                value={form.username}
                onChange={(e) => {
                  const normalized = e.target.value.toLowerCase().replace(/\s+/g, "");
                  setForm({ ...form, username: normalized });
                }}
              />
              <small className="muted">
                Nhân viên dùng tên này để đăng nhập vào hệ thống
              </small>
            </Field>
            <Field label="Mật khẩu ban đầu (tối thiểu 6 ký tự)">
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                placeholder="Mật khẩu ban đầu"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
            <Field label="Vai trò">
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {Object.entries(roleLabels)
                  .filter(([k]) => k !== "OWNER")
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          {form.role === "MANAGER" && (
            <div className="user-settings-subcard">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.can_view_financials}
                  onChange={(e) =>
                    setForm({ ...form, can_view_financials: e.target.checked })
                  }
                />
                <strong>Cho phép xem giá mua xe và lợi nhuận</strong>
              </label>
            </div>
          )}

          <p className="muted small">
            Tài khoản mới áp dụng theo giờ làm việc chung của Quản lý &amp;
            Nhân viên (thiết lập ở trang Nhân sự).
          </p>

          {error && <p className="field-error">{error}</p>}
          {!!m.error && !error && <ErrorState error={m.error} />}
        </div>

        <div className="user-settings-footer user-create-footer">
          <Button variant="secondary" type="button" onClick={onDone}>
            Hủy
          </Button>
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Đang khởi tạo…" : "Tạo tài khoản"}
          </Button>
        </div>
      </form>
    </div>
  );
}
