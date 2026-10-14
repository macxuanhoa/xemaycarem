import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileText,
  Info,
  LayoutTemplate,
  Megaphone,
  OctagonAlert,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  Search,
  Sparkles,
  TriangleAlert,
  Trash2,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { useDialog } from "@/lib/useDialog";
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
const TYPE_ICON: Record<AnnouncementType, typeof Info> = {
  INFO: Info,
  SUCCESS: CheckCircle2,
  WARNING: TriangleAlert,
  CRITICAL: OctagonAlert,
};
const DISPLAY_LABEL: Record<AnnouncementDisplay, string> = {
  STATIC: "Đứng yên",
  SCROLLING: "Chạy ngang",
};
const DISPLAY_ICON: Record<AnnouncementDisplay, typeof Info> = {
  STATIC: AlignLeft,
  SCROLLING: Repeat,
};
const AUDIENCE_LABEL: Record<AnnouncementAudience, string> = {
  ALL: "Tất cả mọi người",
  OWNER: "Chỉ Chủ cửa hàng",
  MANAGER: "Chỉ Quản lý",
  STAFF: "Chỉ Nhân viên",
};

/** Nội dung mẫu — chủ cửa hàng bấm là có ngay bố cục chuẩn, chỉ việc sửa chi tiết. */
const TEMPLATES: { label: string; title: string; message: string; type: AnnouncementType }[] = [
  {
    label: "Lịch nghỉ lễ",
    title: "Lịch nghỉ lễ",
    message:
      "Cửa hàng nghỉ … từ ngày …/… đến hết ngày …/….\nHotline bán hàng & bảo hành trong thời gian nghỉ: …\nKính chúc Quý khách kỳ nghỉ vui vẻ!",
    type: "INFO",
  },
  {
    label: "Giờ làm việc",
    title: "Giờ làm việc",
    message:
      "Cửa hàng làm việc từ …h … đến …h … hằng ngày (nghỉ …).\nKhách đến sau giờ mở cửa vui lòng liên hệ hotline trước để được hỗ trợ.",
    type: "INFO",
  },
  {
    label: "Nhắc quy trình",
    title: "Quy trình bàn giao xe",
    message:
      "Nhắc toàn cửa hàng:\n1. Chụp ảnh đồng hồ & tình trạng xe khi nhận.\n2. đối chiếu công nợ trước khi cho xe ra khỏi kho.\n3. Bàn giao đủ phụ kiện, hóa đơn, sổ bảo hành cho khách.",
    type: "WARNING",
  },
  {
    label: "Bảo trì hệ thống",
    title: "Bảo trì hệ thống",
    message:
      "Hệ thống phần mềm sẽ bảo trì từ …h … đến …h … ngày …/….\nTrong thời gian này vui lòng ghi bán hàng ra giấy và nhập bù sau.",
    type: "CRITICAL",
  },
  {
    label: "Khen thưởng",
    title: "Khen thưởng",
    message:
      "Chúc mừng … đã đạt doanh số tốt nhất tháng ….\nThưởng … đồng, trao vào cuộc họp tới. Cả cửa hàng cùng cố gắng!",
    type: "SUCCESS",
  },
];

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

const VT_ZONE = "Asia/Ho_Chi_Minh";
const fmtDateTime = (iso: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    timeZone: VT_ZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
const fmtClock = (iso: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    timeZone: VT_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
/** Mốc "cách đây …" gọn gàng cho chân thẻ — chủ quán biết nội dung cũ hay mới. */
const relativeStamp = (iso: string, nowMs: number) => {
  const diff = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: VT_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
};

/** Giá trị datetime-local ("2026-02-01T08:00") theo giờ Việt Nam, lấy mốc là `now`. */
function vtNowParts(now: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: VT_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    clock: `${p.hour}:${p.minute}`,
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
  };
}
/** Date trung hạn (giữ nguyên lịch Việt Nam) dạng "YYYY-MM-DD". */
function vtAddDays(now: Date, days: number) {
  const p = vtNowParts(now);
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Trạng thái hiển thị thật của một thông báo, tính theo giờ Việt Nam.
 * Server đã lọc cửa sổ thời gian khi phát, nên ở đây chỉ mô dẫn cho chủ quán biết
 * thông báo đang sống hay còn hẹn giờ / đã hết hạn.
 */
type LiveStatus = "LIVE" | "SCHEDULED" | "ENDED" | "PAUSED";
const STATUS_LABEL: Record<LiveStatus, string> = {
  LIVE: "Đang hiển thị",
  SCHEDULED: "Đã hẹn giờ",
  ENDED: "Đã hết hạn",
  PAUSED: "Tạm ngừng",
};

const resolveStatus = (a: Announcement, nowMs: number): LiveStatus => {
  if (!a.is_active) return "PAUSED";
  const start = a.starts_at ? Date.parse(a.starts_at) : null;
  const end = a.ends_at ? Date.parse(a.ends_at) : null;
  if (start !== null && start > nowMs) return "SCHEDULED";
  if (end !== null && end < nowMs) return "ENDED";
  return "LIVE";
};

type FilterKey = "ALL" | LiveStatus;
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ALL", label: "Tất cả" },
  { key: "LIVE", label: "Đang hiển thị" },
  { key: "SCHEDULED", label: "Hẹn giờ" },
  { key: "ENDED", label: "Hết hạn" },
  { key: "PAUSED", label: "Tạm ngừng" },
];

export function AnnouncementManager() {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: ["announcements"],
    queryFn: () => api.listAnnouncements(),
    // Lịch hiển thị chạy theo giờ thật: tự nạp lại để thẻ trạng thái đổi
    // "hẹn giờ" → "đang hiển thị" mà chủ quán không phải F5.
    refetchInterval: 60_000,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<FilterKey>("ALL");

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

  /** Trả về true nếu form thực sự đóng (không có nội dung hoặc người dùng xác nhận). */
  const askCancelDraft = async () => {
    if (!draft) return true;
    const hasContent = draft.title.trim() !== "" || draft.message.trim() !== "";
    if (!hasContent) {
      setDraft(null);
      return true;
    }
    const ok = await confirmAction({
      title: "Đóng form soạn thông báo?",
      entity: draft.title.trim() || draft.message.trim().slice(0, 60),
      description: "Nội dung đang soạn sẽ không được lưu.",
      confirmLabel: "Đóng",
      tone: "danger",
    });
    if (ok) setDraft(null);
    return ok;
  };

  // Form soạn thảo mở dạng popup: Esc/chạm nền mờ đóng qua askCancelDraft,
  // khóa cuộn nền và bẫy focus theo chuẩn dialog dùng chung toàn ứng dụng.
  const formPanelRef = useDialog(
    !!draft,
    () => void askCancelDraft(),
    save.isPending,
  );

  const rawItems = list.data?.items;
  const items = useMemo(() => rawItems ?? [], [rawItems]);
  // Một mốc thời gian dùng chung cho thẻ trạng thái + bộ lọc trong lần render này.
  // Mốc chỉ đổi khi danh sách nạp lại (kể cả poll 60s) để toàn bộ thẻ cùng
  // "thở" chung một giờ, tránh lệch nhãn trạng thái giữa các thẻ trong một lần vẽ.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowMs = useMemo(() => Date.now(), [items]);
  const statusOf = useMemo(
    () => new Map(items.map((a) => [a.id, resolveStatus(a, nowMs)])),
    [items, nowMs],
  );
  const counts = useMemo(() => {
    const acc: Record<FilterKey, number> = {
      ALL: items.length,
      LIVE: 0,
      SCHEDULED: 0,
      ENDED: 0,
      PAUSED: 0,
    };
    for (const a of items) acc[statusOf.get(a.id) ?? "PAUSED"] += 1;
    return acc;
  }, [items, statusOf]);
  const shown = useMemo(
    () => (filter === "ALL" ? items : items.filter((a) => statusOf.get(a.id) === filter)),
    [items, filter, statusOf],
  );

  const stats = [
    {
      key: "total",
      label: "Tổng thông báo",
      value: items.length,
      icon: FileText,
      tone: "slate",
      hint: "Tất cả đã tạo",
    },
    {
      key: "live",
      label: "Đang hiển thị",
      value: counts.LIVE,
      icon: Radio,
      tone: "emerald",
      hint: "Nhân viên đang thấy",
    },
    {
      key: "scheduled",
      label: "Đã hẹn giờ",
      value: counts.SCHEDULED,
      icon: Clock3,
      tone: "amber",
      hint: "Tự đăng đúng lịch",
    },
    {
      key: "paused",
      label: "Ngừng / hết hạn",
      value: counts.PAUSED + counts.ENDED,
      icon: WifiOff,
      tone: "slate",
      hint: "Không hiển thị",
    },
  ] as const;

  return (
    <Card className="announcement-console">
      <header className="announcement-console-hero">
        <div className="announcement-console-head">
          <span className="announcement-console-tile">
            <Megaphone size={22} strokeWidth={1.9} />
          </span>
          <div className="announcement-console-headings">
            <span className="announcement-console-eyebrow">
              <Sparkles size={11} /> Trung tâm thông báo · Nội bộ Cà Rem
            </span>
            <h2>Thông báo hệ thống</h2>
            <p>
              Đăng lịch nghỉ, giờ làm, nhắc quy trình hay khen thưởng — nhân viên
              thấy đúng theo quyền và lịch bạn đặt.
            </p>
          </div>
        </div>
        <div className="announcement-console-cta">
          <Button
            variant="secondary"
            onClick={refresh}
            aria-label="Làm mới danh sách thông báo"
          >
            <RefreshCw size={15} /> Làm mới
          </Button>
          <Button
            onClick={() => {
              void (async () => {
                // Đang soạn dở: hỏi đã đóng xong mới mở bản mới, tránh mất nội dung.
                if (draft && !(await askCancelDraft())) return;
                setDraft({ ...EMPTY });
              })();
            }}
          >
            <Plus size={16} /> {draft ? "Soạn mới" : "Tạo thông báo"}
          </Button>
        </div>
      </header>

      <div className="announcement-console-stats">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.key} className={`ac-stat ac-stat-${s.tone}`}>
              <span className="ac-stat-icon">
                <Icon size={17} strokeWidth={1.9} />
              </span>
              <div className="ac-stat-body">
                <span className="ac-stat-num">{s.value}</span>
                <span className="ac-stat-label">{s.label}</span>
                <span className="ac-stat-hint">{s.hint}</span>
              </div>
            </div>
          );
        })}
      </div>

      {draft && (
        <div
          className="dialog-backdrop"
          onClick={() => void askCancelDraft()}
          role="presentation"
        >
          <div
            className="dialog-panel announcement-form-dialog"
            ref={formPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="announcement-form-title"
            onClick={(e) => e.stopPropagation()}
          >
            <AnnouncementForm
              draft={draft}
              onChange={setDraft}
              onCancel={() => void askCancelDraft()}
              onSubmit={() => save.mutate(draft)}
              saving={save.isPending}
              error={save.error}
            />
          </div>
        </div>
      )}

      {list.isPending ? (
        <div className="ac-skeleton" aria-hidden>
          <span className="ac-skeleton-row" />
          <span className="ac-skeleton-row short" />
          <span className="ac-skeleton-row" />
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} />
      ) : items.length === 0 ? (
        <div className="ac-empty">
          <span className="ac-empty-icon">
            <Megaphone size={26} strokeWidth={1.6} />
          </span>
          <h3>Chưa có thông báo nào</h3>
          <p>
            Tạo thông báo đầu tiên để cả cửa hàng cùng nắm lịch nghỉ, giờ làm và
            quy trình đang áp dụng.
          </p>
          <Button onClick={() => setDraft({ ...EMPTY })}>
            <Plus size={16} /> Tạo thông báo
          </Button>
        </div>
      ) : (
        <>
          <div className="ac-toolbar">
            <div className="date-segmented-bar ac-filters" role="group" aria-label="Lọc theo trạng thái">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`date-seg-btn${filter === f.key ? " active" : ""}`}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  <span className="ac-filter-count">{counts[f.key]}</span>
                </button>
              ))}
            </div>
            <span className="ac-toolbar-meta muted small">
              <Users size={12} /> Hiển thị theo quyền · giờ Việt Nam (GMT+7)
            </span>
          </div>

          {shown.length === 0 ? (
            <div className="ac-empty-filtered">
              <Search size={18} strokeWidth={1.7} />
              <span>
                Không có thông báo ở nhóm «{FILTERS.find((f) => f.key === filter)?.label}»
              </span>
              <Button variant="ghost" onClick={() => setFilter("ALL")}>
                Xem tất cả
              </Button>
            </div>
          ) : (
            <div className="announcement-admin-list">
              {shown.map((a) => {
                const status = statusOf.get(a.id) ?? "PAUSED";
                const TypeIcon = TYPE_ICON[a.type];
                const DisplayIcon = DISPLAY_ICON[a.display_mode];
                const dim = status === "ENDED" || status === "PAUSED";
                return (
                  <article
                    key={a.id}
                    className={`ac-card announcement-${a.type}${dim ? " ac-card-dim" : ""}`}
                  >
                    <span className={`ac-card-accent ac-accent-${status}`} aria-hidden />
                    <div className="ac-card-body">
                      <div className="ac-card-top">
                        <span className={`ac-tile ac-tile-${a.type}`}>
                          <TypeIcon size={17} strokeWidth={1.9} />
                        </span>
                        {a.title ? (
                          <h3 className="ac-card-title">{a.title}</h3>
                        ) : (
                          <span className="ac-card-notitle muted small">
                            Không đặt tiêu đề — thanh thông báo hiển thị nguyên nội dung
                          </span>
                        )}
                        <span className={`ac-status ac-status-${status}`}>
                          <span className="ac-status-dot" aria-hidden />
                          {STATUS_LABEL[status]}
                        </span>
                      </div>

                      <p className="ac-card-message">{a.message}</p>

                      <div className="ac-card-meta">
                        <span className="ac-pill">
                          <span className={`badge-announcement badge-announcement-${a.type}`}>
                            {TYPE_LABEL[a.type]}
                          </span>
                        </span>
                        <span className="ac-pill">
                          <Users size={12} /> {AUDIENCE_LABEL[a.audience ?? "ALL"]}
                        </span>
                        <span className="ac-pill">
                          <DisplayIcon size={12} /> {DISPLAY_LABEL[a.display_mode]}
                        </span>
                        {a.starts_at && !a.ends_at && (
                          <span className="ac-pill">
                            <CalendarClock size={12} /> Từ {fmtDateTime(a.starts_at)}
                          </span>
                        )}
                        {!a.starts_at && a.ends_at && (
                          <span className="ac-pill">
                            <CalendarClock size={12} /> Hết {fmtDateTime(a.ends_at)}
                          </span>
                        )}
                        {a.starts_at && a.ends_at && (
                          <span className="ac-pill">
                            <CalendarClock size={12} />
                            {fmtDateTime(a.starts_at)} → {fmtDateTime(a.ends_at)}
                          </span>
                        )}
                        {!a.starts_at && !a.ends_at && (
                          <span className="ac-pill">
                            <Radio size={12} /> Hiển thị liên tục
                          </span>
                        )}
                        {a.dismissible ? (
                          <span className="ac-pill">
                            <X size={12} /> Nhân viên ẩn được
                          </span>
                        ) : (
                          <span className="ac-pill">
                            <Megaphone size={12} /> Luôn hiển thị (ghim)
                          </span>
                        )}
                      </div>

                      <footer className="ac-card-foot">
                        <span className="ac-card-created muted small">
                          <span className="ac-dot" aria-hidden />
                          Sửa {relativeStamp(a.updated_at ?? a.created_at ?? new Date().toISOString(), nowMs)}
                          {status === "SCHEDULED" && a.starts_at
                            ? ` · Mở lúc ${fmtClock(a.starts_at)}`
                            : status === "LIVE" && a.ends_at
                              ? ` · Đóng lúc ${fmtClock(a.ends_at)}`
                              : ""}
                        </span>
                        <div className="ac-card-actions">
                          {status === "LIVE" ? (
                            <Button
                              variant="secondary"
                              onClick={() => toggle.mutate({ id: a.id, active: false })}
                              disabled={toggle.isPending}
                            >
                              <WifiOff size={14} /> Ngừng
                            </Button>
                          ) : (
                            <Button
                              variant="secondary"
                              onClick={() => toggle.mutate({ id: a.id, active: true })}
                              disabled={toggle.isPending || status === "ENDED"}
                              title={
                                status === "ENDED"
                                  ? "Cần chỉnh lại lịch hiển thị trước khi kích hoạt"
                                  : undefined
                              }
                            >
                              <Radio size={14} /> Kích hoạt
                            </Button>
                          )}
                          <Button variant="ghost" onClick={() => startEdit(a)}>
                            <Pencil size={14} /> Sửa
                          </Button>
                          <Button
                            variant="ghost"
                            className="ac-btn-danger"
                            aria-label="Xóa thông báo"
                            onClick={() => void askDelete(a)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </footer>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
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
  const scheduleInvalid = Boolean(
    draft.starts_at && draft.ends_at && draft.ends_at <= draft.starts_at,
  );

  /** Lịch nhanh theo giờ Việt Nam, ghi trực tiếp vào 2 ô ngày-giờ. */
  const applyPreset = (preset: "NOW" | "DAY" | "WEEK" | "SHIFT") => {
    const now = new Date();
    const p = vtNowParts(now);
    if (preset === "NOW") return onChange({ ...draft, starts_at: "", ends_at: "" });
    if (preset === "DAY")
      return onChange({
        ...draft,
        starts_at: `${p.date}T00:00`,
        ends_at: `${vtAddDays(now, 1)}T23:59`,
      });
    if (preset === "WEEK")
      return onChange({
        ...draft,
        starts_at: `${p.date}T00:00`,
        ends_at: `${vtAddDays(now, 6)}T23:59`,
      });
    return onChange({
      ...draft,
      starts_at: `${p.date}T${p.clock}`,
      ends_at: `${p.date}T21:00`,
    });
  };

  const presets: { key: "NOW" | "DAY" | "WEEK" | "SHIFT"; label: string }[] = [
    { key: "NOW", label: "Hiện tại" },
    { key: "DAY", label: "Hôm nay" },
    { key: "WEEK", label: "7 ngày tới" },
    { key: "SHIFT", label: "Ca còn lại" },
  ];
  const activePreset =
    !draft.starts_at && !draft.ends_at
      ? "NOW"
      : draft.starts_at?.endsWith("T00:00") && draft.ends_at === `${vtAddDays(new Date(), 1)}T23:59`
        ? "DAY"
        : draft.starts_at?.endsWith("T00:00") && draft.ends_at === `${vtAddDays(new Date(), 6)}T23:59`
          ? "WEEK"
          : null;

  return (
    <form
      className="stack announcement-form ac-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid && !scheduleInvalid) onSubmit();
      }}
    >
      <div className="ac-form-head">
        <div>
          <h3 id="announcement-form-title">
            {draft.id ? "Cập nhật thông báo" : "Soạn thông báo mới"}
          </h3>
          <p className="muted small">
            Nội dung hiển thị trên thanh thông báo của toàn cửa hàng, đúng theo
            đối tượng và lịch bạn chọn.
          </p>
        </div>
        <Button type="button" variant="ghost" aria-label="Đóng form" onClick={onCancel}>
          <X size={16} />
        </Button>
      </div>

      {/* Thân form cuộn độc lập trong popup; đầu form và nút hành động luôn neo visible. */}
      <div className="ac-form-body">
      <section className="ac-section">
        <span className="ac-section-label">
          <AlignLeft size={12} /> Nội dung
        </span>
        <div className="ac-templates" role="group" aria-label="Mẫu nội dung">
          <span className="ac-templates-lead">
            <LayoutTemplate size={12} /> Mẫu nhanh:
          </span>
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              type="button"
              className="ac-template"
              onClick={() =>
                onChange({
                  ...draft,
                  title: draft.title.trim() || t.title,
                  message: t.message,
                  type: draft.message.trim() ? draft.type : t.type,
                })
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <Field label="Tiêu đề (tùy chọn)">
          <input
            maxLength={120}
            value={draft.title}
            placeholder="Ví dụ: Lịch nghỉ Tết Nguyên đán"
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <Field label="Nội dung *">
          <textarea
            required
            maxLength={500}
            rows={5}
            value={draft.message}
            placeholder="Ví dụ: Cửa hàng nghỉ Tết từ ngày 27/01 đến hết ngày 02/02. Hotline hỗ trợ: 09xx xxx xxx."
            onChange={(e) => set("message", e.target.value)}
          />
          <span className="field-hint ac-counter">
            {draft.message.trim().length}/500 ký tự
            {draft.message.includes("\n") ? " · xuống dòng được giữ nguyên" : ""}
          </span>
        </Field>
      </section>

      <section className="ac-section">
        <span className="ac-section-label">
          <Sparkles size={12} /> Cách thể hiện
        </span>
        <div className="ac-choice-group">
          <span className="ac-choice-label">Mức độ &amp; màu sắc</span>
          <div className="ac-pills" role="group" aria-label="Loại thông báo">
            {TYPES.map((t) => {
              const Icon = TYPE_ICON[t];
              return (
                <button
                  key={t}
                  type="button"
                  className={`ac-pill-option ac-po-${t}${draft.type === t ? " active" : ""}`}
                  aria-pressed={draft.type === t}
                  onClick={() => set("type", t)}
                >
                  <Icon size={14} strokeWidth={1.9} /> {TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ac-choice-group">
          <span className="ac-choice-label">Đối tượng nhận</span>
          <div className="ac-pills" role="group" aria-label="Đối tượng nhận thông báo">
            {AUDIENCES.map((a) => (
              <button
                key={a}
                type="button"
                className={`ac-pill-option ac-neutral${draft.audience === a ? " active" : ""}`}
                aria-pressed={draft.audience === a}
                onClick={() => set("audience", a)}
              >
                <Users size={14} strokeWidth={1.9} /> {AUDIENCE_LABEL[a]}
              </button>
            ))}
          </div>
        </div>
        <div className="ac-choice-group">
          <span className="ac-choice-label">Kiểu chạy trên thanh thông báo</span>
          <div className="ac-pills" role="group" aria-label="Kiểu hiển thị">
            {DISPLAYS.map((d) => {
              const Icon = DISPLAY_ICON[d];
              return (
                <button
                  key={d}
                  type="button"
                  className={`ac-pill-option ac-neutral${draft.display_mode === d ? " active" : ""}`}
                  aria-pressed={draft.display_mode === d}
                  onClick={() => set("display_mode", d)}
                >
                  <Icon size={14} strokeWidth={1.9} /> {DISPLAY_LABEL[d]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ac-switch-row">
          <label className="ac-switch">
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(e) => set("is_active", e.target.checked)}
            />
            <span className="ac-switch-track" aria-hidden />
            <span className="ac-switch-text">
              <strong>Đăng ngay</strong>
              <small>Thông báo vào hàng chờ hiển thị ngay khi lưu</small>
            </span>
          </label>
          <label className="ac-switch">
            <input
              type="checkbox"
              checked={draft.dismissible}
              onChange={(e) => set("dismissible", e.target.checked)}
            />
            <span className="ac-switch-track" aria-hidden />
            <span className="ac-switch-text">
              <strong>Cho phép ẩn</strong>
              <small>Nhân viên tắt được trên thiết bị của họ</small>
            </span>
          </label>
        </div>
      </section>

      <section className="ac-section">
        <span className="ac-section-label">
          <CalendarClock size={12} /> Lịch hiển thị
        </span>
        <div className="ac-pills ac-preset-row" role="group" aria-label="Lịch nhanh">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`ac-pill-option ac-neutral${activePreset === p.key ? " active" : ""}`}
              aria-pressed={activePreset === p.key}
              onClick={() => applyPreset(p.key)}
            >
              <Clock3 size={14} strokeWidth={1.9} /> {p.label}
            </button>
          ))}
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
        <p className="muted small ac-schedule-note">
          {draft.is_active
            ? "Để trống 2 ô trên nghĩa là hiển thị liên tục từ khi lưu."
            : "Đang ở chế độ nháp — cần bật «Đăng ngay» hoặc kích hoạt thủ công sau."}
          {scheduleInvalid ? (
            <span className="danger"> Giờ ngừng phải muộn hơn giờ bắt đầu.</span>
          ) : null}
        </p>
      </section>

      {error ? <ErrorState error={error} /> : null}
      </div>

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Hủy
        </Button>
        <Button type="submit" disabled={saving || invalid || scheduleInvalid}>
          {saving ? "Đang lưu…" : draft.id ? "Cập nhật thông báo" : "Tạo thông báo"}
        </Button>
      </div>
    </form>
  );
}
