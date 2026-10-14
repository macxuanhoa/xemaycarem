import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, X } from "lucide-react";
import { useNotifications } from "@/lib/useNotifications";
import {
  ACTION_ICON,
  ACTION_TONE,
  badgeLabel,
  groupNotifications,
  relativeTime,
  splitVehicleIdentity,
  tidyBody,
  withTodayGroup,
} from "@/lib/notifications";
import type { NotificationItem } from "@/types";

/**
 * Business activity bell. Fans out from the audit trail (server-side), so this
 * component only renders what list_notifications returns for the signed-in
 * recipient — copy and money gating already happened in the database.
 * The panel is portalled to <body> with fixed positioning so the topbar's
 * z-index stacking context can never clip it.
 */

function Row({
  item,
  now,
  onOpen,
}: {
  item: NotificationItem;
  now: Date;
  onOpen: (item: NotificationItem) => void;
}) {
  const Icon = ACTION_ICON[item.action] ?? Bell;
  const unread = item.read_at === null;
  const timeLabel = relativeTime(item.created_at, now);
  // Bóc biển số ra khỏi tiêu đề để gắn chip nổi bật — nhìn là biết xe nào.
  const { before, plate, after } = splitVehicleIdentity(item.title);
  // Tên loại xe (Honda Wave, Sirius…) từ DB — ưu tiên hiển thị để chủ quán
  // nhận ra xe ngay, thay vì phải đọc biển số hoặc mã nội bộ.
  const typeName =
    item.vehicle_type && item.vehicle_type !== "Chưa phân loại"
      ? item.vehicle_type
      : null;

  return (
    <button
      type="button"
      className={`notification-row${unread ? " unread" : ""}`}
      data-tone={ACTION_TONE[item.action] ?? "neutral"}
      onClick={() => onOpen(item)}
    >
      <span className="notification-row-icon">
        <Icon size={16} />
      </span>
      <span className="notification-row-text">
        <span className="notification-row-title">
          {typeName && (
            <span className="notification-vehicle-type">{typeName}</span>
          )}
          {before}
          {plate && (
            <span className="notification-plate" aria-label={`Biển số ${plate}`}>
              {plate}
            </span>
          )}
          {after}
        </span>
        {item.body && <span className="notification-row-body">{tidyBody(item.body)}</span>}
        <span className="notification-row-time">{timeLabel}</span>
      </span>
      {unread && <span className="notification-row-dot" aria-hidden="true" />}
    </button>
  );
}

export function NotificationBell() {
  const {
    items,
    unreadCount,
    isLoading,
    hasMore,
    markRead,
    markAll,
    markAllPending,
  } = useNotifications();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const prevUnread = useRef(unreadCount);

  // One short ring whenever a genuinely new unread event lands while closed.
  useEffect(() => {
    if (unreadCount > prevUnread.current && !open) {
      setRinging(true);
      const t = window.setTimeout(() => setRinging(false), 900);
      prevUnread.current = unreadCount;
      return () => window.clearTimeout(t);
    }
    prevUnread.current = unreadCount;
  }, [unreadCount, open]);

  // Keep the panel pinned under the bell across resizes/scrolls while open.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({
        top: rect.bottom + 8,
        right: Math.max(12, window.innerWidth - rect.right),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Dismiss on outside click or Escape (popover semantics — no focus trap and
  // no body-scroll lock, unlike modals).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const badge = badgeLabel(unreadCount);

  const openItem = (item: NotificationItem) => {
    if (item.read_at === null) void markRead(item.id);
    setOpen(false);
    if (item.deep_link) navigate(item.deep_link);
  };

  return (
    <div className="notification-bell-wrap">
      <button
        ref={buttonRef}
        type="button"
        className={`icon-button header-notification-toggle${ringing ? " ringing" : ""}`}
        aria-label={
          unreadCount > 0 ? `Thông báo, ${unreadCount} chưa đọc` : "Thông báo"
        }
        aria-expanded={open}
        title="Thông báo"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={18} />
        {badge && (
          <span className="notification-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>

      {open &&
        anchor &&
        createPortal(
          <>
            <button
              type="button"
              className="notification-overlay"
              aria-label="Đóng thông báo"
              tabIndex={-1}
              onClick={() => setOpen(false)}
            />
            <div
              ref={panelRef}
              className="notification-panel"
              role="dialog"
              aria-label="Thông báo"
              style={{ top: anchor.top, right: anchor.right }}
            >
              <span className="notification-sheet-handle" aria-hidden="true" />
              <div className="notification-panel-header">
                <h2>
                  Thông báo
                  {unreadCount > 0 && (
                    <span className="notification-panel-count">
                      {unreadCount} mới
                    </span>
                  )}
                </h2>
                <div className="notification-panel-actions">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      className="notification-mark-all"
                      disabled={markAllPending}
                      onClick={() => markAll()}
                    >
                      Đánh dấu tất cả đã đọc
                    </button>
                  )}
                  <button
                    type="button"
                    className="notification-panel-close"
                    aria-label="Đóng thông báo"
                    onClick={() => setOpen(false)}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="notification-panel-body">
                {isLoading ? (
                  <p className="notification-empty">Đang tải…</p>
                ) : items.length === 0 ? (
                  <div className="notification-empty-state">
                    <span className="notification-empty-icon" aria-hidden="true">
                      <BellOff size={20} />
                    </span>
                    <p className="notification-empty">Chưa có thông báo nào.</p>
                    <small>
                      Mỗi khi có thu xe, bán xe hoặc thanh toán mới, bạn sẽ thấy ở đây.
                    </small>
                  </div>
                ) : (
                  withTodayGroup(groupNotifications(items)).map((group) => {
                    const isFresh =
                      group.label === "Vừa xong" ||
                      group.label === "Hôm nay" ||
                      group.label === "Hôm qua";

                    return (
                      <div key={group.label} className="notification-group">
                        <div
                          className={`notification-group-label${isFresh ? " is-fresh" : ""}`}
                          data-group={group.label}
                        >
                          {isFresh && (
                            <span className="notification-group-dot" aria-hidden="true" />
                          )}
                          <span className="notification-group-label-text">{group.label}</span>
                          <span className="notification-group-rule" aria-hidden="true" />
                        </div>
                        {group.items.length === 0 ? (
                          <p className="notification-group-empty">
                            Hôm nay chưa có thông báo mới.
                          </p>
                        ) : (
                          group.items.map((item) => (
                            <Row key={item.id} item={item} now={new Date()} onOpen={openItem} />
                          ))
                        )}
                      </div>
                    );
                  })
                )}
                {hasMore && (
                  <button
                    type="button"
                    className="notification-load-more"
                    onClick={() => { setOpen(false); navigate("/thong-bao"); }}
                  >
                    Xem tất cả thông báo
                  </button>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
