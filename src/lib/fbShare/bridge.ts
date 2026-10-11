// Cầu nối phía trang web sang tiện ích "Cầu đăng Facebook".
// Trang chỉ nói chuyện được với tiện ích khi manifest khai báo
// `externally_connectable` đúng origin — đó là chốt an toàn: một trang khác
// dù giả mạo giao diện cũng không gửi nổi payload vào Facebook của ta.
//
// Hai lệnh: `ping` (dò xem tiện ích có trên máy không, trả lời nhanh) và
// `share` (chuyển nội dung, nhận KẾT QUẢ ĐÃ KIỂM CHỨNG). Không có lệnh nào
// bấm nút Đăng thay người dùng.

import {
  FB_SHARE_CHANNEL,
  FB_SHARE_EXTENSION_ID,
  FB_SHARE_LIMITS,
  FB_SHARE_PROTOCOL_VERSION,
} from "./protocol";
import type { SharePayload } from "./protocol";

export type ExtensionShareReply = {
  type: "share-result";
  protocol: number;
  ok: boolean;
  /** composer đã nhận caption và content script đã đọc lại xác nhận. */
  captionFilled: boolean;
  imagesAttached: number;
  imagesExpected: number;
  code?: string;
};

export type ExtensionPingReply = { type: "pong"; protocol: number; ok: boolean };

type ChromeLike = {
  runtime?: {
    sendMessage?: (
      extensionId: string,
      message: unknown,
      callback: (response: unknown, lastError?: { message?: string }) => void,
    ) => void;
    lastError?: { message?: string };
  };
};

function readChrome(): ChromeLike | undefined {
  return (window as { chrome?: ChromeLike }).chrome;
}

/** Chờ phản hồi có hạn định — tiện ích chết im lặng thì trang phải nói được. */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function send<T>(message: unknown, timeoutMs: number, label: string): Promise<T> {
  const chrome = readChrome();
  const sendMessage = chrome?.runtime?.sendMessage;
  if (!sendMessage) return Promise.reject(new Error("EXTENSION_ABSENT"));
  return withTimeout(
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const handler = (response: unknown, lastError?: { message?: string }) => {
        if (settled) return;
        settled = true;
        if (lastError?.message) reject(new Error("EXTENSION_UNREACHABLE"));
        else resolve(response as T);
      };
      try {
        // Callback dạng 2 tham số chỉ tồn tại khi trang được liệt kê trong
        // externally_connectable; nếu tiện ích chưa cài, Chrome báo lỗi ngay.
        sendMessage.call(chrome?.runtime, FB_SHARE_EXTENSION_ID, message, (response: unknown) => {
          handler(response, chrome?.runtime?.lastError);
        });
      } catch {
        reject(new Error("EXTENSION_ABSENT"));
      }
    }),
    timeoutMs,
    label,
  );
}

/** `true` = tiện ích có mặt và cùng phiên bản giao thức. */
export async function pingExtension(): Promise<boolean> {
  try {
    const reply = await send<ExtensionPingReply>(
      { channel: FB_SHARE_CHANNEL, protocol: FB_SHARE_PROTOCOL_VERSION, type: "ping" },
      FB_SHARE_LIMITS.pingTimeoutMs,
      "PING_TIMEOUT",
    );
    return !!reply?.ok && reply.protocol === FB_SHARE_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

/** Đẩy toàn bộ caption + ảnh sang Facebook qua tiện ích, chờ kết quả đã kiểm chứng. */
export async function requestExtensionShare(
  payload: SharePayload,
): Promise<ExtensionShareReply> {
  const reply = await send<ExtensionShareReply>(
    { channel: FB_SHARE_CHANNEL, protocol: FB_SHARE_PROTOCOL_VERSION, type: "share", payload },
    FB_SHARE_LIMITS.shareTimeoutMs,
    "SHARE_TIMEOUT",
  );
  if (!reply || reply.protocol !== FB_SHARE_PROTOCOL_VERSION)
    throw new Error("EXTENSION_PROTOCOL_MISMATCH");
  return reply;
}
