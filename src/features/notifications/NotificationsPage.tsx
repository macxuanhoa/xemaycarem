import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { BellOff, Eye } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  emptyGroupHint,
  groupNotifications,
  withTodayGroup,
} from "@/lib/notifications";
import { patchNotificationsCache } from "@/lib/notificationsCache";
import { useNotificationsRealtime } from "@/lib/useNotifications";
import { useNow } from "@/lib/useNow";
import {
  NotificationGroupHeading,
  NotificationRow,
} from "@/components/NotificationRow";
import type { NotificationItem } from "@/types";

/**
 * Trang thông báo đầy đủ (/thong-bao).
 *
 * Mở ra từ nút "Xem tất cả thông báo" trên chuông — và chỉ ở đó thôi, nên nút
 * ấy phải luôn hiện. Trang hiển thị toàn bộ lịch sử thông báo của người dùng,
 * có bộ lọc "Tất cả / Chưa đọc", đánh dấu từng dòng hoặc tất cả, và điều hướng
 * sâu khi bấm vào dòng.
 *
 * Dữ liệu: cùng queryKey "notifications" với NotificationBell — invalidate
 * queries từ một bên sẽ tự refresh bên kia qua TanStack Query.
 */

const PAGE_SIZE = 25;
const FALLBACK_POLL_MS = 60_000;
/**
 * Trần mềm cho số dòng giữ trên màn hình. Server đã cắt mỗi trang ở 100 dòng,
 * còn giới hạn này là để bảo vệ trình duyệt: một cửa hàng chạy nhiều năm có thể
 * có hàng chục nghìn dòng, và không có lý do gì chất hết lên DOM chỉ vì người
 * dùng bấm "Tải thêm" vài lần.
 */
const MAX_LOADED_ROWS = 2_000;

const TAB_ALL_ID = "notifications-tab-all";
const TAB_UNREAD_ID = "notifications-tab-unread";
const PANEL_ID = "notifications-tabpanel";

// ─── Page ─────────────────────────────────────────────────────────────────────

export function NotificationsPage() {
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const client = useQueryClient();
  const navigate = useNavigate();

  const [unreadOnly, setUnreadOnly] = useState(false);
  const allTabRef = useRef<HTMLButtonElement>(null);
  const unreadTabRef = useRef<HTMLButtonElement>(null);

  const live = useNotificationsRealtime(userId, client, "notifications-page");
  // Dòng thời gian phải tự già đi khi trang mở sẵn, nếu không "Vừa xong" sẽ
  // còn nguyên đó cả tiếng sau khi tin đã cũ.
  const now = useNow(60_000);

  /**
   * Phân trang thật, tiến từng trang một.
   *
   * Bản cũ tăng `limit` (50 → 100 → 150…) rồi so với mốc 500, trong khi
   * `list_notifications` cắt `least(100, …)`: từ trang 100 trở đi mỗi lần bấm
   * "Tải thêm" là một request y hệt request trước và lịch sử cũ hơn hoàn toàn
   * không tới được. Giờ mỗi trang là `offset` + `limit` cố định, đúng hợp đồng
   * mà server đã hỗ trợ từ bản đang chạy ngoài production.
   */
  const list = useInfiniteQuery({
    queryKey: ["notifications", userId, "page", unreadOnly],
    queryFn: ({ pageParam }) =>
      api.listNotifications({
        limit: PAGE_SIZE,
        offset: pageParam,
        unread_only: unreadOnly || undefined,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      // Trang ngắn hơn PAGE_SIZE nghĩa là đã hết. Thử này đáng tin hơn phép so
      // với `total`, vì `total` đếm MỌI dòng (đã đọc lẫn chưa), nên trong bộ lọc
      // "Chưa đọc" nó là một trần thừa, không phải số dòng bộ lọc còn lại.
      if (lastPage.items.length < PAGE_SIZE) return undefined;
      const fetched = allPages.reduce((sum, page) => sum + page.items.length, 0);
      if (fetched >= MAX_LOADED_ROWS) return undefined;
      if (!unreadOnly && fetched >= lastPage.total) return undefined;
      return fetched;
    },
    enabled: !!userId,
    refetchInterval: live || !userId ? false : FALLBACK_POLL_MS,
  });

  const pages = list.data?.pages;
  const firstPage = pages?.[0];
  // Offset pagination trên bảng đang có realtime insert có thể trả lại một dòng
  // đã hiển thị: tin mới chen vào đầu danh sách giữa hai lần bấm "Tải thêm" đẩy
  // cả danh sách xuống một vị trí. Dedupe theo id để không hiện trùng.
  const items = useMemo(() => {
    if (!pages) return [];
    const seen = new Set<string>();
    const out: NotificationItem[] = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  }, [pages]);

  const serverTotal = firstPage?.total ?? 0;
  const unreadCount = firstPage?.unread_count ?? 0;
  const hasMore = list.hasNextPage;

  const markAll = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => {
      patchNotificationsCache(client, userId, () => true);
      void client.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (error) =>
      toast.error("Không thể đánh dấu đã đọc", {
        description: friendlyError(error),
      }),
  });

  const openItem = (item: NotificationItem) => {
    if (item.read_at === null) {
      // Patch every cached notification query (bell + page variants) optimistically.
      patchNotificationsCache(client, userId, (row) => row.id === item.id);
      void api.markNotificationsRead([item.id]).catch((error: unknown) => {
        toast.error("Không thể đánh dấu đã đọc", {
          description: friendlyError(error),
        });
      });
    }
    if (item.deep_link) navigate(item.deep_link);
  };

  /** Roving tabindex: một tab trong thứ tự Tab, mũi tên trái/phải đổi bộ lọc. */
  const onTabKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const switchTo = (nextUnreadOnly: boolean) => {
      event.preventDefault();
      setUnreadOnly(nextUnreadOnly);
      (nextUnreadOnly ? unreadTabRef : allTabRef).current?.focus();
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        switchTo(false);
        break;
      case "ArrowRight":
      case "ArrowDown":
        switchTo(true);
        break;
      case "Home":
        switchTo(false);
        break;
      case "End":
        switchTo(true);
        break;
    }
  }, []);

  const groups = withTodayGroup(groupNotifications(items, now));

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
            <Eye size={14} aria-hidden="true" />
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
          ref={allTabRef}
          type="button"
          role="tab"
          id={TAB_ALL_ID}
          aria-controls={PANEL_ID}
          aria-selected={!unreadOnly}
          tabIndex={unreadOnly ? -1 : 0}
          onKeyDown={onTabKeyDown}
          className={`notifications-page-tab${!unreadOnly ? " is-active" : ""}`}
          onClick={() => setUnreadOnly(false)}
        >
          Tất cả
          <span className="notifications-page-tab-count">{serverTotal}</span>
        </button>
        <button
          ref={unreadTabRef}
          type="button"
          role="tab"
          id={TAB_UNREAD_ID}
          aria-controls={PANEL_ID}
          aria-selected={unreadOnly}
          tabIndex={unreadOnly ? 0 : -1}
          onKeyDown={onTabKeyDown}
          className={`notifications-page-tab${unreadOnly ? " is-active" : ""}`}
          onClick={() => setUnreadOnly(true)}
        >
          Chưa đọc
          {unreadCount > 0 && (
            <span className="notifications-page-tab-count">{unreadCount}</span>
          )}
        </button>
      </div>

      {/* ── Body ── */}
      <div
        className="notifications-page-body"
        role="tabpanel"
        id={PANEL_ID}
        aria-labelledby={unreadOnly ? TAB_UNREAD_ID : TAB_ALL_ID}
        tabIndex={0}
      >
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
            {groups.map((group) => (
              <div key={group.label} className="notification-page-group">
                <NotificationGroupHeading label={group.label} surface="page" />
                {group.items.length === 0 ? (
                  <p className="notifications-page-group-empty">
                    {emptyGroupHint(unreadOnly)}
                  </p>
                ) : (
                  group.items.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      now={now}
                      surface="page"
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
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
