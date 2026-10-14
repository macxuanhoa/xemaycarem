// push-dispatch — Edge Function gửi Web Push của Cà Rem (Phase 2.3).
//
// Bất kỳ ai gọi cũng chỉ có thể "rút hết việc của CHÍNH HỌ" (Bearer = JWT user)
// hoặc là luồng nội bộ (service role / PUSH_SWEEP_TOKEN). Không tồn tại đường
// nào để một người dùng gửi push tới thiết bị của người khác: RPC
// claim_push_deliveries là service-role-only và tự gắn p_user theo JWT đã xác
// minh. Function không bao giờ trả endpoint/khóa subscription ra ngoài.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2.117.2/cors';
import { sendPush, type PushTarget, type VapidConfig } from '../_shared/webpush.ts';
import { buildPushPayloadJson } from '../_shared/push-payload.ts';

class DispatchError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

interface SubRow { id: string; endpoint: string; p256dh: string; auth: string }
interface ClaimItem {
  delivery_id: string;
  kind: 'NOTIFICATION' | 'TEST';
  user_id: string;
  title: string | null;
  body: string | null;
  link: string | null;
  subscriptions: SubRow[];
}

// Giới hạn lô: mỗi lần gọi nhận tối đa 10 delivery và thử gửi tối đa 30 push.
// Việc còn lại nằm hàng đợi QUEUED/CLAIMED — lease 2 phút tự thu hồi, không
// bao giờ mất việc (transactional outbox).
const CLAIM_LIMIT = 10;
const SEND_BUDGET = 30;

async function rpc(serviceKey: string, fn: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new DispatchError(502, 'DATABASE_UNAVAILABLE');
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function readVapid(): VapidConfig {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY');
  const privateJwk = Deno.env.get('VAPID_PRIVATE_JWK');
  if (!publicKey || !privateJwk) throw new DispatchError(503, 'SERVER_CONFIGURATION_REQUIRED');
  let privateKeyJwk: JsonWebKey;
  try { privateKeyJwk = JSON.parse(privateJwk) as JsonWebKey; }
  catch { throw new DispatchError(503, 'SERVER_CONFIGURATION_REQUIRED'); }
  if (privateKeyJwk.kty !== 'EC' || privateKeyJwk.crv !== 'P-256' || typeof privateKeyJwk.d !== 'string') {
    throw new DispatchError(503, 'SERVER_CONFIGURATION_REQUIRED');
  }
  return { publicKey, privateKeyJwk, subject: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:it@carem-crm.local' };
}

Deno.serve(async (request: Request) => {
  const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (request.method === 'OPTIONS') return response(200, {});
  if (request.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
    if (!url || !anon || !serviceKey) throw new DispatchError(503, 'SERVER_CONFIGURATION_REQUIRED');
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) throw new DispatchError(401, 'AUTH_REQUIRED');
    const token = authorization.slice(7);

    // Định danh ba kiểu caller — thứ tự ưu tiên rõ ràng, KHÔNG rơi vào
    // chế độ "toàn bộ người dùng" chỉ vì token lạ (mọi token khác đều bị từ
    // chối nếu getUser thất bại). Privileged (service/sweep) giữ pUser = null.
    let pUser: string | null = null;
    const sweepToken = Deno.env.get('PUSH_SWEEP_TOKEN');
    if (token !== serviceKey && token !== sweepToken) {
      const caller = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
      const { data: auth, error: authError } = await caller.auth.getUser(token);
      if (authError || !auth.user) throw new DispatchError(401, 'AUTH_REQUIRED');
      pUser = auth.user.id;
    }

    const vapid = readVapid();
    const worker = `edge-${crypto.randomUUID().slice(0, 13)}`;
    // Người dùng thường chỉ được rút chính hàng đợi của mình (tự tiêu khi mở app).
    const claimed = (await rpc(serviceKey, 'claim_push_deliveries', { p_worker: worker, p_limit: CLAIM_LIMIT, p_user: pUser }, 8000)) as ClaimItem[] | null;
    const items = Array.isArray(claimed) ? claimed : [];

    let sent = 0, retried = 0, failed = 0, skipped = 0, purged = 0, processed = 0;
    let budget = SEND_BUDGET;
    const touchedIds: string[] = [];
    const deadEndpoints = new Set<string>();

    for (const item of items) {
      if (budget <= 0) break; // item ở lại CLAIMED — lease 2 phút re-ap; không mất việc.
      processed += 1;
      const payload = buildPushPayloadJson(item);
      const subs = Array.isArray(item.subscriptions) ? item.subscriptions : [];
      if (subs.length === 0) {
        await rpc(serviceKey, 'complete_push_delivery', { p_id: item.delivery_id, p_outcome: 'SKIPPED', p_error: 'NO_DEVICE' }, 5000);
        skipped += 1;
        continue;
      }
      let ok = false, goneAll = true, retryable = false, permanentError = '';
      for (const sub of subs) {
        if (budget <= 0) { retryable = true; break; }
        budget -= 1;
        const target: PushTarget = { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth };
        const result = await sendPush(target, payload, vapid);
        if (result.status >= 200 && result.status < 300) { ok = true; goneAll = false; touchedIds.push(sub.id); sent += 1; }
        else if (result.gone) { deadEndpoints.add(sub.endpoint); purged += 1; }
        else if (result.retryable) { retryable = true; goneAll = false; }
        else { goneAll = false; if (!permanentError) permanentError = `HTTP_${result.status}`; }
      }
      // Nguyên tắc chống trùng: đã có ít nhất một thiết bị nhận thành công thì
      // KHÔNG gửi lại lô nữa (chống trùng) — DONE. Chỉ lô chưa ai nhận mới RETRY.
      let outcome = 'DONE';
      if (!ok) {
        if (retryable) outcome = 'RETRY';
        else if (permanentError) outcome = 'FAILED';
        // goneAll || subs rỗng-after-forget → DONE vĩnh viễn (không còn thiết bị sống).
      }
      await rpc(serviceKey, 'complete_push_delivery', { p_id: item.delivery_id, p_outcome: outcome, p_error: outcome === 'DONE' ? null : (permanentError || (retryable ? 'PROVIDER_UNAVAILABLE' : null)) }, 5000);
      if (outcome === 'RETRY') retried += 1;
      if (outcome === 'FAILED') failed += 1;
    }

    // Dọn xác: chạm ngược last_used_at (≤200/lô) và quên endpoint 404/410.
    for (let i = 0; i < touchedIds.length; i += 200) {
      await rpc(serviceKey, 'touch_push_subscriptions', { p_ids: touchedIds.slice(i, i + 200) }, 5000).catch(() => null);
    }
    for (const endpoint of deadEndpoints) {
      await rpc(serviceKey, 'forget_push_subscription', { p_endpoint: endpoint }, 5000).catch(() => null);
    }
    // Chỉ số tổng, không PII, không endpoint, không nội dung thông báo.
    return response(200, { processed, sent, retried, failed, skipped, purged });
  } catch (error) {
    if (error instanceof DispatchError) return response(error.status, { error: error.code });
    return response(500, { error: 'DISPATCH_FAILED' });
  }
});
