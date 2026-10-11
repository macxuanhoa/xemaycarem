// Inbound transfers are authenticated before database access. The response is
// identical for matched/unmatched/replayed outcomes and contains no financial data.
import {
  parseSePay, parseCassoEvents, verifySePaySignature, verifySePayApiKey,
  verifyCassoToken, verifyCassoSignature, verifyHmacSignature, safeEqual,
  type BankEvent,
} from './adapter.ts';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
const MAX_BODY_BYTES = 128 * 1024;
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
// SePay and strict-mode Casso require success:true, independent of match state.
const received = () => json(200, { success: true });

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function ingest(events: BankEvent[]): Promise<Response> {
  if (!url || !serviceKey) return json(503, { status: 'NOT_CONFIGURED' });
  const deadline = AbortSignal.timeout(4_000);
  // Persist every accepted credit before acknowledging. On a partial batch failure
  // the provider retries; the DB transaction identity makes replay safe.
  for (const event of events) {
    if (event.direction !== 'in') continue;
    const response = await fetch(url + '/rest/v1/rpc/ingest_bank_transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: 'Bearer ' + serviceKey },
      body: JSON.stringify({ p_data: event }),
      signal: deadline,
    });
    if (!response.ok) return json(500, { status: 'INGEST_FAILED' });
  }
  return received();
}

Deno.serve(async (request: Request) => {
  if (request.method === 'GET') {
    const ready = Boolean(url && serviceKey && [
      'BANK_WEBHOOK_SEPAY_SECRET', 'BANK_WEBHOOK_SEPAY_API_KEY',
      'BANK_WEBHOOK_CASSO_TOKEN', 'BANK_WEBHOOK_CASSO_SECRET',
      'BANK_WEBHOOK_TOKEN', 'BANK_WEBHOOK_HMAC_SECRET',
    ].some(name => Deno.env.get(name)));
    return json(200, { status: ready ? 'CONFIGURED' : 'NOT_CONFIGURED' });
  }
  if (request.method !== 'POST') return json(405, { status: 'METHOD_NOT_ALLOWED' });
  try {
    const rawBody = await readBody(request);
    if (rawBody === null) return json(413, { status: 'INPUT_TOO_LARGE' });
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return json(400, { status: 'INVALID_PAYLOAD' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { status: 'INVALID_PAYLOAD' });

    let events: BankEvent[] | null = null;
    const sepaySecret = Deno.env.get('BANK_WEBHOOK_SEPAY_SECRET') ?? '';
    const sepayKey = Deno.env.get('BANK_WEBHOOK_SEPAY_API_KEY') ?? '';
    const sepayAuthenticated = await verifySePaySignature(rawBody, request.headers.get('x-sepay-signature'),
      sepaySecret, request.headers.get('x-sepay-timestamp'))
      || verifySePayApiKey(request.headers.get('Authorization'), sepayKey);
    if (sepayAuthenticated) {
      // Official provider authentication accepts only its documented flat shape.
      const event = 'transferAmount' in body ? parseSePay(body) : null;
      events = event ? [event] : null;
    } else {
      const cassoToken = Deno.env.get('BANK_WEBHOOK_CASSO_TOKEN') ?? '';
      const cassoSecret = Deno.env.get('BANK_WEBHOOK_CASSO_SECRET') ?? '';
      const cassoAuthenticated = verifyCassoToken(request.headers.get('secure-token'), cassoToken)
        || await verifyCassoSignature(body, request.headers.get('x-casso-signature'), cassoSecret);
      if (cassoAuthenticated) {
        events = 'data' in body ? parseCassoEvents(body) : null;
      } else {
        const genericToken = Deno.env.get('BANK_WEBHOOK_TOKEN') ?? '';
        const genericOk = Boolean(genericToken && safeEqual(request.headers.get('x-webhook-token') ?? '', genericToken));
        const hmacOk = await verifyHmacSignature(rawBody, request.headers.get('x-hmac-sha256'),
          Deno.env.get('BANK_WEBHOOK_HMAC_SECRET') ?? '');
        if (!genericOk && !hmacOk) return json(401, { status: 'UNAUTHORIZED' });
        const provider = 'provider' in body && typeof body.provider === 'string' ? body.provider.toUpperCase() : '';
        if (provider === 'CASSO' || 'vqb_id' in body) events = parseCassoEvents(body);
        else {
          const event = parseSePay(body);
          events = event ? [event] : null;
        }
      }
    }
    if (!events) return json(400, { status: 'INVALID_PAYLOAD' });
    return await ingest(events);
  } catch {
    // Never return provider secrets, database messages, transfer contents or traces.
    return json(500, { status: 'INGEST_FAILED' });
  }
});

