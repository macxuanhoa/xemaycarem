import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Eye,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, Card, ErrorState, Field, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import type {
  Announcement,
  AnnouncementAudience,
  AnnouncementDisplay,
  AnnouncementType,
} from "@/types";

const TYPES: AnnouncementType[] = ["INFO", "SUCCESS", "WARNING", "CRITICAL"];
const DISPLAYS: AnnouncementDisplay[] = ["STATIC", "SCROLLING"];
const AUDIENCES: AnnouncementAudience[] = [
  "ALL",
  "OWNER",
  "MANAGER",
  "STAFF",
];
const TYPE_LABEL: Record<AnnouncementType, string> = {
  INFO: "Thông tin",
  SUCCESS: "Tích cực",
  WARNING: "Cảnh báo",
  CRITICAL: "Khẩn cấp",
};
const DISPLAY_LABEL: Record<AnnouncementDisplay, string> = {
  STATIC: "Đứng yên",
  SCROLLING: "Chạy ngang",
};
const AUDIENCE_LABEL: Record<AnnouncementAudience, string> = {
  ALL: "Tất cả mọi người",
  OWNER: "Chỉ Chủ cửa hàng",
  MANAGER: "Chỉ Quản lý",
  STAFF: "Chỉ Nhân viên",
};

type Draft = {
  id?: string;
  title: string;
  message: string;
  type: AnnouncementType;
  display_mode: AnnouncementDisplay;
  audience: AnnouncementAudience;
  dismissible: boolean;
  is_active: boolean;
  starts_at: string;
  ends_at: string;
};

const EMPTY: Draft = {
  title: "",
  message: "",
  type: "INFO",
  display_mode: "STATIC",
  audience: "ALL",
  dismissible: true,
  is_active: true,
  starts_at: "",
  ends_at: "",
};

// Vietnam is a fixed UTC+7 zone (no DST), so a naive datetime-local value maps
// unambiguously to an absolute instant by appending the offset.
const toInputValue = (iso?: string | null) => {
  if (!iso) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Ho_Chi_Minh",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const fromInputValue = (value: string) => (value ? `${value}+07:00` : null);

const scheduleLabel = (a: Announcement) => {
  if (!a.starts_at && !a.ends_at) return "Hiển thị ngay khi kích hoạt";
  const fmt = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("vi-VN", {
          timeZone: "Asia/Ho_Chi_Minh",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(iso))
      : "…";
  return `Từ ${fmt(a.starts_at)} → Đến ${fmt(a.ends_at)}`;
};

export function AnnouncementManager() {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ["announcements"],
    queryFn: () => api.listAnnouncements(),
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["announcements"] });
    void client.invalidateQueries({ queryKey: ["active-announcements"] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.saveAnnouncement({
        id: d.id,
        title: d.title.trim() || null,
        message: d.message.trim(),
        type: d.type,
        display_mode: d.display_mode,
        audience: d.audience,
        dismissible: d.dismissible,
        is_active: d.is_active,
        starts_at: fromInputValue(d.starts_at),
        ends_at: fromInputValue(d.ends_at),
      }),
    onSuccess: () => {
      toast.success("Đã lưu thông báo", {
        description: "Thông báo hệ thống đã được cập nhật.",
      });
      setDraft(null);
      refresh();
    },
    onError: (err) =>
      toast.error("Không thể lưu thông báo", { description: friendlyError(err) }),
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; active: boolean }) =>
      api.setAnnouncementActive(vars.id, vars.active),
    onSuccess: (_data, vars) => {
      toast.success(
        vars.active ? "Đã kích hoạt thông báo" : "Đã tạm ngừng thông báo",
      );
      refresh();
    },
    onError: (err) => toast.error("Thao tác thất bại", { description: friendlyError(err) }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAnnouncement(id),
    onSuccess: () => {
      toast.success("Đã xóa thông báo");
      refresh();
    },
    onError: (err) => toast.error("Không thể xóa", { description: friendlyError(err) }),
  });

  const startEdit = (a: Announcement) =>
    setDraft({
      id: a.id,
      title: a.title ?? "",
      message: a.message,
      type: a.type,
      display_mode: a.display_mode,
      audience: a.audience ?? "ALL",
      dismissible: a.dismissible,
      is_active: a.is_active ?? false,
      starts_at: toInputValue(a.starts_at),
      ends_at: toInputValue(a.ends_at),
    });

  const askDelete = async (a: Announcement) => {
    const ok = await confirmAction({
      title: "Xóa thông báo hệ thống?",
      entity: a.title || a.message.slice(0, 60),
      description:
        "Thông báo sẽ biến mất khỏi toàn bộ cửa hàng và không thể khôi phục.",
      confirmLabel: "Xóa thông báo",
      tone: "danger",
    });
    if (ok) remove.mutate(a.id);
  };

  return (
    <Card>
      <div className="row between" style={{ alignItems: "center" }}>
        <div className="row" style={{ gap: "10px" }}>
          <Megaphone size={20} />
          <h2 style={{ margin: 0 }}>Thông báo hệ thống</h2>
        </div>
        {!draft && (
          <Button onClick={() => setDraft({ ...EMPTY })}>
            <Plus size={16} /> Tạo thông báo
          </Button>
        )}
      </div>
      <p className="muted small">
        Chủ cửa hàng đăng các thông báo nội bộ như lịch nghỉ, giờ làm, nhắc quy
        trình. Nhân viên thấy theo quyền và lịch đã đặt.
      </p>

      {draft && (
        <AnnouncementForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSubmit={() => save.mutate(draft)}
          saving={save.isPending}
          error={save.error}
        />
      )}

      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : list.data?.items.length === 0 ? (
        <p className="muted small">Chưa có thông báo nào.</p>
      ) : (
        <div className="announcement-admin-list">
          {list.data?.items.map((a) => (
            <div key={a.id} className={`announcement-admin-row announcement-${a.type}`}>
              <div className="announcement-admin-main">
                <div className="row" style={{ gap: "8px", flexWrap: "wrap" }}>
                  <span className={`badge-announcement badge-announcement-${a.type}`}>
                    {TYPE_LABEL[a.type]}
                  </span>
                  <span className="muted small">
                    {DISPLAY_LABEL[a.display_mode]} · {AUDIENCE_LABEL[a.audience ?? "ALL"]}
                  </span>
                  {a.is_active ? (
                    <span className="badge badge-active" />
                  ) : (
                    <span className="muted small">Tắt</span>
                  )}
                </div>
                <strong>{a.title || a.message.slice(0, 80)}</strong>
                <p className="muted small" style={{ margin: "2px 0 0" }}>
                  <CalendarClock size={12} style={{ verticalAlign: -2 }} />{" "}
                  {scheduleLabel(a)}
                </p>
              </div>
              <div className="announcement-admin-actions">
                <Button
                  variant="secondary"
                  onClick={() =>
                    toggle.mutate({ id: a.id, active: !a.is_active })
                  }
                  disabled={toggle.isPending}
                >
                  {a.is_active ? "Ngừng hiển thị" : "Kích hoạt"}
                </Button>
                <Button variant="ghost" onClick={() => startEdit(a)}>
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Xóa thông báo"
                  onClick={() => void askDelete(a)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AnnouncementForm({
  draft,
  onChange,
  onCancel,
  onSubmit,
  saving,
  error,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: Error | null;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  const invalid = draft.message.trim().length === 0;
  const previewText = draft.title.trim()
    ? `${draft.title.trim()}: ${draft.message.trim()}`
    : draft.message.trim();

  return (
    <form
      className="stack announcement-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) onSubmit();
      }}
    >
      <Field label="Tiêu đề (tùy chọn)">
        <input
          maxLength={120}
          value={draft.title}
          placeholder="Ví dụ: Lịch nghỉ Tết"
          onChange={(e) => set("title", e.target.value)}
        />
      </Field>
      <Field label="Nội dung *">
        <textarea
          required
          maxLength={500}
          rows={3}
          value={draft.message}
          placeholder="Ví dụ: Cửa hàng nghỉ Tết từ ngày 27/01 đến hết ngày 02/02."
          onChange={(e) => set("message", e.target.value)}
        />
      </Field>
      <div className="form-grid">
        <Field label="Loại">
          <select
            value={draft.type}
            onChange={(e) => set("type", e.target.value as AnnouncementType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kiểu hiển thị">
          <select
            value={draft.display_mode}
            onChange={(e) =>
              set("display_mode", e.target.value as AnnouncementDisplay)
            }
          >
            {DISPLAYS.map((d) => (
              <option key={d} value={d}>
                {DISPLAY_LABEL[d]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Đối tượng">
          <select
            value={draft.audience}
            onChange={(e) =>
              set("audience", e.target.value as AnnouncementAudience)
            }
          >
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Bắt đầu hiển thị">
          <input
            type="datetime-local"
            value={draft.starts_at}
            onChange={(e) => set("starts_at", e.target.value)}
          />
        </Field>
        <Field label="Ngưng hiển thị">
          <input
            type="datetime-local"
            value={draft.ends_at}
            onChange={(e) => set("ends_at", e.target.value)}
          />
        </Field>
      </div>
      <div className="row" style={{ gap: "18px", flexWrap: "wrap" }}>
        <label className="row">
          <input
            type="checkbox"
            checked={draft.is_active}
            onChange={(e) => set("is_active", e.target.checked)}
          />
          <span>Kích hoạt (publish)</span>
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={draft.dismissible}
            onChange={(e) => set("dismissible", e.target.checked)}
          />
          <span>Cho phép nhân viên ẩn thông báo</span>
        </label>
      </div>

      <div className="announcement-preview">
        <span className="muted small">
          <Eye size={12} style={{ verticalAlign: -2 }} /> Xem trước
        </span>
        <div className={`announcement-bar announcement-${draft.type}`} aria-hidden>
          <span className={`announcement-icon announcement-icon-${draft.type}`}>
            <Megaphone size={15} />
          </span>
          <div className="announcement-content" data-mode={draft.display_mode}>
            {draft.display_mode === "SCROLLING" ? (
              <span className="announcement-track">
                <span className="announcement-segment">{previewText || "…"}</span>
              </span>
            ) : (
              <span className="announcement-static-text">
                {previewText || "Nhập nội dung để xem trước."}
              </span>
            )}
          </div>
        </div>
      </div>

      {error ? <ErrorState error={error} /> : null}
      <div className="row">
        <Button type="submit" disabled={saving || invalid}>
          {saving ? "Đang lưu…" : draft.id ? "Cập nhật" : "Tạo thông báo"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Hủy
        </Button>
      </div>
    </form>
  );
}
