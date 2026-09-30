// This is the only endpoint requiring a server secret. Browser clients never receive it.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

function platformKey(single: string, collection: string, legacy: string): string | undefined {
  const explicit = Deno.env.get(single);
  if (explicit) return explicit;
  try {
    const named: unknown = JSON.parse(Deno.env.get(collection) ?? '{}');
    if (named && typeof named === 'object' && !Array.isArray(named)) {
      const keys = named as Record<string, unknown>;
      const value = keys.default ?? Object.values(keys).find((key) => typeof key === 'string' && key.length > 0);
      if (typeof value === 'string' && value) return value;
    }
  } catch { /* A configured legacy key remains supported during migration. */ }
  return Deno.env.get(legacy);
}

const url = Deno.env.get('SUPABASE_URL');
const anonKey = platformKey('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const serviceKey = platformKey('SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const allowedOrigins = new Set((Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean));

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('Origin');
  const cors: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  const response = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  if (origin && !allowedOrigins.has(origin)) return response(403, { error: 'ORIGIN_NOT_ALLOWED' });
  if (origin) cors['Access-Control-Allow-Origin'] = origin;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return response(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!url || !anonKey || !serviceKey) return response(503, { error: 'SERVER_CONFIGURATION_REQUIRED' });

  try {
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return response(401, { error: 'AUTH_REQUIRED' });
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await caller.auth.getUser(authorization.slice(7));
    if (authError || !authData.user) return response(401, { error: 'AUTH_REQUIRED' });
    const { data: profile, error: profileError } = await caller.from('profiles').select('role, active').eq('id', authData.user.id).single();
    if (profileError || profile?.role !== 'OWNER' || !profile.active) return response(403, { error: 'ACCESS_DENIED' });

    // Reject oversized bodies before parsing, including chunked requests with no Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return response(400, { error: 'INVALID_INPUT' });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); return response(413, { error: 'INPUT_TOO_LARGE' }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return response(400, { error: 'INVALID_INPUT' });
    const body = input as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : 'STAFF';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || fullName.length < 1 || fullName.length > 120
      || password.length < 12 || password.length > 128 || !['OWNER', 'MANAGER', 'STAFF', 'VIEWER'].includes(role)
      || (body.can_view_financials !== undefined && typeof body.can_view_financials !== 'boolean')) {
      return response(400, { error: 'INVALID_INPUT' });
    }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (error || !data.user) {
      console.error('User provisioning failed', { code: error?.code });
      return response(400, { error: 'USER_CREATION_FAILED' });
    }
    // The auth trigger creates an inactive VIEWER. Authorization is checked again
    // inside this RPC, which also logs the change and protects the final OWNER.
    const { error: updateError } = await caller.rpc('update_profile', {
      p_id: data.user.id,
      p_data: { full_name: fullName, role, active: true, can_view_financials: body.can_view_financials === true },
    });
    if (updateError) {
      console.error('Profile activation failed', { id: data.user.id, code: updateError.code });
      // Do not delete an account after partial creation: retain its inactive
      // profile so the owner can inspect and safely activate it from Users.
      return response(409, { error: 'USER_CREATED_INACTIVE', id: data.user.id });
    }
    return response(201, { id: data.user.id });
  } catch (error) {
    console.error('User provisioning request failed', { type: error instanceof Error ? error.name : 'Unknown' });
    return response(400, { error: 'INVALID_REQUEST' });
  }
});
