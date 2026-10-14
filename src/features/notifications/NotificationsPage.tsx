import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { BellOff, Check, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  ACTION_ICON,
  ACTION_TONE,
  groupNotifications,
  relativeTime,
  splitVehicleIdentity,
  tidyBody,
  withTodayGroup,
} from "@/lib/notifications";
import type { NotificationItem, NotificationList } from "@/types";

/**
 * Trang thông báo đầy đủ (/thong-bao).
 *
 * Mở ra từ nút "Xem tất cả" trên chuông. Hiển thị toàn bộ lịch sử thông báo
 * của người dùng, có bộ lọc "Tất cả / Chưa đọc", đánh dấu từng dòng hoặc tất cả,
 * và điều hướng sâu khi bấm vào dòng.
 *
 * Dữ liệu: cùng queryKey "notifications" với NotificationBell — invalidate
 * queries từ một bên sẽ tự refresh bên kia qua TanStack Query.
 */

const PAGE_SIZE = 50;
const FALLBACK_POLL_MS = 60_000;

// ─── Page row ─────────────────────────────────────────────────────────────────

function PageRow({
  item,
  now,
  onOpen,
}: {
  item: NotificationItem;
  now: Date;
  onOpen: (item: NotificationItem) => void;
}) {
  const Icon = ACTION_ICON[item.action] ?? BellOff;
  const tone = ACTION_TONE[item.action] ?? "neutral";
  const unread = item.read_at === null;
  const { before, plate, after } = splitVehicleIdentity(item.title);
  const typeName =
    item.vehicle_type && item.vehicle_type !== "Chưa phân loại"
      ? item.vehicle_type
      : null;

  return (
    <button
      type="button"
      className={`notification-page-row${unread ? " is-unread" : ""}`}
      data-tone={tone}
      onClick={() => onOpen(item)}
    >
      <span className={`notification-page-icon notification-page-icon--${tone}`}>
        <Icon size={16} />
      </span>

      <span className="notification-page-text">
        <span className="notification-page-title">
          {typeName && (
            <span className="notification-vehicle-type">{typeName}</span>
          )}
          {before}
          {plate && (
            <span
              className="notification-plate"
              aria-label={`Biển số ${plate}`}
            >
              {plate}
            </span>
          )}
          {after}
        </span>
        {item.body && (
          <span className="notification-page-body">{tidyBody(item.body)}</span>
        )}
        <span className="notification-page-time">
          {relativeTime(item.created_at, now)}
        </span>
      </span>

      {unread && <span className="notification-page-dot" aria-hidden="true" />}
      <ChevronRight
        size={16}
        className="notification-page-chevron"
        aria-hidden="true"
      />
    </button>
  );
}

// ─── Group time label ─────────────────────────────────────────────────────────

function GroupLabel({ label }: { label: string }) {
  const isFresh =
    label === "Vừa xong" || label === "Hôm nay" || label === "Hôm qua";
  return (
    <div
      className={`notification-page-group-label${isFresh ? " is-fresh" : ""}`}
    >
      {isFresh && (
        <span className="notification-page-group-dot" aria-hidden="true" />
      )}
      <span className="notification-page-group-text">{label}</span>
      <span className="notification-page-group-rule" aria-hidden="true" />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function NotificationsPage() {
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const client = useQueryClient();
  const navigate = useNavigate();

  const [fetchLimit, setFetchLimit] = useState(PAGE_SIZE);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [live, setLive] = useState(false);

  const list = useQuery({
    queryKey: ["notifications", userId, fetchLimit, unreadOnly],
    queryFn: () =>
      api.listNotifications({
        limit: fetchLimit,
        unread_only: unreadOnly || undefined,
      }),
    enabled: !!userId,
    refetchInterval: live || !userId ? false : FALLBACK_POLL_MS,
  });

  const items = list.data?.items ?? [];
  const serverTotal = list.data?.total ?? 0;
  const unreadCount = list.data?.unread_count ?? 0;
  // In unreadOnly mode serverTotal still reports the all-time total;
  // compare fetched items to that to know if there are more rows to pull.
  const hasMore = items.length >= fetchLimit && fetchLimit < 500;

  // Realtime — subscribe so both this page and the bell stay in sync.
  useEffect(() => {
    const sb = supabase;
    if (!userId || !sb) return;
    const refresh = () =>
      void client.invalidateQueries({ queryKey: ["notifications"] });
    const channel: RealtimeChannel = sb
      .channel(`notifications-page:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        refresh,
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    const onOnline = () => refresh();
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      void sb.removeChannel(channel);
      setLive(false);
    };
  }, [userId, client]);

  const markRead = (id: string) => {
    void api.markNotificationsRead([id]).catch((error: unknown) => {
      toast.error("Không thể đánh dấu đã đọc", {
        description: friendlyError(error),
      });
    });
  };

  const markAll = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["notifications"] }),
    onError: (error) =>
      toast.error("Không thể đánh dấu đã đọc", {
        description: friendlyError(error),
      }),
  });

  const openItem = (item: NotificationItem) => {
    if (item.read_at === null) {
      // Patch every cached notification query (bell + page variants) optimistically.
      client.setQueriesData<NotificationList>(
        { queryKey: ["notifications", userId] },
        (old) => {
          if (!old) return old;
          const alreadyMarked = old.items.some(
            (i) => i.id === item.id && i.read_at !== null,
          );
          if (alreadyMarked) return old;
          return {
            ...old,
            items: old.items.map((i) =>
              i.id === item.id && i.read_at === null
                ? { ...i, read_at: new Date().toISOString() }
                : i,
            ),
            unread_count: Math.max(0, old.unread_count - 1),
          };
        },
      );
      markRead(item.id);
    }
    if (item.deep_link) navigate(item.deep_link);
  };

  const now = new Date();

  return (
    <div className="notifications-page">
      {/* ── Header ── */}
      <div className="notifications-page-header">
        <div className="notifications-page-heading">
          <h1>Thông báo</h1>
          {unreadCount > 0 && (
            <span className="notifications-page-badge">
              {unreadCount} chưa đọc
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            className="notifications-mark-all-btn"
            disabled={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            <Check size={14} />
            Đánh dấu tất cả đã đọc
          </button>
        )}
      </div>

      {/* ── Filter tabs ── */}
      <div
        className="notifications-page-tabs"
        role="tablist"
        aria-label="Lọc thông báo"
      >
        <button
          type="button"
          role="tab"
          aria-selected={!unreadOnly}
          className={`notifications-page-tab${!unreadOnly ? " is-active" : ""}`}
          onClick={() => setUnreadOnly(false)}
        >
          Tất cả
          <span className="notifications-page-tab-count">{serverTotal}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={unreadOnly}
          className={`notifications-page-tab${unreadOnly ? " is-active" : ""}`}
          onClick={() => setUnreadOnly(true)}
        >
          Chưa đọc
          {unreadCount > 0 && (
            <span className="notifications-page-tab-count">
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* ── Body ── */}
      <div className="notifications-page-body">
        {list.isLoading ? (
          <p className="notifications-page-loading">Đang tải…</p>
        ) : items.length === 0 ? (
          <div className="notifications-page-empty">
            <BellOff size={36} aria-hidden="true" />
            <p>
              {unreadOnly
                ? "Không còn thông báo chưa đọc."
                : "Chưa có thông báo nào."}
            </p>
            {!unreadOnly && (
              <small>
                Mỗi khi có thu xe, bán xe hoặc thanh toán mới, bạn sẽ thấy ở
                đây.
              </small>
            )}
          </div>
        ) : (
          <>
            {withTodayGroup(groupNotifications(items, now)).map((group) => (
              <div key={group.label} className="notification-page-group">
                <GroupLabel label={group.label} />
                {group.items.length === 0 ? (
                  <p className="notifications-page-group-empty">
                    Hôm nay chưa có thông báo mới.
                  </p>
                ) : (
                  group.items.map((item) => (
                    <PageRow
                      key={item.id}
                      item={item}
                      now={now}
                      onOpen={openItem}
                    />
                  ))
                )}
              </div>
            ))}
            {hasMore && (
              <button
                type="button"
                className="notifications-page-load-more"
                onClick={() => setFetchLimit((l) => l + PAGE_SIZE)}
              >
                Tải thêm
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
