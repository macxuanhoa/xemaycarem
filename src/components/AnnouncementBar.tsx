import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Info,
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
  // Tiêu đề đậm, nội dung thường: mắt nắm được ý chính ngay cả khi dòng
  // chữ chỉ dài vừa vặn một hàng.
  const body = a.title ? (
    <>
      <strong className="announcement-title">{a.title}</strong>
      {": "}
      {a.message}
    </>
  ) : (
    a.message
  );
  if (a.display_mode === "SCROLLING") {
    // Một hàng dài, người đọc tự kéo — không có dải chữ tự chạy mãi.
    // Bản cũ dùng keyframes lặp vô hạn: vi phạm chuẩn giao diện Cà Rem (không
    // animation chạy nền), hao pin tablet showroom, và về mặt accessibility là
    // một nội dung chuyển động mà người dùng không dừng được (WCAG 2.2.2) —
    // phải kèm nút pause hoặc đóng băng theo prefers-reduced-motion. Đứng yên
    // thì cả hai vấn đề biến mất: hover/focus không còn là chỗ chữ chạy đi.
    // Bốc mờ hai biên của .announcement-content báo rằng còn chữ phía ngoài.
    return (
      <span
        className="announcement-scroll"
        role="region"
        aria-label="Nội dung thông báo — kéo ngang để đọc hết"
        tabIndex={0}
      >
        {body}
      </span>
    );
  }
  return <span className="announcement-static-text">{body}</span>;
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
