/// <reference types="vite/client" />
/**
 * Service Worker tự quản của Cà Rem (chế độ injectManifest của vite-plugin-pwa).
 *
 * LAYER 1 — OFFLINE SHELL (tái lập chính xác phát sinh cũ của generateSW để
 * check-pwa / check-pwa-upgrade / check-pwa-release-skew giữ nguyên hợp đồng):
 *   skipWaiting + clientsClaim (auto-activate khi deploy bản mới), precache
 *   app shell, navigation fallback /index.html, dọn cache lỗi thời, và đúng
 *   ba route CacheFirst: ảnh Tết, WASM Tesseract, language model OCR.
 *   KHÔNG BAO GIỜ cache phản hồi /rest|/auth|/functions — assert trong
 *   scripts/check-pwa*.mjs chốt cứng biên an toàn tài chính này.
 *
 * LAYER 2 — WEB PUSH: nhận payload đã được gate quyền ở DB (xem
 * src/lib/pushContracts.ts), hiển thị notification có tag gom trùng, điều
 * hướng đúng trang nghiệp vụ sau khi mở app — quyền đọc dữ liệu vẫn do RLS
 * quyết định, notification chỉ là tín hiệu, không phải nguồn sự thật.
 */
import { clientsClaim } from "workbox-core";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { parsePushPayload, safeDeepLink } from "./lib/pushContracts";

interface PrecacheManifestEntry {
  url: string;
  revision: string | null;
}

// lib DOM chỉ khai báo ServiceWorkerGlobalScope rỗng (tsconfig dùng lib DOM,
// không trộn lib WebWorker) — khai báo tối thiểu đúng phần SW này chạm tới.
interface SwClientLike {
  url: string;
  focus(): Promise<void>;
  navigate(url: string): Promise<void>;
  postMessage(message: unknown): void;
}
interface SwClientsLike {
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<SwClientLike[]>;
  openWindow(url: string): Promise<SwClientLike | null>;
}
interface SwPushDataLike {
  text(): string | null;
}
interface SwPushEventLike extends Event {
  data: SwPushDataLike | null;
  waitUntil(promise: Promise<unknown>): void;
}
interface SwNotificationLike {
  close(): void;
  data: unknown;
}
interface SwNotificationClickEventLike extends Event {
  notification: SwNotificationLike;
  waitUntil(promise: Promise<unknown>): void;
}
interface SwRegistrationLike {
  showNotification(title: string, options?: Record<string, unknown>): Promise<void>;
}
interface SwPushSubscriptionChangeLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface CaremSwScope {
  skipWaiting(): Promise<void>;
  clients: SwClientsLike;
  registration: SwRegistrationLike;
  location: { origin: string };
  addEventListener(type: "push", listener: (event: SwPushEventLike) => void): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: SwNotificationClickEventLike) => void,
  ): void;
  addEventListener(
    type: "pushsubscriptionchange",
    listener: (event: SwPushSubscriptionChangeLike) => void,
  ): void;
  __WB_MANIFEST: PrecacheManifestEntry[];
}

const scope = self as unknown as CaremSwScope;

// ---- LAYER 1: offline shell (hành vi kế thừa từ generateSW autoUpdate) ----
void scope.skipWaiting();
clientsClaim();

// workbox-build tìm đúng nguyên văn `self.__WB_MANIFEST` trong bundle đã build —
// phải viết đúng literal này (cast chỉ tồn tại ở tầng TypeScript).
precacheAndRoute((self as unknown as CaremSwScope).__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html")));

// Ảnh mở đầu Tết — chỉ thuộc phiên tùy chọn, fetch on-demand rồi giữ offline.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname === "/tet-de-lai.png",
  new CacheFirst({
    cacheName: "tet-cinematic-art",
    plugins: [new ExpirationPlugin({ maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 120 })],
  }),
);

// WASM runtime OCR — không precache cùng shell (>13 MB), CacheFirst sau lần quét đầu.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/tesseract/"),
  new CacheFirst({
    cacheName: "smartcam-ocr-runtime",
    plugins: [new ExpirationPlugin({ maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 60 })],
  }),
);

// Language model Tesseract từ CDN — lần quét OCR đầu tiên online, các lần sau offline.
registerRoute(
  ({ url }) =>
    (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") &&
    url.pathname.includes("traineddata"),
  new CacheFirst({
    cacheName: "smartcam-ocr-language",
    plugins: [new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 180 })],
  }),
);

// ---- LAYER 2: Web Push ----

const NOTIFICATION_ICON = "/icon-192.png";

async function showCaremNotification(raw: string | null): Promise<void> {
  const payload = parsePushPayload(raw);
  if (!payload) {
    // Payload hỏng/lạ: phát tin chung chung, KHÔNG suy diễn nội dung.
    await scope.registration.showNotification("Cà Rem", {
      body: "Bạn có thông báo mới. Mở ứng dụng để xem chi tiết.",
      tag: "carem:generic",
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: { deepLink: "/thong-bao" },
    });
    return;
  }
  await scope.registration.showNotification(payload.title, {
    body: payload.body,
    // tag theo từng delivery: trình duyệt thu gọn notification trùng khi gửi lại.
    tag: `${payload.kind}:${payload.id}`,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data: { deepLink: payload.link },
  });
}

scope.addEventListener("push", (pushEvent) => {
  pushEvent.waitUntil(showCaremNotification(pushEvent.data?.text() ?? null));
});

/** Điều hướng an toàn: chỉ mở/focus cửa sổ Cà Rem, path đã qua safeDeepLink. */
async function focusOrCreateWindow(path: string): Promise<void> {
  const target = new URL(path, scope.location.origin).href;
  const windows = await scope.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if ("focus" in client) {
      await client.focus();
      if (client.url !== target) await client.navigate(target);
      return;
    }
  }
  await scope.clients.openWindow(target);
}

scope.addEventListener("notificationclick", (clickEvent) => {
  clickEvent.notification.close();
  const data = clickEvent.notification.data as { deepLink?: unknown } | undefined;
  clickEvent.waitUntil(focusOrCreateWindow(safeDeepLink(data?.deepLink)));
});

/**
 * Chu kỳ sống subscription: khi trình duyệt/FCM xoay endpoint, SW báo cho
 * window đang mở để client re-subscribe + gọi lại register_push_subscription
 * (RPC idempotent, nhận diện endpoint để chuyển quyền sở hữu thiết bị).
 * Không có window mở thì lần đăng nhập kế tiếp sẽ tự đồng bộ lại.
 */
scope.addEventListener("pushsubscriptionchange", (changeEvent) => {
  changeEvent.waitUntil(
    (async () => {
      const clients = await scope.clients.matchAll({ type: "window" });
      for (const client of clients) client.postMessage({ type: "carem:push-resubscribe" });
    })(),
  );
});
