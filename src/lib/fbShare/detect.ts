// Thăm dò khả năng thiết bị rồi CHỌN chiến lược chuyển nội dung sang Facebook.
// Hàm thuần (nhận env vào) để test đơn vị dựng được mọi máy giả lập mà không cần
// trình duyệt thật: iOS Safari, Android Chrome, desktop có/không tiện ích.

import type { ShareStrategyId } from "./status";

export type Platform = "desktop" | "android" | "ios";

export type ShareEnv = {
  platform: Platform;
  /** Web Share API có tồn tại. */
  webShare: boolean;
  /** Web Share chịu nhận KÈM TỆP (iOS 15+/Android Chrome hỗ trợ files; nhiều browser thì không). */
  webShareFiles: boolean;
  /** Clipboard write cần secure context; HTTP nội bộ là false. */
  clipboard: boolean;
  secureContext: boolean;
  /** Tiện ích Facebook đã cài và trả lời ping. */
  extensionReady: boolean;
};

export type ShareEnvSource = {
  userAgent: string;
  maxTouchPoints?: number;
  hasShare: boolean;
  canShareFiles: boolean;
  secureContext: boolean;
  hasClipboard: boolean;
  extensionReady: boolean;
};

/** Nhận diện máy từ UA + số điểm chạm; iPad desktop-mode vẫn ra Mac nên cần maxTouchPoints. */
export function readPlatform(source: Pick<ShareEnvSource, "userAgent" | "maxTouchPoints">): Platform {
  const ua = source.userAgent.toLowerCase();
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  // iPadOS 13+ giả UA là Mac; điểm chạm > 1 là dấu hiệu đáng tin hơn UA.
  if (/mac/.test(ua) && (source.maxTouchPoints ?? 0) > 1) return "ios";
  return "desktop";
}

export function readShareEnv(source: ShareEnvSource): ShareEnv {
  const platform = readPlatform(source);
  const clipboard = platform === "desktop" ? source.hasClipboard && source.secureContext : false;
  return {
    platform,
    webShare: source.hasShare,
    webShareFiles: source.hasShare && source.canShareFiles,
    clipboard,
    secureContext: source.secureContext,
    extensionReady: source.extensionReady,
  };
}

export type StrategyChoice = {
  strategy: ShareStrategyId;
  /** Lý do bằng tiếng Việt, hiển thị khi người dùng bấm "vì sao?". */
  reason: string;
  /** Có nên mời cài tiện ích không (chỉ desktop, khi chưa có tiện ích). */
  suggestExtension: boolean;
};

/**
 * Thứ tự ưu tiên: tiện ích (desktop, tự điền + tự kiểm chứng) → share sheet
 * gốc (mobile, chữ + ảnh trong một lần chia sẻ) → dán thủ công. Không có
 * nhánh nào "tự đăng": mọi chiến lược đều dừng ở bước người dùng bấm Đăng.
 */
export function chooseStrategy(env: ShareEnv): StrategyChoice {
  if (env.platform === "desktop") {
    if (env.extensionReady)
      return { strategy: "EXTENSION", reason: "Máy đã có Cầu đăng Facebook nên điền thẳng vào Facebook.", suggestExtension: false };
    if (env.webShare)
      return { strategy: "NATIVE", reason: "Trình duyệt desktop hỗ trợ chia sẻ kèm tệp.", suggestExtension: true };
    return {
      strategy: "MANUAL",
      reason: env.clipboard
        ? "Chưa có Cầu đăng Facebook; nội dung đã vào bộ nhớ tạm, bạn chỉ cần dán."
        : "Trang đang chạy ngoài HTTPS nên không dùng được bộ nhớ tạm. Hãy tải ảnh về.",
      suggestExtension: true,
    };
  }
  if (env.webShareFiles)
    return { strategy: "NATIVE", reason: "Điện thoại chia sẻ được cả chữ lẫn ảnh vào app Facebook.", suggestExtension: false };
  if (env.webShare)
    return { strategy: "NATIVE", reason: "Điện thoại chỉ chia sẻ được chữ; ảnh tải về rồi đính kèm khi đăng.", suggestExtension: false };
  return { strategy: "MANUAL", reason: "Trình duyệt này không có nút chia sẻ; đã chuẩn bị sẵn để bạn dán.", suggestExtension: false };
}

/** Label ngắn cho từng chiến lược, dùng trong UI và log. */
export const strategyLabels: Record<ShareStrategyId, string> = {
  EXTENSION: "Cầu đăng Facebook (tiện ích trình duyệt)",
  NATIVE: "Chia sẻ của điện thoại",
  MANUAL: "Dán thủ công",
};

/**
 * Đọc khả năng thật của trình duyệt đang chạy. `canShare` phải được hỏi KÈM
 * files: rất nhiều trình duyệt nhận share text nhưng từ chối share ảnh, và đó
 * chính là khác biệt quyết định chiến lược.
 */
export function readBrowserEnv(extensionReady: boolean): ShareEnv {
  const probe = new File(["x"], "probe.jpg", { type: "image/jpeg" });
  return readShareEnv({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    hasShare: typeof navigator.share === "function",
    canShareFiles: typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }),
    secureContext: window.isSecureContext,
    hasClipboard: !!navigator.clipboard && typeof navigator.clipboard.writeText === "function",
    extensionReady,
  });
}
