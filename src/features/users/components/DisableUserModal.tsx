import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import type { Profile } from "@/types";

export function DisableUserModal({
  user,
  onDone,
}: {
  user: Profile;
  onDone: () => void;
}) {
  const [disableUntil, setDisableUntil] = useState(
    user.disabled_until ? user.disabled_until.slice(0, 16) : "",
  );
  const [disableReason, setDisableReason] = useState(user.disable_reason || "");
  const [error, setError] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "disable",
        user_id: user.id,
        disabled_until: disableUntil ? new Date(disableUntil).toISOString() : null,
        disable_reason: disableReason || null,
      }),
    onSuccess: onDone,
    onError: (err: unknown) => {
      setError(
        err instanceof Error ? err.message : "Không thể cập nhật trạng thái.",
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    m.mutate();
  };

  return (
    <Card>
      <h2>
        Khóa tạm thời — {user.full_name} (@{user.username})
      </h2>
      <form className="stack" onSubmit={handleSubmit}>
        <Field label="Khóa tạm đến thời điểm (để trống để khóa đến khi mở lại)">
          <input
            type="datetime-local"
            value={disableUntil}
            onChange={(e) => setDisableUntil(e.target.value)}
          />
          <small className="muted">
            Khi hết thời gian này, tài khoản sẽ tự động được phép hoạt động lại
          </small>
        </Field>
        <Field label="Lý do khóa tạm">
          <input
            type="text"
            value={disableReason}
            onChange={(e) => setDisableReason(e.target.value)}
            placeholder="Ví dụ: Nghỉ phép, tạm dừng phân công..."
          />
        </Field>
        {error && <p className="field-error">{error}</p>}
        {!!m.error && !error && <ErrorState error={m.error} />}
        <div className="row">
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Đang cập nhật…" : "Lưu trạng thái"}
          </Button>
          {user.disabled_until && (
            <Button
              variant="secondary"
              disabled={m.isPending}
              onClick={() => {
                setDisableUntil("");
                setDisableReason("");
                m.mutate();
              }}
            >
              Mở khóa ngay
            </Button>
          )}
          <Button variant="secondary" onClick={onDone}>
            Hủy
          </Button>
        </div>
      </form>
    </Card>
  );
}
