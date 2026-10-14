/**
 * push-payload.ts — bản dựng payload Web Push PHÍA SERVER, dùng chung hợp đồng
 * v1 với src/lib/pushContracts.ts (được kiểm bằng unit test round-trip
 * tests/unit/push-contract.test.ts — đổi một bên là test đỏ bên kia).
 *
 * Nguyên tắc an toàn tài chính & riêng tư:
 * - title/body CHỈ lấy từ hàng public.notifications tương ứng — nội dung đã
 *   được private.notify_from_audit gate theo quyền "xem tiền" của từng người
 *   nhận ngay khi tạo. Push không tự sinh nội dung, không xác nhận thanh toán,
 *   không chứa giá OWNER-private hay CCCD/PII.
 * - link đi qua whitelist safeDeepLink: luôn luôn là path nội bộ Cà Rem.
 */

// Bản sao hợp đồng local — Edge deploy chỉ bundle trong supabase/functions
// nên KHÔNG được import vượt thư mục. tính tương thích hai bản do
// tests/unit/push-contract.test.ts kiểm soát bằng round-trip thật.
interface CaremPushPayload {
  v: 1;
  kind: 'notification' | 'test';
  id: string;
  title: string;
  body: string;
  link: string;
}

export const PUSH_FALLBACK_LINK = '/thong-bao';

/** Whitelist deep link — bản server, logic phải khớp 100% bản client. */
export function safeDeepLink(value: unknown): string {
  if (typeof value !== 'string') return PUSH_FALLBACK_LINK;
  const link = value.replace(/\p{Cc}/gu, '');
  if (!link.startsWith('/') || link.startsWith('//')) return PUSH_FALLBACK_LINK;
  if (link.includes('\\')) return PUSH_FALLBACK_LINK;
  // Chặn traversal ".." — khớp 100% với bản client pushContracts.ts.
  if (link.includes('..')) return PUSH_FALLBACK_LINK;
  return link.length > 200 ? PUSH_FALLBACK_LINK : link;
}

function clampText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? text.slice(0, max) : text;
}

export interface ClaimedPushItem {
  delivery_id: string;
  kind: 'NOTIFICATION' | 'TEST';
  title: string | null;
  body: string | null;
  link: string | null;
}

/**
 * Dựng chuỗi JSON đã chốt hợp đồng cho một item mà claim_push_deliveries trả về.
 * id dùng delivery_id (uuid 36 ký tự < trần 64 của hợp đồng) — SW dùng làm tag
 * gom nhóm; two trường text được clamp đúng trần parser client (160/400).
 */
export function buildPushPayloadJson(item: ClaimedPushItem): string {
  const payload: CaremPushPayload = {
    v: 1,
    kind: item.kind === 'TEST' ? 'test' : 'notification',
    id: clampText(item.delivery_id, 64),
    title: clampText(item.title, 160) || 'Cà Rem',
    body: clampText(item.body, 400),
    link: safeDeepLink(item.link),
  };
  return JSON.stringify(payload);
}
