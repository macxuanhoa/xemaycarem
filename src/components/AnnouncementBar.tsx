import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Info,
  Megaphone,
  OctagonAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { dismissAnnouncement, isDismissed } from "@/lib/announcements";
import { useDialog } from "@/lib/useDialog";
import { Button } from "@/components/ui";
import type { Announcement, AnnouncementType } from "@/types";

const TYPE_ICON: Record<AnnouncementType, typeof Info> = {
  INFO: Info,
  SUCCESS: CheckCircle2,
  WARNING: TriangleAlert,
  CRITICAL: OctagonAlert,
};

function Message({ a }: { a: Announcement }) {
  const text = a.title ? `${a.title}: ${a.message}` : a.message;
  if (a.display_mode === "SCROLLING") {
    return (
      <span className="announcement-track" aria-label={text}>
        <span className="announcement-segment">{text}</span>
        <span className="announcement-segment" aria-hidden="true">
          {text}
        </span>
      </span>
    );
  }
  return <span className="announcement-static-text">{text}</span>;
}

export function AnnouncementBar() {
  const { data } = useQuery({
    queryKey: ["active-announcements"],
    queryFn: () => api.listActiveAnnouncements(),
    // Poll so scheduled announcements appear and disappear without a manual reload.
    refetchInterval: 60_000,
  });
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [showMore, setShowMore] = useState(false);
  const dialogRef = useDialog(showMore, () => setShowMore(false));

  const visible = useMemo(
    () =>
      // A malformed payload (an object instead of a list) must not take the whole
      // application shell down through the error boundary.
      (Array.isArray(data) ? data : []).filter(
        (a) => !dismissedIds.has(a.id) && !isDismissed(a),
      ),
    [data, dismissedIds],
  );

  if (visible.length === 0) return null;
  const primary = visible[0];
  const extra = visible.slice(1);
  const Icon = TYPE_ICON[primary.type];

  const close = (a: Announcement) => {
    dismissAnnouncement(a);
    setDismissedIds((prev) => new Set(prev).add(a.id));
  };

  return (
    <>
      <div
        className={`announcement-bar announcement-${primary.type}`}
        role={primary.type === "CRITICAL" ? "alert" : "status"}
      >
        <span className="announcement-badge" aria-hidden="true">
          <Megaphone size={15} />
        </span>
        <span className={`announcement-icon announcement-icon-${primary.type}`}>
          <Icon size={16} />
        </span>
        <div className="announcement-content" data-mode={primary.display_mode}>
          <Message a={primary} />
        </div>
        {extra.length > 0 && (
          <button
            type="button"
            className="announcement-more"
            onClick={() => setShowMore(true)}
          >
            Xem thêm {extra.length} thông báo
          </button>
        )}
        {primary.dismissible && (
          <button
            type="button"
            className="announcement-close"
            aria-label="Đóng thông báo"
            onClick={() => close(primary)}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {showMore && (
        <div
          className="dialog-backdrop"
          onClick={() => setShowMore(false)}
          role="presentation"
        >
          <div
            className="dialog-panel announcement-list"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Tất cả thông báo"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="announcement-list-header">
              <h2>Thông báo của cửa hàng</h2>
              <Button variant="ghost" onClick={() => setShowMore(false)}>
                <X size={16} />
              </Button>
            </div>
            <div className="announcement-list-body">
              {visible.map((a) => {
                const ItemIcon = TYPE_ICON[a.type];
                return (
                  <div
                    key={a.id}
                    className={`announcement-item announcement-${a.type}`}
                  >
                    <span className={`announcement-icon announcement-icon-${a.type}`}>
                      <ItemIcon size={16} />
                    </span>
                    <div className="announcement-item-text">
                      {a.title && <strong>{a.title}</strong>}
                      <p>{a.message}</p>
                    </div>
                    {a.dismissible && (
                      <button
                        type="button"
                        className="announcement-close"
                        aria-label="Đóng thông báo"
                        onClick={() => close(a)}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
