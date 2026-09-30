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
          m.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Giờ bắt đầu làm việc">
            <input
              type="time"
              value={form.allowed_from.slice(0, 5)}
              onChange={(e) =>
                setForm({ ...form, allowed_from: e.target.value + ":00" })
              }
            />
          </Field>
          <Field label="Giờ kết thúc làm việc">
            <input
              type="time"
              value={form.allowed_until.slice(0, 5)}
              onChange={(e) =>
                setForm({ ...form, allowed_until: e.target.value + ":00" })
              }
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
