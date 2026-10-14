/**
 * push.ts — phía client của Web Push Cà Rem (Phase 2.1).
 *
 * Quy tắc vàng:
 * - KHÔNG chủ động xin quyền Notification khi mở app; chỉ gọi
 *   enablePush() từ một nút rõ ràng của người dùng.
 * - Khóa subscription (endpoint/p256dh/auth) là bearer bí mật: chúng đi thẳng
 *   RPC register_push_subscription và không bao giờ được lưu lại phía client
 *   ngoài localStorage id hàng của chính máy đó để thu hồi.
 * - Push chỉ là kênh thông báo. Mọi quyết định tiền nong vẫn ở server; mất
 *   push không ảnh hưởng luồng đối soát thanh toán.
 */
import { supabase } from "./supabase";
import { api } from "./api";
import { AppError } from "./errors";

const SUB_ID_KEY = "carem:push:sub-id";

function readStoredSubscriptionId(): string | null {
  try {
    return localStorage.getItem(SUB_ID_KEY);
  } catch {
    return null;
  }
}
function writeStoredSubscriptionId(id: string | null) {
  try {
    if (id) localStorage.setItem(SUB_ID_KEY, id);
    else localStorage.removeItem(SUB_ID_KEY);
  } catch {
    /* chế độ riêng tư của trình duyệt: không chặn luồng chính */
  }
}

export interface PushSupportInfo {
  supported: boolean;
  /** 'ios-install' → iPhone/iPad nhưng chưa chạy dạng PWA độc lập. */
  blocker: null | "insecure-context" | "ios-install" | "unsupported-browser" | "no-vapid";
}

/** Điều kiện iOS: Web Push chỉ tồn tại trong PWA đã "Thêm vào màn hình chính", iOS 16.4+. */
export function pushSupportInfo(): PushSupportInfo {
  const insecure = !window.isSecureContext;
  const noVapid = !import.meta.env.VITE_VAPID_PUBLIC_KEY;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  if (insecure) return { supported: false, blocker: "insecure-context" };
  if (noVapid) return { supported: false, blocker: "no-vapid" };
  if (isIos && !standalone) return { supported: false, blocker: "ios-install" };
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!hasApis) return { supported: false, blocker: "unsupported-browser" };
  return { supported: true, blocker: null };
}

export type PermissionState = NotificationPermission | "unsupported";
export function notificationPermission(): PermissionState {
  if (!pushSupportInfo().supported) return "unsupported";
  return Notification.permission;
}

function urlBase64ToApplicationKey(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const bytes = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) bytes[i] = rawData.charCodeAt(i);
  return bytes;
}

/** Nhãn máy dễ đọc cho danh sách thiết bị — suy đoán thận trọng từ UA. */
function deviceLabelFromUa(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Trình duyệt";
  const os = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return [browser, os].filter(Boolean).join(" trên ") || "Thiết bị";
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new AppError("Trình duyệt này không hỗ trợ Service Worker.");
  return await navigator.serviceWorker.ready;
}

/** Đăng ký hàng lên server (idempotent theo endpoint) và nhớ id để thu hồi. */
async function registerWithServer(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  const keys = json?.keys;
  if (!json?.endpoint || !keys?.p256dh || !keys?.auth) {
    throw new AppError("Không đọc được thông tin đăng ký từ trình duyệt.");
  }
  const id = await api.call<string>("register_push_subscription", {
    p_endpoint: json.endpoint,
    p_p256dh: keys.p256dh,
    p_auth: keys.auth,
    p_label: deviceLabelFromUa(),
  });
  if (typeof id === "string") writeStoredSubscriptionId(id);
}

/**
 * Bật push cho thiết bị này — CHỈ được gọi từ thao tác rõ ràng của người dùng
 * (nút trong Cài đặt). Xin quyền hệ thống xảy ra đúng một lần theo ý người bấm.
 */
export async function enablePush(): Promise<void> {
  const support = pushSupportInfo();
  if (!support.supported) {
    if (support.blocker === "ios-install") {
      throw new AppError("Với iPhone/iPad, hãy mở Cà Rem bằng Safari → Thêm vào màn hình chính, rồi bật thông báo trong ứng dụng đã cài.");
    }
    if (support.blocker === "no-vapid") {
      throw new AppError("Máy chủ chưa cấu hình khóa thông báo (VAPID). Hãy báo chủ cửa hàng.");
    }
    throw new AppError("Trình duyệt này không hỗ trợ thông báo đẩy.");
  }
  if (Notification.permission === "denied") {
    throw new AppError("Trình duyệt đang chặn thông báo cho trang này. Hãy mở Cài đặt trang web → Thông báo → Cho phép, rồi thử lại.");
  }
  if (Notification.permission !== "granted") {
    const result = await Notification.requestPermission();
    if (result !== "granted") throw new AppError("Bạn chưa cho phép hiển thị thông báo.");
  }
  const registration = await readyRegistration();
  const applicationKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToApplicationKey(applicationKey),
    });
  }
  await registerWithServer(subscription);
  await api.call("set_push_enabled", { p_enabled: true });
}

/** Tắt push riêng thiết bị này: gỡ đăng ký trình duyệt + xóa hàng trên server. */
export async function disableThisDevice(): Promise<void> {
  const registration = await readyRegistration().catch(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  const storedId = readStoredSubscriptionId();
  if (storedId) {
    // RPC cần phiên đang đăng nhập; lỗi mạng không được chặn bước unsubscribe.
    await api.call("unregister_push_subscription", { p_id: storedId }).catch(() => null);
    writeStoredSubscriptionId(null);
  }
  await subscription?.unsubscribe().catch(() => false);
}

/** Thu hồi thiết bị bất kỳ trong danh sách (theo id RPC list trả về). */
export async function revokeDevice(id: string): Promise<boolean> {
  return await api.call<boolean>("unregister_push_subscription", { p_id: id });
}

/** Bật/tắt "mọi thiết bị" của riêng người dùng. */
export async function setAllDevicesPushEnabled(enabled: boolean): Promise<void> {
  await api.call("set_push_enabled", { p_enabled: enabled });
}

export interface PushDeviceInfo {
  id: string;
  device_label: string | null;
  device_hint: string;
  created_at: string;
  last_used_at: string;
}
/** Danh sách máy đã đăng ký — server cố tình KHÔNG trả endpoint/keys. */
export async function listMyPushDevices(): Promise<PushDeviceInfo[]> {
  return await api.call<PushDeviceInfo[]>("list_my_push_devices");
}

/**
 * Tự tái đăng ký khi trình duyệt báo subscription đổi (pushsubscriptionchange).
 * Chỉ im lặng thực hiện khi quyền đã được GRANTED từ trước — không bao giờ
 * nhân cơ hội này để xin quyền.
 */
export async function resubscribeIfPossible(): Promise<void> {
  if (notificationPermission() !== "granted") return;
  const registration = await readyRegistration().catch(() => null);
  if (!registration) return;
  const applicationKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!applicationKey) return;
  try {
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToApplicationKey(applicationKey),
    });
    await registerWithServer(subscription);
  } catch {
    /* trình duyệt từ chối (mất quyền/mạng yếu): lần mở app tới sẽ thử lại */
  }
}

/**
 * Lắng báo từ SW (event pushsubscriptionchange) — gọi một lần ở gốc app.
 * Trả về hàm dọn listener.
 */
export function startPushResubscribeListener(): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event?.data?.type === "carem:push-resubscribe") void resubscribeIfPossible();
  };
  navigator.serviceWorker?.addEventListener?.("message", onMessage);
  return () => navigator.serviceWorker?.removeEventListener?.("message", onMessage);
}

/**
 * Rút hàng đợi push của CHÍNH người dùng đang đăng nhập (self-drain):
 * invoke push-dispatch với Bearer JWT — server giới hạn p_user theo uid đã
 * xác minh, nên đây không phải đường gửi push tùy ý.
 */
export async function drainMyPushQueue(): Promise<void> {
  if (!supabase || !("PushManager" in window)) return;
  try {
    await supabase.functions.invoke("push-dispatch", { body: {} });
  } catch {
    /* hàng đợi vẫn nguyên trên DB — lược định kỳ hoặc lần mở sau sẽ tiêu */
  }
}

/**
 * Đồng bộ im lặng sau khi phiên được server xác thực:
 * - đã từng bật push trên máy này → đăng ký lại keys (endpoint có thể đổi)
 *   và rút bớt hàng đợi dồn khi offline.
 * - chưa bao giờ bật → KHÔNG làm gì, KHÔNG hỏi quyền.
 */
export async function syncPushOnLogin(): Promise<void> {
  if (!pushSupportInfo().supported) return;
  if (notificationPermission() !== "granted") return;
  const registration = await readyRegistration().catch(() => null);
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    await registerWithServer(subscription).catch(() => null);
  }
  await drainMyPushQueue();
}

/** Gửi thông báo TEST về chính các thiết bị của người dùng (Phase 2.6). */
export async function sendTestPush(): Promise<void> {
  await api.call<string>("request_push_test");
  // Kéo luôn thay vì chờ lược định kỳ — người bấm muốn thấy kết quả tại chỗ.
  await drainMyPushQueue();
}

/**
 * Chặn mọi đe dọa treo luồng chính: promise không bao giờ resolve (vd
 * serviceWorker.ready khi trình duyệt chặn/cài SW thất bại) không được phép
 * làm tê liệt đăng xuất. Quá hạn → coi như bỏ, đi tiếp.
 */
function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Dọn trước khi đăng xuất: gọi khi phiến còn hiệu lực (RPC authenticated) rồi
 * mới unsubscribe tại trình duyệt. Không được ném lỗi — đăng xuất offline vẫn
 * phải hoàn tất. Không BAO GIỜ chờ `serviceWorker.ready` (có thể treo vĩnh
 * viễn); dùng getRegistration() + withTimeout cho mọi bước.
 */
export async function cleanupPushBeforeSignOut(): Promise<void> {
  try {
    const storedId = readStoredSubscriptionId();
    if (storedId) {
      await withTimeout(api.call("unregister_push_subscription", { p_id: storedId }).catch(() => null), 3000);
      writeStoredSubscriptionId(null);
    }
    const registration = await withTimeout(navigator.serviceWorker?.getRegistration(), 1500);
    const subscription = await withTimeout(registration?.pushManager.getSubscription(), 1500);
    if (subscription) await withTimeout(subscription.unsubscribe(), 1500);
  } catch {
    /* best-effort; subscription chết trên server sẽ bị quên qua 404/410 */
  }
}
