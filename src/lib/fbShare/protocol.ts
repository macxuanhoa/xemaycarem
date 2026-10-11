// Khung giao giữa CRM Cà Rem và tiện ích "Cà Rem · Cầu đăng Facebook".
// Mọi hằng số ở đây là HỢP ĐỒNG: trang web, service worker và content script
// của tiện ích phải khớp nhau từng ký tự, nếu không nội dung sẽ rơi im lặng
// vào một tab Facebook không ai điền. Vì vậy phần kiểm tra ở file này là hàm
// thuần, không đụng DOM, để test đơn vị chạy được.
//
// Ảnh đi theo payload là data-URL do chính trình duyệt người dùng ký từ
// Supabase Storage — không có token/cookie Facebook nào được đọc hay gửi.

/** Phiên bản giao thức. Tiện ích lệch phiên bản sẽ bị từ chối ngay khi ping. */
export const FB_SHARE_PROTOCOL_VERSION = 1 as const;

/**
 * ID tiện ích sinh ra từ khoá `key` công khai trong manifest (SHA-256 của SPKI
 * DER, 16 byte đầu ánh xạ a–p). Khoá riêng tư KHÔNG nằm trong repo; chỉ cần
 * khoá công khai để trình duyệt ấn định một ID ổn định trên mọi máy.
 */
export const FB_SHARE_EXTENSION_ID = "njlnpebadapfckldkmdhdhbmnmckgcap";

/** Nhãn kênh message để tiện ích phân biệt request của CRM với tab khác. */
export const FB_SHARE_CHANNEL = "carem-fb-share";

/** Trang cá nhân Facebook — nơi composer mở ra khi không nhắm vào hội nhóm. */
export const FB_HOME = "https://www.facebook.com/";

/** Giới hạn cứng — chặn payload phình to làm nghẽn message bus của extension. */
export const FB_SHARE_LIMITS = {
  captionChars: 5000,
  images: 8,
  imageBytes: 4 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  /** Ping dò tiện ích: nhanh vì người dùng đang bấm và chờ. */
  pingTimeoutMs: 1200,
  /** Full handshake: mở tab, đợi composer, điền, kiểm chứng. */
  shareTimeoutMs: 45_000,
} as const;

const ACCEPTED_IMAGE_MIME = ["image/png", "image/jpeg", "image/jpg", "image/webp"] as const;
export type AcceptedImageMime = (typeof ACCEPTED_IMAGE_MIME)[number];

export function isAcceptedImageMime(mime: string): mime is AcceptedImageMime {
  return (ACCEPTED_IMAGE_MIME as readonly string[]).includes(mime.toLowerCase());
}

export type ShareImage = {
  /** Tên tệp thân thiện với người dùng, ví dụ `92D1-118.77-1.jpg`. */
  name: string;
  mime: string;
  /** `data:image/...;base64,...` — ảnh đã nằm trong tay người dùng, không phải link tư nhân. */
  data: string;
};

export type FacebookShareTarget = "PERSONAL" | "GROUP";

export type SharePayload = {
  caption: string;
  images: ShareImage[];
  target: FacebookShareTarget;
  /** Link hội nhóm người dùng tự dán; chỉ dùng khi target = GROUP. */
  groupUrl?: string;
  /** Nhãn xe để content script nhận diện bài đúng nội dung khi kiểm chứng. */
  vehicleLabel?: string;
  request: string;
};

export type ShareErrorCode =
  | "EMPTY_CAPTION"
  | "CAPTION_TOO_LONG"
  | "TOO_MANY_IMAGES"
  | "BAD_IMAGE"
  | "IMAGE_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "BAD_GROUP_URL";

/** Nhóm link hội nhóm chỉ chấp nhận https://www.facebook.com/… — không cho JS/địa chỉ lạ. */
export function safeGroupUrl(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "www.facebook.com" && url.hostname !== "facebook.com") return null;
  if (!/^\/(groups|share)\//i.test(url.pathname)) return null;
  return url.toString();
}

const DATA_IMAGE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\r\n]+$/;

function approxBase64Bytes(data: string): number {
  const comma = data.indexOf(",");
  const body = comma >= 0 ? data.slice(comma + 1) : data;
  return Math.floor((body.length * 3) / 4);
}

/**
 * Chốt cuối trước khi dữ liệu rời khỏi trang. Trả về payload đã cắt gọt
 * (caption giữ NGUYÊN hàng/remoji/Unicode — không tự biên tập nội dung của
 * người dùng) hoặc mã lỗi để UI diễn đạt bằng lời người.
 */
export function validateSharePayload(
  input: Partial<SharePayload> & { caption?: string; images?: ShareImage[] },
): { ok: true; value: SharePayload } | { ok: false; code: ShareErrorCode } {
  const caption = (input.caption ?? "").replace(/\r\n/g, "\n");
  if (!caption.trim()) return { ok: false, code: "EMPTY_CAPTION" };
  if (caption.length > FB_SHARE_LIMITS.captionChars) return { ok: false, code: "CAPTION_TOO_LONG" };

  const images = input.images ?? [];
  if (images.length > FB_SHARE_LIMITS.images) return { ok: false, code: "TOO_MANY_IMAGES" };
  let total = 0;
  for (const image of images) {
    if (!image || !isAcceptedImageMime(image.mime) || !DATA_IMAGE.test(image.data ?? ""))
      return { ok: false, code: "BAD_IMAGE" };
    const bytes = approxBase64Bytes(image.data);
    if (bytes > FB_SHARE_LIMITS.imageBytes) return { ok: false, code: "IMAGE_TOO_LARGE" };
    total += bytes;
  }
  if (total > FB_SHARE_LIMITS.totalBytes) return { ok: false, code: "TOTAL_TOO_LARGE" };

  const target: FacebookShareTarget = input.target === "GROUP" ? "GROUP" : "PERSONAL";
  const groupUrl = target === "GROUP" ? safeGroupUrl(input.groupUrl) : null;
  if (target === "GROUP" && !groupUrl) return { ok: false, code: "BAD_GROUP_URL" };

  return {
    ok: true,
    value: {
      caption,
      images,
      target,
      ...(groupUrl ? { groupUrl } : {}),
      ...(input.vehicleLabel ? { vehicleLabel: input.vehicleLabel } : {}),
      request: input.request ?? crypto.randomUUID(),
    },
  };
}

/** base64 → BinaryArray an toàn cho cả message bus lẫn `File` trong content script. */
export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const comma = dataUrl.indexOf(",");
  const body = (comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl).replace(/\s/g, "");
  const binary = atob(body);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * So khớp nội dung đã xuất hiện trên composer với nội dung gửi đi. Facebook
 * có thể tự đổi whitespace khi dán, nên so theo dạng "đã chuẩn hoá khoảng
 * trắng" và chấp nhận khớp một ngưỡng tối thiểu — tuyệt đối không assert
 * từng ký tự, tỷ lệ này chỉ dùng để QUYẾT ĐỊNH có được nói "đã điền" hay không.
 */
export function captionFilledRatio(expected: string, actual: string): number {
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const want = clean(expected);
  const got = clean(actual);
  if (!want) return 0;
  if (got === want) return 1;
  if (got && want.startsWith(got)) return got.length / want.length;
  // Đếm ký tự khớp theo thứ tự (subsequence): composer chèn emoji/xuống dòng
  // khác nhau giữa các phiên bản, nhưng nội dung cốt lõi vẫn còn nguyên.
  let index = 0;
  let matched = 0;
  for (const char of got) {
    const found = want.indexOf(char, index);
    if (found < 0) continue;
    index = found + 1;
    matched += 1;
  }
  return matched / want.length;
}

/** Ngưỡng "được coi là đã điền" — dưới mức này coi như thất bại và về fallback. */
export const CAPTION_FILL_THRESHOLD = 0.85;
