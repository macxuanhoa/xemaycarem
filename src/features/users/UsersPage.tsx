import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
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
export default function UsersPage() {
  const client = useQueryClient();
  const { profile } = useAuth();
  const [adding, setAdding] = useState(false),
    [notice, setNotice] = useState("");
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
      {mutation.error && <ErrorState error={mutation.error} />}
      <div className="notice row">
        <Users size={20} />
        <span>
          Nhân viên và người chỉ xem không được truy cập giá mua, lợi nhuận hoặc
          quản trị hệ thống.
        </span>
      </div>
      {adding && (
        <CreateUser
          onDone={() => {
            setAdding(false);
            setNotice(
              "Tài khoản đã được tạo. Chuyển mật khẩu ban đầu cho nhân viên qua kênh bảo mật.",
            );
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
          {q.data?.map((p) => (
            <Card key={p.id}>
              <div className="row between">
                <div className="row">
                  <span className="avatar large">
                    {p.full_name.split(" ").at(-1)?.[0]}
                  </span>
                  <div>
                    <h3>{p.full_name}</h3>
                    <small className="muted">
                      {p.id === profile?.id
                        ? "Tài khoản của bạn"
                        : roleLabels[p.role]}
                    </small>
                  </div>
                </div>
                <span
                  className={`badge ${p.active ? "badge-active" : "badge-cancelled"}`}
                >
                  {p.active ? "Hoạt động" : "Đã khóa"}
                </span>
              </div>
              <div className="stack">
                <Field label="Vai trò">
                  <select
                    aria-label={`Vai trò ${p.full_name}`}
                    value={p.role}
                    disabled={mutation.isPending}
                    onChange={(e) =>
                      mutation.mutate({
                        id: p.id,
                        data: { role: e.target.value as Role },
                      })
                    }
                  >
                    {Object.entries(roleLabels).map(([k, v]) => (
                      <option key={k} value={k}>
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
                      disabled={mutation.isPending}
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
                <div className="row between">
                  <Badge status={p.role} />
                  <Button
                    variant={p.active ? "danger" : "secondary"}
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({ id: p.id, data: { active: !p.active } })
                    }
                  >
                    {p.active ? "Khóa tài khoản" : "Mở khóa"}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {q.data?.length === 0 && <EmptyState title="Chưa có tài khoản" />}
    </div>
  );
}
function CreateUser({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    role: "STAFF",
    can_view_financials: false,
  });
  const m = useMutation({
    mutationFn: () => api.createUser(form),
    onSuccess: onDone,
  });
  return (
    <Card>
      <h2>Tạo tài khoản nhân viên</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Họ và tên">
            <input
              required
              maxLength={120}
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Mật khẩu ban đầu (tối thiểu 12 ký tự)">
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="Vai trò">
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              {Object.entries(roleLabels).map(([k, v]) => (
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
            Cho phép xem giá mua và lợi nhuận
          </label>
        )}
        {m.error && <ErrorState error={m.error} />}
        <div>
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Đang tạo…" : "Tạo tài khoản"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
