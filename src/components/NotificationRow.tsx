import { ChevronRight } from "lucide-react";
import {
  ACTION_ICON,
  ACTION_TONE,
  NOTIFICATION_FALLBACK_ICON,
  isFreshGroup,
  relativeTime,
  splitNotificationTitle,
  tidyBody,
} from "@/lib/notifications";
import type { NotificationItem } from "@/types";

/**
 * One row + one group heading for the business bell, shared by the floating
 * panel ("sheet") and the full /thong-bao list ("page").
 *
 * These two surfaces used to keep private copies of the same markup. The copies
 * drifted: the page invented `notification-page-group-dot/-text/-rule` class
 * names that CSS never defined, so its time headers rendered completely
 * unstyled while the bell looked right; the fallback icon differed; the plate
 * chip was duplicated. Only the class names legitimately vary per surface, so
 * they are now a lookup table and everything else is written once.
 */

export type NotificationSurface = "sheet" | "page";

type SurfaceClasses = {
  groupHeading: string;
  groupDot: string;
  groupText: string;
  groupRule: string;
  row: string;
  rowUnread: string;
  icon: (tone: string) => string;
  text: string;
  title: string;
  body: string;
  time: string;
  unreadDot: string | null;
  chevron: string | null;
};

const SURFACE: Record<NotificationSurface, SurfaceClasses> = {
  sheet: {
    groupHeading: "notification-group-label",
    groupDot: "notification-group-dot",
    groupText: "notification-group-label-text",
    groupRule: "notification-group-rule",
    row: "notification-row",
    rowUnread: "unread",
    // The panel tones the icon tile through [data-tone] on the row itself.
    icon: () => "notification-row-icon",
    text: "notification-row-text",
    title: "notification-row-title",
    body: "notification-row-body",
    time: "notification-row-time",
    unreadDot: "notification-row-dot",
    chevron: null,
  },
  page: {
    // Plural on purpose: this is the spelling styles.css ships. The page
    // previously emitted the singular form and lost every rule.
    groupHeading: "notifications-page-group-label",
    groupDot: "notifications-page-group-dot",
    groupText: "notifications-page-group-text",
    groupRule: "notifications-page-group-rule",
    row: "notification-page-row",
    rowUnread: "is-unread",
    icon: (tone) => `notification-page-icon notification-page-icon--${tone}`,
    text: "notification-page-text",
    title: "notification-page-title",
    body: "notification-page-body",
    time: "notification-page-time",
    unreadDot: "notification-page-dot",
    chevron: "notification-page-chevron",
  },
};

export function NotificationGroupHeading({
  label,
  surface,
}: {
  label: string;
  surface: NotificationSurface;
}) {
  const cls = SURFACE[surface];
  const isFresh = isFreshGroup(label);
  return (
    <div className={`${cls.groupHeading}${isFresh ? " is-fresh" : ""}`}>
      {isFresh && <span className={cls.groupDot} aria-hidden="true" />}
      <span className={cls.groupText}>{label}</span>
      <span className={cls.groupRule} aria-hidden="true" />
    </div>
  );
}

export function NotificationRow({
  item,
  now,
  surface,
  onOpen,
}: {
  item: NotificationItem;
  now: Date;
  surface: NotificationSurface;
  onOpen: (item: NotificationItem) => void;
}) {
  const cls = SURFACE[surface];
  const Icon = ACTION_ICON[item.action] ?? NOTIFICATION_FALLBACK_ICON;
  const tone = ACTION_TONE[item.action] ?? "neutral";
  const unread = item.read_at === null;
  // "Thu vào xe 43A1-99999 · 8D4AA1234" → thao tác đứng trước, danh tính xe
  // (tên loại + biển số) gom vào một cụm phát sáng ngay sau đó; số khung đã
  // có trong body nên không lặp lại ở tiêu đề cho dòng tin khỏi gãy đôi.
  const parts = splitNotificationTitle(item.title, item.vehicle_internal_code);
  // Tên loại xe (Honda Wave, Sirius…) từ DB — đi cùng biển số trong cùng cụm
  // danh tính, chứ không đứng trước chiếm chỗ của thao tác như bản cũ.
  const typeName =
    item.vehicle_type && item.vehicle_type !== "Chưa phân loại"
      ? item.vehicle_type
      : null;
  // "chưa có biển · <khung>" là chữ mô tả chứ không phải mặt số, nên không
  // khoác mono cho nó và cũng không cần trợ năng đọc thêm nhãn "Biển số".
  const identityClass =
    parts.identityKind === "phrase"
      ? "notification-vehicle-phrase"
      : "notification-vehicle-plate";
  const identityLabel =
    parts.identityKind === "plate"
      ? `Biển số ${parts.identity}`
      : parts.identityKind === "code"
        ? `Mã nội bộ ${parts.identity}`
        : undefined;
  const navigable = !!item.deep_link;
  // Một dòng đã đọc và không dẫn đi đâu vẫn bấm được thì chỉ để lại một nút
  // chết: người dùng bấm, chẳng có gì xảy ra, và mũi tên báo sai đường.
  // Những dòng như vậy hiển thị tĩnh; dòng chưa đọc vẫn bấm để đánh dấu đã đọc.
  const interactive = navigable || unread;

  const body = (
    <>
      <span className={cls.icon(tone)}>
        <Icon size={16} />
      </span>
      <span className={cls.text}>
        <span className={cls.title}>
          {parts.action}
          {(parts.identity || typeName) && (
            <span className="notification-vehicle">
              {typeName && (
                <span className="notification-vehicle-type">{typeName}</span>
              )}
              {parts.identity && (
                <span
                  className={identityClass}
                  aria-label={identityLabel}
                >
                  {parts.identity}
                </span>
              )}
            </span>
          )}
          {parts.code && (
            <span className="notification-internal-code">
              · {parts.code}
            </span>
          )}
        </span>
        {item.body && (
          <span className={cls.body}>{tidyBody(item.body)}</span>
        )}
        <span className={cls.time}>{relativeTime(item.created_at, now)}</span>
      </span>
      {unread && cls.unreadDot && (
        <span className={cls.unreadDot} aria-hidden="true" />
      )}
      {cls.chevron && navigable && (
        <span className={cls.chevron} aria-hidden="true">
          <ChevronRight size={16} />
        </span>
      )}
    </>
  );

  const rowClass = `${cls.row}${unread ? ` ${cls.rowUnread}` : ""}${
    interactive ? "" : " is-static"
  }`;

  if (!interactive) {
    return (
      <div className={rowClass} data-tone={tone}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={rowClass}
      data-tone={tone}
      onClick={() => onOpen(item)}
    >
      {body}
    </button>
  );
}
