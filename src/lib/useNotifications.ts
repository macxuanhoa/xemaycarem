import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { api } from "./api";
import { supabase } from "./supabase";
import { toast } from "./toast";
import { friendlyError } from "./errors";
import { useAuth } from "@/features/auth/AuthProvider";
import { patchNotificationsCache } from "./notificationsCache";
import type { NotificationItem } from "@/types";

/**
 * Business bell data layer. Primary delivery is Supabase Realtime on the
 * notifications table (RLS-scoped to the signed-in recipient); when the socket
 * is not joined the same query degrades to a 60-second unread poll, mirroring
 * the AnnouncementBar pattern. All rows are already money-gated server-side.
 */

/**
 * Rows the floating panel renders. The panel is a preview, not the archive: it
 * deliberately stops short of the server's 100-row page cap and hands the rest
 * of the history to /thong-bao. There used to be a `pages`/`loadMore` multiplier
 * here that nothing ever called — the bell's only "load more" affordance
 * navigates instead — while `hasMore` decided whether that navigation was
 * reachable at all. Both are gone; the link is unconditional.
 */
const BELL_ROWS = 25;
const FALLBACK_POLL_MS = 60_000;

/**
 * Live sync shared by the bell and /thong-bao.
 *
 * Both surfaces read the same `notifications` rows and must agree instantly when
 * one of them marks a row read or when a new row lands while the other is open,
 * so the socket subscription + "back online" refresh lives here once instead of
 * being copied into each surface.
 */
export function useNotificationsRealtime(
  userId: string | null,
  client: QueryClient,
  channelName: string,
): boolean {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const sb = supabase;
    if (!userId || !sb) return;
    const refresh = () =>
      void client.invalidateQueries({ queryKey: ["notifications"] });
    const channel: RealtimeChannel = sb
      .channel(`${channelName}:${userId}`)
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
  }, [userId, client, channelName]);

  return live;
}

export function useNotifications() {
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const client = useQueryClient();

  // Realtime covers inserts while the socket is joined; poll only as fallback.
  const live = useNotificationsRealtime(userId, client, "notifications");

  const list = useQuery({
    queryKey: ["notifications", userId, BELL_ROWS],
    queryFn: () => api.listNotifications({ limit: BELL_ROWS }),
    enabled: !!userId,
    refetchInterval: live || !userId ? false : FALLBACK_POLL_MS,
  });

  const data = list.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const unreadCount = data?.unread_count ?? 0;

  /** Patch the cached envelope optimistically so the badge feels instant. */
  const patchCache = useCallback(
    (readIds: (item: NotificationItem) => boolean) =>
      patchNotificationsCache(client, userId, readIds),
    [client, userId],
  );

  const markRead = useCallback(
    async (id: string) => {
      patchCache((item) => item.id === id);
      try {
        await api.markNotificationsRead([id]);
      } catch (error) {
        toast.error("Không thể đánh dấu đã đọc", { description: friendlyError(error) });
      } finally {
        void client.invalidateQueries({ queryKey: ["notifications"] });
      }
    },
    [patchCache, client],
  );

  const markAll = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: (count) => {
      if (count > 0) patchCache(() => true);
      void client.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (error) =>
      toast.error("Không thể đánh dấu đã đọc", { description: friendlyError(error) }),
  });

  return {
    items,
    total,
    unreadCount,
    isLoading: list.isLoading,
    isFetching: list.isFetching,
    live,
    markRead,
    markAll: () => markAll.mutate(),
    markAllPending: markAll.isPending,
  };
}
