/**
 * push.ts — phía client của Web Push Cà Rem (Phase 2.1).
 *
 * Push bật MẶC ĐỊNH, không có công tắc trong app: người dùng muốn ngưng chỉ
 * cần chặn thông báo ngay trong cài đặt trình duyệt (app tự tôn trọng quyết
 * định đó và không hỏi lại).
 *
 * Quy tắc vàng:
 * - KHÔNG xin quyền Notification giữa luồng mở app; lời hỏi chỉ đi theo một
 *   thao tác thật của người dùng (chạm đầu tiên sau khi đăng nhập) — trình
 *   duyệt tự chặn mọi requestPermission không có gesture nên im lặng hỏi
 *   ngay lúc mở app chỉ tổ thất bại.
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
const AUTO_PROMPT_KEY = "carem:push:auto-prompt-at";
/** Người chọn "Sau có thể" không bị hỏi lại dồn dập — nghỉ 7 ngày rồi thử. */
const AUTO_PROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Bật push cho thiết bị này. Đường mặc định: armAutoEnableOnFirstGesture()
 * gọi sau thao tác thật đầu tiên của phiên; nút/cài đặt không còn cần thiết.
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
  // Bật xong là thấy ngay: rút luôn phần dồn lúc chưa cho phép, không chờ.
  await drainMyPushQueue();
}

/**
 * Realtime báo tin mới khi app ĐANG mở → đẩy hàng đợi đi tức thì thay vì chờ
 * chu kỳ quét. Gom mọi tin trong `delayMs` thành MỘT lời gọi (fan-out nhiều
 * người nhận trong một transaction chỉ tốn một lần invoke).
 */
let drainTimer: ReturnType<typeof setTimeout> | null = null;
export function bumpPushDrain(delayMs = 2000): void {
  if (!("PushManager" in window)) return;
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainMyPushQueue();
  }, delayMs);
}

/**
 * Bật mặc định: khi quyền còn 'default', hẹn xin quyền ngay theo thao tác
 * thật đầu tiên của người dùng (pointerdown). Chrome/Edge/Safari đều từ chối
 * mở hộp quyền nếu không có gesture, nên đây là cách duy nhất 'tự bật' mà
 * không khiếm nhã. Người khoanh tay chờ thì lần mở app sau lại hẹn.
 */
let autoPromptArmed = false;
function armAutoEnableOnFirstGesture(): void {
  if (autoPromptArmed) return;
  if (!pushSupportInfo().supported) return;
  if (notificationPermission() !== "default") return;
  let lastAttempt = 0;
  try {
    lastAttempt = Number(localStorage.getItem(AUTO_PROMPT_KEY)) || 0;
  } catch {
    /* private mode: cứ hỏi theo gesture, không có cooldown */
  }
  if (Date.now() - lastAttempt < AUTO_PROMPT_COOLDOWN_MS) return;
  autoPromptArmed = true;
  window.addEventListener(
    "pointerdown",
    () => {
      try {
        localStorage.setItem(AUTO_PROMPT_KEY, String(Date.now()));
      } catch {
        /* không lưu được cooldown cũng không chặn luồng bật push */
      }
      void enablePush().catch(() => null);
    },
    { once: true, capture: true },
  );
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
 * Đồng bộ im lặng sau khi phiên được server xác thực — push bật mặc định:
 * - quyền đã GRANTED → đảm bảo có subscription (tạo im lặng, không hộp hỏi),
 *   tái đăng ký keys (endpoint có thể đổi), tự chữa công tắc tắt từ UI cũ,
 *   và rút bớt hàng đợi dồn khi offline.
 * - quyền còn DEFAULT → hẹn hỏi theo thao tác đầu tiên (armAutoEnable...).
 * - quyền DENIED → tôn trọng quyết định của trình duyệt, không hỏi lại.
 */
export async function syncPushOnLogin(): Promise<void> {
  armAutoEnableOnFirstGesture();
  if (!pushSupportInfo().supported) return;
  if (notificationPermission() !== "granted") return;
  const registration = await readyRegistration().catch(() => null);
  if (!registration) return;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const applicationKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
    if (!applicationKey) return;
    subscription = await registration.pushManager
      .subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToApplicationKey(applicationKey),
      })
      .catch(() => null);
  }
  if (subscription) {
    await registerWithServer(subscription).catch(() => null);
    // Không còn công tắc trong app: xóa dấu vết 'tắt mọi thiết bị' cũ để
    // hàng đợi về trạng thái bật mặc định của server.
    await api.call("set_push_enabled", { p_enabled: true }).catch(() => null);
  }
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
