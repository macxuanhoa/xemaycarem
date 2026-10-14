import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, X } from "lucide-react";
import { useNotifications } from "@/lib/useNotifications";
import {
  NotificationGroupHeading,
  NotificationRow,
} from "@/components/NotificationRow";
import {
  badgeLabel,
  emptyGroupHint,
  groupNotifications,
  withTodayGroup,
} from "@/lib/notifications";
import { useNow } from "@/lib/useNow";
import type { NotificationItem } from "@/types";

/**
 * Business activity bell. Fans out from the audit trail (server-side), so this
 * component only renders what list_notifications returns for the signed-in
 * recipient — copy and money gating already happened in the database.
 * The panel is portalled to <body> with fixed positioning so the topbar's
 * z-index stacking context can never clip it.
 *
 * Rows and time headings come from the shared NotificationRow components so the
 * panel and /thong-bao cannot drift apart.
 */

export function NotificationBell() {
  const {
    items,
    unreadCount,
    isLoading,
    markRead,
    markAll,
    markAllPending,
  } = useNotifications();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const prevUnread = useRef(unreadCount);
  const restoreFocusOnClose = useRef(false);
  // Relative labels are computed against `now`, so an unattended panel would
  // keep reading "Vừa xong" an hour after a row arrived. The timer runs only
  // while the panel is actually on screen.
  const now = useNow(60_000, open);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      top: rect.bottom + 8,
      right: Math.max(12, window.innerWidth - rect.right),
    });
  }, []);

  /**
   * Dismiss the panel. `restoreFocus` is false when a row navigated away: the
   * destination screen owns focus then, and pulling it back to the bell would
   * strand a keyboard user on the control they just left.
   */
  const dismiss = useCallback((restoreFocus: boolean) => {
    restoreFocusOnClose.current = restoreFocus;
    setOpen(false);
  }, []);

  // Measured before the state flip, so the portal's first paint already has a
  // position — an `anchor === null` first render would leave the panel
  // unmounted while the focus effect below runs against it.
  const openPanel = () => {
    place();
    setAnnouncement("");
    setOpen(true);
  };

  // One short ring, plus a screen-reader announcement, whenever a genuinely new
  // unread event lands while the panel is closed.
  useEffect(() => {
    const arrived = unreadCount - prevUnread.current;
    prevUnread.current = unreadCount;
    if (arrived <= 0 || open) return;
    setRinging(true);
    setAnnouncement(
      `${arrived} thông báo mới. Còn ${unreadCount} chưa đọc.`,
    );
    const t = window.setTimeout(() => setRinging(false), 900);
    return () => window.clearTimeout(t);
  }, [unreadCount, open]);

  // Keep the panel pinned under the bell across resizes/scrolls while open.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  // Non-modal dialog focus management: the panel is labelled, so it takes
  // focus itself and Tab starts inside it; on dismissal focus returns to the
  // bell. Without this, Tab after opening resumes at the top of the document
  // and closing leaves focus on <body>, which reads as "the app lost its place".
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
      return;
    }
    if (restoreFocusOnClose.current) {
      restoreFocusOnClose.current = false;
      buttonRef.current?.focus();
    }
  }, [open]);

  // Dismiss on outside click or Escape (popover semantics — no focus trap and
  // no body-scroll lock, unlike modals).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      dismiss(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismiss(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, dismiss]);

  const badge = badgeLabel(unreadCount);

  const openItem = (item: NotificationItem) => {
    if (item.read_at === null) void markRead(item.id);
    if (item.deep_link) {
      dismiss(false);
      navigate(item.deep_link);
      return;
    }
    dismiss(true);
  };

  const openArchive = () => {
    dismiss(false);
    navigate("/thong-bao");
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
        onClick={() => (open ? dismiss(true) : openPanel())}
      >
        <Bell size={18} />
        {badge && (
          <span className="notification-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>

      {/* The badge and the ring are visual only, so this is how a screen reader
          learns that something arrived. It sits outside the portal on purpose:
          the panel is closed in exactly the case where nobody is looking. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      {open &&
        anchor &&
        createPortal(
          <>
            <button
              type="button"
              className="notification-overlay"
              aria-label="Đóng thông báo"
              tabIndex={-1}
              onClick={() => dismiss(true)}
            />
            <div
              ref={panelRef}
              className="notification-panel"
              role="dialog"
              aria-label="Thông báo"
              tabIndex={-1}
              style={{ top: anchor.top, right: anchor.right }}
            >
              <div className="notification-panel-header">
                <h2>
                  Thông báo
                  {unreadCount > 0 && (
                    <span className="notification-panel-count">
                      {unreadCount} chưa đọc
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
                    onClick={() => dismiss(true)}
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
                  withTodayGroup(groupNotifications(items, now)).map((group) => (
                    <div key={group.label} className="notification-group">
                      <NotificationGroupHeading
                        label={group.label}
                        surface="sheet"
                      />
                      {group.items.length === 0 ? (
                        <p className="notification-group-empty">
                          {emptyGroupHint(false)}
                        </p>
                      ) : (
                        group.items.map((item) => (
                          <NotificationRow
                            key={item.id}
                            item={item}
                            now={now}
                            surface="sheet"
                            onOpen={openItem}
                          />
                        ))
                      )}
                    </div>
                  ))
                )}
                {/* Unconditional. This link used to depend on `hasMore`, which
                    was false whenever the store had no more rows than the panel
                    already showed — so the /thong-bao archive (filters, unread
                    tab, mark-all) simply had no way in for a small store. */}
                {!isLoading && (
                  <button
                    type="button"
                    className="notification-load-more"
                    onClick={openArchive}
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
