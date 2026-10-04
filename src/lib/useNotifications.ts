import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { api } from "./api";
import { supabase } from "./supabase";
import { toast } from "./toast";
import { friendlyError } from "./errors";
import { useAuth } from "@/features/auth/AuthProvider";
import type { NotificationItem, NotificationList } from "@/types";

/**
 * Business bell data layer. Primary delivery is Supabase Realtime on the
 * notifications table (RLS-scoped to the signed-in recipient); when the socket
 * is not joined the same query degrades to a 60-second unread poll, mirroring
 * the AnnouncementBar pattern. All rows are already money-gated server-side.
 */

const PAGE_SIZE = 25;
const MAX_ROWS = 100;
const FALLBACK_POLL_MS = 60_000;

export function useNotifications() {
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const client = useQueryClient();
  const [pages, setPages] = useState(1);
  const [live, setLive] = useState(false);

  const limit = Math.min(pages * PAGE_SIZE, MAX_ROWS);
  const list = useQuery({
    queryKey: ["notifications", userId, limit],
    queryFn: () => api.listNotifications({ limit }),
    enabled: !!userId,
    // Realtime covers inserts while the socket is joined; poll only as fallback.
    refetchInterval: live || !userId ? false : FALLBACK_POLL_MS,
  });
  const data = list.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const unreadCount = data?.unread_count ?? 0;

  useEffect(() => setPages(1), [userId]);

  useEffect(() => {
    const sb = supabase;
    if (!userId || !sb) return;
    const refresh = () =>
      void client.invalidateQueries({ queryKey: ["notifications"] });
    const channel: RealtimeChannel = sb
      .channel(`notifications:${userId}`)
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

  /** Patch the cached envelope optimistically so the badge feels instant. */
  const patchCache = useCallback(
    (readIds: (item: NotificationItem) => boolean) => {
      client.setQueriesData<NotificationList>(
        { queryKey: ["notifications", userId] },
        (old) => {
          if (!old) return old;
          let marked = 0;
          const next = old.items.map((item) => {
            if (item.read_at === null && readIds(item)) {
              marked += 1;
              return { ...item, read_at: new Date().toISOString() };
            }
            return item;
          });
          return {
            ...old,
            items: next,
            unread_count: Math.max(0, old.unread_count - marked),
          };
        },
      );
    },
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
    hasMore: items.length < total && limit < MAX_ROWS,
    loadMore: () => setPages((p) => p + 1),
    markRead,
    markAll: () => markAll.mutate(),
    markAllPending: markAll.isPending,
  };
}
