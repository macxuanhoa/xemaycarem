import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Bell,
  BellOff,
  Bike,
  Check,
  CircleSlash,
  Inbox,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { useNotifications } from "@/lib/useNotifications";
import { badgeLabel, groupNotifications, relativeTime, withTodayGroup } from "@/lib/notifications";
import type { NotificationAction, NotificationItem } from "@/types";

/**
 * Business activity bell. Fans out from the audit trail (server-side), so this
 * component only renders what list_notifications returns for the signed-in
 * recipient — copy and money gating already happened in the database.
 * The panel is portalled to <body> with fixed positioning so the topbar's
 * z-index stacking context can never clip it.
 */

const ACTION_ICON: Record<NotificationAction, typeof Bell> = {
  CREATE_ACQUISITION: ArrowDownLeft,
  CANCEL_ACQUISITION: CircleSlash,
  CREATE_SALE: ArrowUpRight,
  CANCEL_SALE: CircleSlash,
  CREATE_PAYMENT: Banknote,
  VOID_PAYMENT: Undo2,
  CREATE_VEHICLE: Bike,
  UPDATE_VEHICLE: Bike,
  REQUEST_DELETE_VEHICLE: Inbox,
  REQUEST_SALE_BELOW_COST: Send,
  APPROVE_SALE_BELOW_COST: Check,
  REJECT_SALE_BELOW_COST: CircleSlash,
  CANCEL_SALE_BELOW_COST: Undo2,
};

// Facebook-style buckets: acquisitions and payments read as gains, cancels as
// warnings, everything else neutral.
const ACTION_TONE: Record<NotificationAction, "success" | "warning" | "neutral"> = {
  CREATE_ACQUISITION: "success",
  CREATE_SALE: "success",
  CREATE_PAYMENT: "success",
  CANCEL_ACQUISITION: "warning",
  CANCEL_SALE: "warning",
  VOID_PAYMENT: "warning",
  CREATE_VEHICLE: "neutral",
  UPDATE_VEHICLE: "neutral",
  REQUEST_DELETE_VEHICLE: "warning",
  REQUEST_SALE_BELOW_COST: "warning",
  APPROVE_SALE_BELOW_COST: "success",
  REJECT_SALE_BELOW_COST: "warning",
  CANCEL_SALE_BELOW_COST: "neutral",
};

// Keep a trailing currency unit from being orphaned on its own line when the
// body wraps on narrow phones — glue "…000 đ" together with a non-breaking
// space so the amount and its unit always travel as one token.
function tidyBody(text: string) {
  return text.replace(/(\d)\s+([\u20AB\u0111])/g, "$1\u00A0$2");
}

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
  return (
    <button
      type="button"
      className={`notification-row${unread ? " unread" : ""}`}
      data-tone={ACTION_TONE[item.action] ?? "neutral"}
      onClick={() => onOpen(item)}
    >
      <span className="notification-row-icon">
        <Icon size={15} />
      </span>
      <span className="notification-row-text">
        <span className="notification-row-title">{item.title}</span>
        {item.body && <span className="notification-row-body">{tidyBody(item.body)}</span>}
        <span className="notification-row-time">{relativeTime(item.created_at, now)}</span>
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
    loadMore,
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
                  withTodayGroup(groupNotifications(items)).map((group) => (
                    <div key={group.label} className="notification-group">
                      <div className="notification-group-label">{group.label}</div>
                      {group.items.length === 0 ? (
                        <p className="notification-group-empty">
                          Chưa có thông báo nào hôm nay.
                        </p>
                      ) : (
                        group.items.map((item) => (
                          <Row key={item.id} item={item} now={new Date()} onOpen={openItem} />
                        ))
                      )}
                    </div>
                  ))
                )}
                {hasMore && (
                  <button type="button" className="notification-load-more" onClick={loadMore}>
                    Xem thêm thông báo cũ
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
