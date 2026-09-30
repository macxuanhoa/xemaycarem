import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { roleLabels } from "@/lib/permissions";
import { WorkingDaysPicker } from "./WorkingDaysPicker";

export function CreateUserModal({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    full_name: "",
    username: "",
    password: "",
    role: "STAFF",
    can_view_financials: false,
    allowed_from: "07:00:00",
    allowed_until: "20:00:00",
    working_days: [1, 2, 3, 4, 5, 6],
  });
  const [error, setError] = useState("");
  const m = useMutation({
    mutationFn: () => api.createUser(form),
    onSuccess: onDone,
    onError: (err: unknown) => {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Không thể tạo tài khoản. Vui lòng kiểm tra lại thông tin.");
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!/^[a-z0-9_.]{3,30}$/.test(form.username)) {
      setError(
        "Tên đăng nhập từ 3 đến 30 ký tự, chỉ gồm chữ thường, số, dấu gạch dưới (_) hoặc dấu chấm (.).",
      );
      return;
    }

    if (form.password.length < 12) {
      setError("Mật khẩu ban đầu phải có ít nhất 12 ký tự.");
      return;
    }

    m.mutate();
  };

  return (
    <Card>
      <h2>Tạo tài khoản nhân viên mới</h2>
      <form className="stack" onSubmit={handleSubmit}>
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
          <Field label="Mật khẩu ban đầu (tối thiểu 12 ký tự)">
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              placeholder="Mật khẩu tạm thời"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <small className="muted">
              Nhân viên bắt buộc phải đổi mật khẩu ở lần đăng nhập đầu tiên
            </small>
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
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.can_view_financials}
              onChange={(e) =>
                setForm({ ...form, can_view_financials: e.target.checked })
              }
            />
            Cho phép xem giá mua xe và báo cáo lợi nhuận
          </label>
        )}

        <div className="form-grid">
          <Field label="Giờ cho phép bắt đầu làm việc">
            <input
              type="time"
              value={form.allowed_from.slice(0, 5)}
              onChange={(e) =>
                setForm({ ...form, allowed_from: e.target.value + ":00" })
              }
            />
          </Field>
          <Field label="Giờ kết thúc ca làm việc">
            <input
              type="time"
              value={form.allowed_until.slice(0, 5)}
              onChange={(e) =>
                setForm({ ...form, allowed_until: e.target.value + ":00" })
              }
            />
          </Field>
        </div>

        <Field label="Các ngày làm việc trong tuần (Asia/Ho_Chi_Minh)">
          <WorkingDaysPicker
            value={form.working_days}
            onChange={(working_days) => setForm({ ...form, working_days })}
          />
        </Field>

        {error && <p className="field-error">{error}</p>}
        {!!m.error && !error && <ErrorState error={m.error} />}
        <div className="row">
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Đang khởi tạo…" : "Tạo tài khoản"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Hủy
          </Button>
        </div>
      </form>
    </Card>
  );
}
