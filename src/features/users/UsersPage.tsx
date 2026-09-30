import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Users,
  Key,
  Clock,
  Calendar,
  Trash2,
  RotateCcw,
  Lock,
  Unlock,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  PageHeader,
} from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { roleLabels } from "@/lib/permissions";
import type { Profile, Role } from "@/types";
import { CreateUserModal } from "./components/CreateUserModal";
import { EditScheduleModal } from "./components/EditScheduleModal";
import { ResetPasswordModal } from "./components/ResetPasswordModal";
import { DisableUserModal } from "./components/DisableUserModal";
import { DeleteUserModal } from "./components/DeleteUserModal";

export default function UsersPage() {
  const client = useQueryClient();
  const { profile } = useAuth();
  const [adding, setAdding] = useState(false),
    [notice, setNotice] = useState(""),
    [editingSchedule, setEditingSchedule] = useState<Profile | null>(null),
    [resettingPassword, setResettingPassword] = useState<Profile | null>(null),
    [disablingUser, setDisablingUser] = useState<Profile | null>(null),
    [deletingUser, setDeletingUser] = useState<Profile | null>(null);

  const q = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.call<Profile[]>("list_profiles"),
  });

  const mutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Profile> }) =>
      api.call("update_profile", { p_id: id, p_data: data }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["profiles"] });
      setNotice("Đã cập nhật quyền tài khoản.");
    },
  });

  return (
    <div className="stack">
      <PageHeader
        title="Nhân sự"
        description="Mỗi người một tài khoản. Mỗi vai trò một quyền hạn rõ ràng."
        actions={
          <Button onClick={() => setAdding(!adding)}>
            <Plus size={18} />
            Thêm tài khoản
          </Button>
        }
      />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {!!mutation.error && <ErrorState error={mutation.error} />}
      <div className="notice row">
        <Users size={20} />
        <span>
          Nhân viên và người chỉ xem không được truy cập giá mua, lợi nhuận hoặc
          quản trị hệ thống. Múi giờ cửa hàng: <strong>Asia/Ho_Chi_Minh</strong>.
        </span>
      </div>

      {adding && (
        <CreateUserModal
          onDone={() => {
            setAdding(false);
            setNotice(
              "Tài khoản đã được tạo. Chuyển mật khẩu ban đầu cho nhân viên qua kênh bảo mật.",
            );
            void client.invalidateQueries({ queryKey: ["profiles"] });
          }}
        />
      )}

      {editingSchedule && (
        <EditScheduleModal
          user={editingSchedule}
          onDone={() => {
            setEditingSchedule(null);
            setNotice("Đã cập nhật giờ và lịch làm việc.");
            void client.invalidateQueries({ queryKey: ["profiles"] });
          }}
        />
      )}

      {resettingPassword && (
        <ResetPasswordModal
          user={resettingPassword}
          onDone={() => {
            setResettingPassword(null);
            setNotice("Đã đặt lại mật khẩu tạm thời thành công.");
            void client.invalidateQueries({ queryKey: ["profiles"] });
          }}
        />
      )}

      {disablingUser && (
        <DisableUserModal
          user={disablingUser}
          onDone={() => {
            setDisablingUser(null);
            setNotice("Đã cập nhật trạng thái hoạt động của tài khoản.");
            void client.invalidateQueries({ queryKey: ["profiles"] });
          }}
        />
      )}

      {deletingUser && (
        <DeleteUserModal
          user={deletingUser}
          onDone={() => {
            setDeletingUser(null);
            setNotice("Thao tác tài khoản hoàn tất.");
            void client.invalidateQueries({ queryKey: ["profiles"] });
          }}
        />
      )}

      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <div className="user-grid">
          {q.data?.map((p) => {
            const isSelf = p.id === profile?.id;
            const isOwnerAcc = p.role === "OWNER";
            const isLocked =
              p.disabled_until && new Date(p.disabled_until) > new Date();

            return (
              <Card key={p.id}>
                <div className="row between">
                  <div className="row">
                    <span className="avatar large">
                      {p.full_name.split(" ").at(-1)?.[0]}
                    </span>
                    <div>
                      <h3>{p.full_name}</h3>
                      <small className="muted">
                        @{p.username} · {isSelf ? "Tài khoản của bạn" : roleLabels[p.role]}
                      </small>
                      {p.deleted_at && (
                        <div>
                          <span className="badge badge-cancelled">Đã vô hiệu hóa</span>
                        </div>
                      )}
                      {isLocked && (
                        <div>
                          <span className="badge badge-cancelled">
                            Khóa tạm đến{" "}
                            {new Date(p.disabled_until!).toLocaleTimeString("vi-VN", {
                              hour: "2-digit",
                              minute: "2-digit",
                              day: "2-digit",
                              month: "2-digit",
                            })}
                          </span>
                        </div>
                      )}
                      {p.must_change_password && (
                        <div>
                          <span className="badge badge-pending">Cần đổi mật khẩu</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <span
                    className={`badge ${p.active && !p.deleted_at && !isLocked ? "badge-active" : "badge-cancelled"}`}
                  >
                    {p.active && !p.deleted_at && !isLocked
                      ? "Hoạt động"
                      : "Tạm dừng"}
                  </span>
                </div>

                <div className="stack" style={{ marginTop: "16px" }}>
                  <Field label="Vai trò">
                    <select
                      aria-label={`Vai trò ${p.full_name}`}
                      value={p.role}
                      disabled={mutation.isPending || isOwnerAcc || p.deleted_at !== null}
                      onChange={(e) =>
                        mutation.mutate({
                          id: p.id,
                          data: { role: e.target.value as Role },
                        })
                      }
                    >
                      {Object.entries(roleLabels).map(([k, v]) => (
                        <option
                          key={k}
                          value={k}
                          disabled={k === "OWNER" && !isOwnerAcc}
                        >
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>

                  {p.role === "MANAGER" && (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={p.can_view_financials}
                        disabled={mutation.isPending || p.deleted_at !== null}
                        onChange={(e) =>
                          mutation.mutate({
                            id: p.id,
                            data: { can_view_financials: e.target.checked },
                          })
                        }
                      />
                      Cho phép xem giá mua và lợi nhuận
                    </label>
                  )}

                  {!isOwnerAcc && (
                    <>
                      <div className="row between small">
                        <span className="row" style={{ gap: "4px" }}>
                          <Clock size={14} /> Giờ làm việc:
                        </span>
                        <span className="muted">
                          {p.allowed_from?.slice(0, 5) || "00:00"} -{" "}
                          {p.allowed_until?.slice(0, 5) || "23:59"}
                        </span>
                      </div>

                      <div className="row between small">
                        <span className="row" style={{ gap: "4px" }}>
                          <Calendar size={14} /> Ngày làm việc:
                        </span>
                        <span className="muted">
                          {p.working_days && p.working_days.length > 0
                            ? p.working_days
                                .map((d) => {
                                  const days = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
                                  return days[d - 1] || `T${d}`;
                                })
                                .join(", ")
                            : "Tất cả các ngày"}
                        </span>
                      </div>
                    </>
                  )}

                  <div className="row between" style={{ marginTop: "12px" }}>
                    <Badge status={p.role} />
                    <div className="row" style={{ gap: "6px" }}>
                      {!isSelf && !isOwnerAcc && (
                        <>
                          <Button
                            variant="secondary"
                            disabled={mutation.isPending}
                            onClick={() => setResettingPassword(p)}
                            title="Đặt lại mật khẩu tạm"
                          >
                            <Key size={16} />
                          </Button>

                          <Button
                            variant="secondary"
                            disabled={mutation.isPending}
                            onClick={() => setEditingSchedule(p)}
                            title="Cài đặt lịch & giờ làm việc"
                          >
                            <Clock size={16} />
                          </Button>

                          <Button
                            variant="secondary"
                            disabled={mutation.isPending}
                            onClick={() => setDisablingUser(p)}
                            title={isLocked ? "Mở khóa tạm" : "Khóa tạm thời"}
                          >
                            {isLocked ? <Unlock size={16} /> : <Lock size={16} />}
                          </Button>

                          {p.deleted_at ? (
                            <Button
                              variant="secondary"
                              disabled={mutation.isPending}
                              onClick={() => {
                                mutation.mutate({
                                  id: p.id,
                                  data: { deleted_at: null, active: true },
                                });
                              }}
                              title="Khôi phục tài khoản"
                            >
                              <RotateCcw size={16} />
                            </Button>
                          ) : (
                            <Button
                              variant="danger"
                              disabled={mutation.isPending}
                              onClick={() => setDeletingUser(p)}
                              title="Vô hiệu hóa hoặc xóa"
                            >
                              <Trash2 size={16} />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {q.data?.length === 0 && <EmptyState title="Chưa có tài khoản" />}
    </div>
  );
}
