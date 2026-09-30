import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import type { Profile } from "@/types";

export function ResetPasswordModal({
  user,
  onDone,
}: {
  user: Profile;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: "reset_password",
        user_id: user.id,
        password,
      }),
    onSuccess: onDone,
    onError: (err: unknown) => {
      setError(
        err instanceof Error ? err.message : "Không thể đặt lại mật khẩu.",
      );
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 12) {
      setError("Mật khẩu mới phải có tối thiểu 12 ký tự.");
      return;
    }

    m.mutate();
  };

  return (
    <Card>
      <h2>
        Đặt lại mật khẩu tạm — {user.full_name} (@{user.username})
      </h2>
      <form className="stack" onSubmit={handleSubmit}>
        <p className="muted">
          Hệ thống sẽ cập nhật mật khẩu mới thông qua kết nối bảo mật server-side.
          Nhân viên sẽ được yêu cầu đổi sang mật khẩu cá nhân khi đăng nhập.
        </p>
        <Field label="Mật khẩu tạm thời mới (tối thiểu 12 ký tự)">
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            placeholder="Nhập mật khẩu tạm thời"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <p className="field-error">{error}</p>}
        {!!m.error && !error && <ErrorState error={m.error} />}
        <div className="row">
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Đang lưu…" : "Xác nhận đổi mật khẩu"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Hủy
          </Button>
        </div>
      </form>
    </Card>
  );
}
