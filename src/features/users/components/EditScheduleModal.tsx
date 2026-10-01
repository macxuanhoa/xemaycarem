import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import type { Profile } from "@/types";
import { WorkingDaysPicker } from "./WorkingDaysPicker";

export function EditScheduleModal({
  user,
  onDone,
}: {
  user: Profile;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    allowed_from: user.allowed_from || "00:00:00",
    allowed_until: user.allowed_until || "23:59:59",
    working_days: [...(user.working_days || [1, 2, 3, 4, 5, 6, 7])],
  });
  const [error, setError] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "update_schedule",
        user_id: user.id,
        allowed_from: form.allowed_from,
        allowed_until: form.allowed_until,
        working_days: form.working_days,
      }),
    onSuccess: onDone,
    onError: (err: unknown) => {
      setError(
        err instanceof Error ? err.message : "Không thể cập nhật giờ làm việc.",
      );
    },
  });

  return (
    <Card>
      <h2>
        Cài đặt giờ làm việc — {user.full_name} (@{user.username})
      </h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          if (!form.working_days.length) {
            setError("Vui lòng chọn ít nhất một ngày làm việc trong tuần.");
            return;
          }
          m.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Giờ bắt đầu làm việc">
            <input
              type="time"
              value={form.allowed_from ? form.allowed_from.slice(0, 5) : "00:00"}
              onChange={(e) => {
                const val = e.target.value.trim();
                setForm({
                  ...form,
                  allowed_from: val ? (val.length === 5 ? val + ":00" : val) : "00:00:00",
                });
              }}
            />
          </Field>
          <Field label="Giờ kết thúc làm việc">
            <input
              type="time"
              value={form.allowed_until ? form.allowed_until.slice(0, 5) : "23:59"}
              onChange={(e) => {
                const val = e.target.value.trim();
                setForm({
                  ...form,
                  allowed_until: val ? (val.length === 5 ? val + ":00" : val) : "23:59:59",
                });
              }}
            />
          </Field>
        </div>
        <Field label="Ngày làm việc trong tuần">
          <WorkingDaysPicker
            value={form.working_days}
            onChange={(working_days) => setForm({ ...form, working_days })}
          />
        </Field>
        {error && <p className="field-error">{error}</p>}
        {!!m.error && !error && <ErrorState error={m.error} />}
        <div className="row">
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Đang lưu…" : "Lưu thay đổi"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Hủy
          </Button>
        </div>
      </form>
    </Card>
  );
}
