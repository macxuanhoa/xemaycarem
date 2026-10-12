import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { WorkingDaysPicker } from "./WorkingDaysPicker";

/** Shared working-time settings live on system_settings and apply to every
 *  non-OWNER role (Quản lý + Nhân viên) — one schedule used store-wide. */
type StaffScheduleSettings = {
  staff_allowed_from?: string;
  staff_allowed_until?: string;
  staff_working_days?: number[];
};

export function SharedScheduleCard({ onSaved }: { onSaved: (msg: string) => void }) {
  const client = useQueryClient();
  const [from, setFrom] = useState("00:00");
  const [until, setUntil] = useState("23:59");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");

  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.call<StaffScheduleSettings>("get_settings"),
  });

  // Seed the draft from the server once; user edits win until the next save.
  useEffect(() => {
    if (!q.data || dirty) return;
    setFrom(q.data.staff_allowed_from?.slice(0, 5) || "00:00");
    setUntil(q.data.staff_allowed_until?.slice(0, 5) || "23:59");
    setDays(
      q.data.staff_working_days && q.data.staff_working_days.length > 0
        ? [...q.data.staff_working_days]
        : [1, 2, 3, 4, 5, 6, 7],
    );
  }, [q.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.call("save_settings", {
        p_data: {
          staff_allowed_from: `${from}:00`,
          staff_allowed_until: `${until}:00`,
          staff_working_days: days,
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["settings"] });
      void client.invalidateQueries({ queryKey: ["profiles"] });
      setDirty(false);
      setError("");
      onSaved("Đã cập nhật giờ làm việc chung cho Quản lý và Nhân viên.");
    },
    onError: (err: unknown) => {
      // PostgREST rejects with plain objects sometimes; surface the real cause
      // instead of the generic fallback so owners know what to fix.
      setError(friendlyError(err) || "Không thể lưu giờ làm việc chung.");
    },
  });

  if (q.error && !q.data) return <ErrorState error={q.error} />;

  const invalidDays = days.length === 0;

  return (
    <Card className="staff-schedule-card">
      <div className="user-tab-lead">
        <div className="row" style={{ gap: "8px", alignItems: "center" }}>
          <CalendarClock size={18} style={{ color: "var(--primary, #4f46e5)" }} />
          <strong>Giờ làm việc chung của Quản lý &amp; Nhân viên</strong>
        </div>
        <p className="muted small">
          Một lịch dùng chung cho mọi vai trò không phải Chủ cửa hàng. Ngoài khung
          giờ và ngày này, hệ thống chặn đăng nhập và thao tác. Chủ cửa hàng không
          bị giới hạn.
        </p>
      </div>

      {q.isPending ? null : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            if (invalidDays) {
              setError("Vui lòng chọn ít nhất một ngày làm việc trong tuần.");
              return;
            }
            save.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="Giờ bắt đầu làm việc">
              <input
                type="time"
                value={from}
                disabled={save.isPending}
                onChange={(e) => {
                  setDirty(true);
                  setFrom(e.target.value);
                }}
              />
            </Field>
            <Field label="Giờ kết thúc làm việc">
              <input
                type="time"
                value={until}
                disabled={save.isPending}
                onChange={(e) => {
                  setDirty(true);
                  setUntil(e.target.value);
                }}
              />
            </Field>
          </div>

          <Field label="Các ngày làm việc trong tuần (Asia/Ho_Chi_Minh)">
            <WorkingDaysPicker
              value={days}
              onChange={(next) => {
                setDirty(true);
                setDays(next);
              }}
            />
          </Field>

          {error && <p className="field-error">{error}</p>}

          <div className="user-tab-actions">
            <Button type="submit" disabled={save.isPending || !dirty}>
              {save.isPending ? "Đang lưu…" : "Lưu giờ làm việc chung"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
