/**
 * CaremPushPayload — hợp đồng dữ liệu gửi qua Web Push.
 *
 * Server (Edge Function `push-dispatch`) encrypt payload theo RFC 8291 và chỉ
 * đưa VÀO đúng các trường đã được gate theo quyền ở tầng DB (body của
 * notifications đã là bản "có tiền" hoặc "không tiền" tùy người nhận). Vì vậy
 * màn hình khóa điện thoại không bao giờ lộ giá OWNER-private hay PII khách
 * hàng — chúng không tồn tại trong payload ngay từ lúc tạo.
 *
 * Bản SW parse phía client và bản server build phía Edge dùng chung cấu trúc này;
 * bản server tại supabase/functions/_shared/push-payload.ts được kiểm
 * tương thích bằng unit test round-trip (tests/unit/push-contract.test.ts).
 */

export interface CaremPushPayload {
  /** Phiên bản hợp đồng — nâng cấp có kiểm soát, từ chối bản lạ. */
  v: 1;
  kind: "notification" | "test";
  /** id bản ghi delivery — làm tag gom/thu gọn notification trùng lặp. */
  id: string;
  title: string;
  body: string;
  /** Đường dẫn nội bộ, luôn bắt đầu bằng "/" và an toàn. */
  link: string;
}

/** Trang dự phòng tuyệt đối an toàn khi payload thiếu/hỏng. */
export const PUSH_FALLBACK_LINK = "/thong-bao";

/**
 * Whitelist deep link: chỉ nhận path nội bộ bắt đầu bằng một dấu
 * "/". Chặn "//host" (protocol-relative), scheme ngoài "http(s)://…", ký tự
 * điều khiển và backslash — SW không bao giờ điều hướng ra ngoài Cà Rem.
 */
export function safeDeepLink(value: unknown): string {
  if (typeof value !== "string") return PUSH_FALLBACK_LINK;
  // Trim an toàn rồi kiểm tra trên chuỗi gốc đã trim. \p{Cc} là toàn bộ nhóm
  // ký tự điều khiển (U+0000–U+001F và U+007F) — giống hệt dải cũ, chỉ viết
  // bằng property escape để không vi phạm quy tắc no-control-regex.
  const link = value.replace(/\p{Cc}/gu, "");
  if (!link.startsWith("/") || link.startsWith("//")) return PUSH_FALLBACK_LINK;
  if (link.includes("\\")) return PUSH_FALLBACK_LINK;
  // Chặn traversal ".." — sau khi strip ký tự điều khiển, "/ok\u0000../../etc"
  // vẫn bắt đầu bằng một dấu "/" nhưng thoát khỏi cây route nội bộ.
  if (link.includes("..")) return PUSH_FALLBACK_LINK;
  return link.length > 200 ? PUSH_FALLBACK_LINK : link;
}

/** Parse chuỗi JSON từ event.push.data — lỗi bất kỳ → null (fallback chung). */
export function parsePushPayload(raw: string | null): CaremPushPayload | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const p = data as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (p.kind !== "notification" && p.kind !== "test") return null;
  if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 64) return null;
  if (typeof p.title !== "string" || p.title.length === 0 || p.title.length > 160) return null;
  if (typeof p.body !== "string" || p.body.length > 400) return null;
  return { v: 1, kind: p.kind, id: p.id, title: p.title, body: p.body, link: safeDeepLink(p.link) };
}
