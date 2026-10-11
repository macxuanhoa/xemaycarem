// Provider-agnostic outbox worker. V1 supports MOCK/DISABLED; V2 registers the
// official adapters (ZALO_OA, FB_MESSENGER, SMS) which fail closed WITHOUT credentials.
// Personal channels never reach a worker: staff copy & send manually via DB RPCs.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2.117.2/cors';
import { createMessagingProvider } from './provider.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');

Deno.serve(async (request: Request) => {
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!url || !anonKey) return reply(503, { error: 'SERVER_CONFIGURATION_REQUIRED' });
  const authorization = request.headers.get('Authorization');
  if (!authorization) return reply(401, { error: 'AUTH_REQUIRED' });
  const client = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError || !auth.user) return reply(401, { error: 'AUTH_REQUIRED' });
  let body: unknown;
  try { body = await request.json(); } catch { return reply(400, { error: 'INVALID_INPUT' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('message_id' in body)
    || typeof body.message_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.message_id)) {
    return reply(400, { error: 'INVALID_INPUT' });
  }
  const provider = createMessagingProvider(
    Deno.env.get('MESSAGE_PROVIDER_MODE'),
    (key) => Deno.env.get(key),
  );
  const { data: job, error: claimError } = await client.rpc('claim_message', {
    p_message_id: body.message_id, p_provider_mode: provider.name,
  });
  if (claimError) return reply(403, { error: claimError.message === 'CLIENT_UPGRADE_REQUIRED' ? 'CLIENT_UPGRADE_REQUIRED' : 'MESSAGE_CLAIM_FAILED' });
  if (!job?.id) return reply(200, { status: 'NOT_QUEUED' });
  if (!job.lease_token) return reply(503, { error: 'WORKER_SCHEMA_UPGRADE_REQUIRED' });

  // Missing credentials or channel routing fails closed; MOCK is explicitly selected.
  try {
    if (provider.name !== 'MOCK' && provider.name !== 'DISABLED' && !serviceKey) {
      throw new Error('PROVIDER_NOT_CONFIGURED');
    }
    const result = await provider.sendTransactionalMessage({
      recipient: job.recipient_phone,
      channel: job.channel,
      template: job.template_code,
      variables: job.template_variables,
      idempotencyKey: job.id,
    });
    // MOCK keeps its deterministic completion path; official V2 adapters use the
    // generic finish_message (provider message id validated server-side).
    const finished = provider.name === 'MOCK'
      ? await client.rpc('finish_mock_message', {
        p_message_id: job.id, p_provider_message_id: result.providerMessageId, p_lease_token: job.lease_token,
      })
      : await createClient(url, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } }).rpc('finish_message', {
        p_message_id: job.id, p_provider_message_id: result.providerMessageId, p_lease_token: job.lease_token,
      });
    const { error } = finished;
    if (error) return reply(500, { error: 'MESSAGE_STATE_UPDATE_FAILED' });
    return reply(200, { status: result.status, provider: provider.name, provider_message_id: result.providerMessageId });
  } catch (error) {
    const notConfigured = error instanceof Error && error.message === 'PROVIDER_NOT_CONFIGURED';
    // Official APIs cannot prove that an ambiguous timeout/error was not accepted.
    // Stop automatic retries and require provider reconciliation before another send.
    const unknownDelivery = provider.name !== 'MOCK' && provider.name !== 'DISABLED' && !notConfigured;
    const { error: updateError } = notConfigured
      ? await client.rpc('skip_message', { p_message_id: job.id, p_error_code: 'PROVIDER_NOT_CONFIGURED', p_safe_message: 'Chưa cấu hình nhà cung cấp tin nhắn.', p_lease_token: job.lease_token })
      : await client.rpc('fail_message', { p_message_id: job.id,
        p_error_code: unknownDelivery ? 'DELIVERY_OUTCOME_UNKNOWN' : 'PROVIDER_ERROR',
        p_safe_message: unknownDelivery ? 'Kết quả gửi chưa xác định. Cần đối chiếu trước khi gửi lại.' : 'Không thể gửi tin nhắn.',
        p_permanent: unknownDelivery, p_lease_token: job.lease_token });
    return updateError ? reply(500, { error: 'MESSAGE_STATE_UPDATE_FAILED' })
      : reply(200, { status: notConfigured ? 'SKIPPED' : unknownDelivery ? 'FAILED' : 'QUEUED' });
  }
});
