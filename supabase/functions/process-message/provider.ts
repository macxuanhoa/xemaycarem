// Provider registry for the transactional outbox worker.
// V1 modes (MOCK/DISABLED) keep their exact semantics. V2 adds the OFFICIAL channel
// adapters (Zalo OA, Facebook Page Messenger, formal SMS). Every adapter fails closed:
// missing credentials throw PROVIDER_NOT_CONFIGURED and the worker marks the job
// SKIPPED — the system NEVER pretends a send succeeded. Personal channels
// (ZALO_PERSONAL/MESSENGER_PERSONAL) have no adapter at all: staff copy the message
// and send it themselves outside the app. No unofficial APIs, no cookie scraping,
// no logged-in personal bots — by design.
export type OutboxChannel = 'ZALO_ZNS' | 'SMS' | 'ZALO_OA' | 'FB_MESSENGER';

export type TransactionalMessage = {
  recipient: string;
  channel: OutboxChannel;
  template: string;
  variables: Record<string, string>;
  idempotencyKey: string;
};

export type ProviderResult = { providerMessageId: string; status: 'SENT' };

export interface MessagingProvider {
  readonly name: 'MOCK' | 'DISABLED' | 'ZALO_OA' | 'FB_MESSENGER' | 'SMS';
  sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult>;
}

export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'MOCK' as const;
  async sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult> {
    // MOCK has no external effect. A stable result lets a new worker reconcile the
    // same outbox operation after a crash without inventing a second delivery.
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(message.idempotencyKey)) throw new Error('INVALID_IDEMPOTENCY_KEY');
    return { providerMessageId: `mock_${message.idempotencyKey}`, status: 'SENT' };
  }
}

export class DisabledMessagingProvider implements MessagingProvider {
  readonly name = 'DISABLED' as const;
  async sendTransactionalMessage(_message: TransactionalMessage): Promise<never> {
    throw new Error('PROVIDER_NOT_CONFIGURED');
  }
}

type EnvGetter = (key: string) => string | undefined;

function requireEnv(env: EnvGetter, keys: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = (env(key) ?? '').trim();
    if (!value) throw new Error('PROVIDER_NOT_CONFIGURED');
    values[key] = value;
  }
  return values;
}

async function postJson(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<Record<string, any>> }> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  let json: Record<string, any> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
  } catch { /* non-JSON error bodies stay opaque and cannot prove acceptance */ }
  return { ok: response.ok, status: response.status, json: () => Promise.resolve(json) };
}

// --- Zalo OA (official REST API: api.zalo.me oa-api) --------------------------
// Docs: OAuth2 access token per OA; message via /message with template payload.
export class ZaloOaProvider implements MessagingProvider {
  readonly name = 'ZALO_OA' as const;
  constructor(private env: EnvGetter) {}
  async sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult> {
    if (message.channel !== 'ZALO_OA') throw new Error('PROVIDER_NOT_CONFIGURED');
    const { ZALO_OA_ACCESS_TOKEN, ZALO_OA_TEMPLATE_ID } = requireEnv(this.env,
      ['ZALO_OA_ID', 'ZALO_OA_ACCESS_TOKEN', 'ZALO_OA_TEMPLATE_ID']);
    // A phone number is not an OA-scoped subscriber UID. The existing phone-only
    // outbox must remain unconfigured until verified recipient routing is supplied.
    if (!/^\d{15,24}$/.test(message.recipient) || !/^\d+$/.test(ZALO_OA_TEMPLATE_ID)) {
      throw new Error('PROVIDER_NOT_CONFIGURED');
    }
    const body = {
      user_id: message.recipient,
      template_id: ZALO_OA_TEMPLATE_ID,
      template_data: message.variables,
    };
    const response = await postJson('https://openapi.zalo.me/v3.0/oa/message/template', {
      method: 'POST', headers: { access_token: ZALO_OA_ACCESS_TOKEN }, body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok || Number(json?.error ?? -1) !== 0) throw new Error('PROVIDER_ERROR');
    const messageId = String(json?.data?.message_id ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,119}$/.test(messageId)) throw new Error('PROVIDER_ERROR');
    return { providerMessageId: messageId, status: 'SENT' };
  }
}

// --- Facebook Page Messenger (official Graph API Send API) --------------------
export class FacebookMessengerProvider implements MessagingProvider {
  readonly name = 'FB_MESSENGER' as const;
  constructor(private env: EnvGetter) {}
  async sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult> {
    if (message.channel !== 'FB_MESSENGER') throw new Error('PROVIDER_NOT_CONFIGURED');
    const { FB_PAGE_ACCESS_TOKEN, FB_GRAPH_API_VERSION } = requireEnv(this.env,
      ['FB_PAGE_ACCESS_TOKEN', 'FB_GRAPH_API_VERSION']);
    if (!/^\d{15,24}$/.test(message.recipient) || !/^v\d+\.\d+$/.test(FB_GRAPH_API_VERSION)) {
      throw new Error('PROVIDER_NOT_CONFIGURED');
    }
    const text = message.variables.message
      ?? `Cảm ơn ${message.variables.customer_name ?? 'Quý khách'} đã mua xe tại ${message.variables.store_name ?? 'cửa hàng'}.`;
    const body = {
      recipient: { id: message.recipient }, // PSID stored in recipient slot for page conversations
      messaging_type: 'RESPONSE',
      message: { text },
    };
    const response = await postJson(`https://graph.facebook.com/${FB_GRAPH_API_VERSION}/me/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${FB_PAGE_ACCESS_TOKEN}` }, body: JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok || json?.error) throw new Error('PROVIDER_ERROR');
    const messageId = String(json?.message_id ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,119}$/.test(messageId)) throw new Error('PROVIDER_ERROR');
    return { providerMessageId: messageId, status: 'SENT' };
  }
}

// --- eSMS official JSON API (samplefordevelopers.esms.vn) ---------------------
export class SmsProvider implements MessagingProvider {
  readonly name = 'SMS' as const;
  constructor(private env: EnvGetter) {}
  async sendTransactionalMessage(message: TransactionalMessage): Promise<ProviderResult> {
    if (message.channel !== 'SMS') throw new Error('PROVIDER_NOT_CONFIGURED');
    const { SMS_API_ACCESS_KEY, SMS_API_SECRET_KEY, SMS_SENDER_NUMBER, SMS_API_URL } = requireEnv(
      this.env, ['SMS_API_ACCESS_KEY', 'SMS_API_SECRET_KEY', 'SMS_SENDER_NUMBER', 'SMS_API_URL']);
    let endpoint: URL;
    try { endpoint = new URL(SMS_API_URL); } catch { throw new Error('PROVIDER_NOT_CONFIGURED'); }
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'rest.esms.vn'
      || endpoint.pathname.replace(/\/$/, '') !== '/MainService.svc/json/SendMultipleMessage_V4_post_json'
      || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      throw new Error('PROVIDER_NOT_CONFIGURED');
    }
    if (!/^\+?\d{7,15}$/.test(message.recipient)) throw new Error('PROVIDER_NOT_CONFIGURED');
    const body = {
      Brandname: SMS_SENDER_NUMBER,
      ApiKey: SMS_API_ACCESS_KEY,
      SecretKey: SMS_API_SECRET_KEY,
      Phone: message.recipient,
      Content: message.variables.message
        ?? `Cam on ${message.variables.customer_name ?? 'Quy khach'} da mua xe tai ${message.variables.store_name ?? 'cua hang'}.`,
      SmsType: '2',
      IsUnicode: '1',
      RequestId: message.idempotencyKey,
    };
    const response = await postJson(SMS_API_URL, { method: 'POST', body: JSON.stringify(body) });
    const json = await response.json();
    // eSMS acceptance requires explicit success AND
    // its real message identifier. Empty/non-JSON/unknown replies never mean SENT.
    if (!response.ok || String(json?.CodeResult ?? '') !== '100') throw new Error('PROVIDER_ERROR');
    const messageId = typeof json?.SMSID === 'string' ? json.SMSID : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,119}$/.test(messageId)) throw new Error('PROVIDER_ERROR');
    return { providerMessageId: messageId, status: 'SENT' };
  }
}

// Modes stay channel-agnostic in the queue: the worker selects a mode per claim;
// the DB rejects a mode/channel mismatch (MESSAGE_PROVIDER_MODE_CONFLICT).
// Env is injected by the caller (the Edge worker passes `Deno.env`). The default
// getter yields no credentials so an unconfigured official provider fails closed.
export function createMessagingProvider(mode: string | undefined, env: EnvGetter = () => undefined): MessagingProvider {
  switch (mode) {
    case 'MOCK': return new MockMessagingProvider();
    case 'ZALO_OA': return new ZaloOaProvider(env);
    case 'FB_MESSENGER': return new FacebookMessengerProvider(env);
    case 'SMS': return new SmsProvider(env);
    // DISABLED and personal/unknown modes keep the V1 fail-closed contract exactly.
    default: return new DisabledMessagingProvider();
  }
}
