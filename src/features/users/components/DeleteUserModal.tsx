import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import type { Profile } from "@/types";

export function DeleteUserModal({
  user,
  onDone,
}: {
  user: Profile;
  onDone: () => void;
}) {
  const [disableReason, setDisableReason] = useState("");
  const [hardDelete, setHardDelete] = useState(false);
  const [error, setError] = useState("");
  const m = useMutation({
    mutationFn: () =>
      api.manageUser({
        action: hardDelete ? "hard_delete" : "delete",
        user_id: user.id,
        disable_reason: disableReason || null,
      }),
    onSuccess: onDone,
    onError: (err: unknown) => {
      setError(
        err instanceof Error
          ? err.message
          : "Không thể thực hiện thao tác xóa. Vui lòng thử lại.",
      );
    },
  });

  return (
    <Card>
      <h2>
        {hardDelete ? "Xóa hoàn toàn tài khoản" : "Vô hiệu hóa tài khoản"} —{" "}
        {user.full_name} (@{user.username})
      </h2>
      <div className="stack">
        {!hardDelete ? (
          <>
            <p className="muted">
              Tài khoản sẽ được chuyển sang trạng thái vô hiệu hóa. Người dùng
              ngay lập tức mất toàn bộ quyền truy cập hệ thống. Mọi giao dịch kinh
              doanh trước đây (nhập xe, bán xe, chi phí, chứng từ) vẫn được lưu
              trữ vĩnh viễn với danh tính của nhân viên này để đảm bảo tính toàn
              vẹn.
            </p>
            <Field label="Lý do vô hiệu hóa">
              <input
                type="text"
                value={disableReason}
                onChange={(e) => setDisableReason(e.target.value)}
                placeholder="Ví dụ: Nhân viên đã nghỉ việc..."
              />
            </Field>
            {user.role !== "OWNER" && (
              <label
                className="checkbox"
                style={{
                  marginTop: "8px",
                  color: "var(--color-danger)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={hardDelete}
                  onChange={(e) => {
                    setHardDelete(e.target.checked);
                    setError("");
                  }}
                />
                Tôi muốn xóa hoàn toàn tài khoản chưa từng sử dụng khỏi hệ thống
              </label>
            )}
          </>
        ) : (
          <>
            <div
              className="row"
              style={{
                padding: "12px",
                background: "rgba(239, 68, 68, 0.1)",
                borderRadius: "8px",
                gap: "8px",
                color: "var(--color-danger)",
              }}
            >
              <ShieldAlert size={24} style={{ flexShrink: 0 }} />
              <div>
                <strong>CẢNH BÁO QUAN TRỌNG:</strong> Xóa hoàn toàn sẽ xóa hồ
                sơ và tài khoản đăng nhập khỏi cơ sở dữ liệu. Thao tác này CHỈ
                thành công nếu tài khoản chưa từng tham gia bất kỳ nghiệp vụ kinh
                doanh nào.
              </div>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={hardDelete}
                onChange={(e) => {
                  setHardDelete(e.target.checked);
                  setError("");
                }}
              />
              Xác nhận xóa hoàn toàn tài khoản chưa sử dụng
            </label>
          </>
        )}

        {error && <p className="field-error">{error}</p>}
        {!!m.error && !error && <ErrorState error={m.error} />}
        <div className="row">
          <Button
            variant={hardDelete ? "danger" : "secondary"}
            disabled={m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending
              ? "Đang xử lý…"
              : hardDelete
                ? "Xóa vĩnh viễn tài khoản"
                : "Vô hiệu hóa tài khoản"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Hủy
          </Button>
        </div>
      </div>
    </Card>
  );
}
