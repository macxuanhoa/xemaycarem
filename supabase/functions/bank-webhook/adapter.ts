// Official contracts: developer.sepay.vn/en/sepay-webhooks and developer.casso.vn/webhook.
// Custom envelopes remain usable only with separately configured generic token/HMAC.
export type BankEvent = {
  provider: 'SEPAY' | 'CASSO';
  provider_txn_id: string;
  amount: string;
  account_number: string;
  transfer_content: string;
  sender_name: string;
  sender_bank: string;
  transfer_at: string;
  direction: 'in' | 'out';
  raw: Record<string, unknown>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Never repair malformed money, truncate financial identity or invent a date.
function money(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000_000
      ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const digits = /^\d+$/.test(text) ? text
    : /^\d{1,3}(?:\.\d{3})+$/.test(text) ? text.replaceAll('.', '') : '';
  if (!digits || digits.length > 13) return null;
  const amount = BigInt(digits);
  return amount > 0n && amount <= 1_000_000_000_000n ? String(amount) : null;
}

function transferDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // Provider timezone-free bank timestamps are Vietnam local time, never Edge UTC.
  const local = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(text);
  const normalized = local
    ? (text.length === 10 ? text + 'T00:00:00' : text.replace(' ', 'T')) + '+07:00'
    : text;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1
    || dayNumber > new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalize(provider: BankEvent['provider'], source: Record<string, unknown>, raw: Record<string, unknown>): BankEvent | null {
  const id = source.id;
  if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) return null;
  const txnId = String(id).trim();
  const amount = money(source.amount);
  const transferAt = transferDate(source.date);
  const direction = source.direction;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(txnId) || !amount || !transferAt
    || (direction !== 'in' && direction !== 'out')) return null;
  return {
    provider, provider_txn_id: txnId, amount,
    account_number: typeof source.account === 'string' ? source.account.trim() : '',
    transfer_content: typeof source.content === 'string' ? source.content.slice(0, 240) : '',
    sender_name: typeof source.sender === 'string' ? source.sender.slice(0, 120) : '',
    sender_bank: typeof source.bank === 'string' ? source.bank.slice(0, 40) : '',
    transfer_at: transferAt, direction, raw,
  };
}

export function parseSePay(body: unknown): BankEvent | null {
  if (!record(body)) return null;
  if ('transferAmount' in body) {
    return normalize('SEPAY', {
      id: body.id, amount: body.transferAmount, content: body.content,
      date: body.transactionDate, direction: body.transferType,
      account: body.accountNumber,
    }, body);
  }
  // Historical custom envelope; not claimed as an official SePay format.
  if (!record(body.data)) return null;
  const d = body.data;
  return normalize('SEPAY', {
    id: d.id, amount: d.amount, content: d.description, date: d.transferred_at,
    direction: d.type, account: d.account_number, sender: d.sender_name, bank: d.sender_vcsname,
  }, body);
}

export function parseCassoEvents(body: unknown): BankEvent[] | null {
  if (!record(body)) return null;
  if ('vqb_id' in body) {
    const event = normalize('CASSO', {
      id: body.vqb_id, amount: body.vqb_amount_in ?? body.vqb_amount,
      content: body.vqb_content_bank ?? body.vqb_content, date: body.vqb_date,
      direction: 'in', account: body.vqb_account_number,
      sender: body.vqb_sender_name, bank: body.vqb_sender_bank,
    }, body);
    return event ? [event] : null;
  }
  if (body.error !== 0 || (!Array.isArray(body.data) && !record(body.data))) return null;
  const records = Array.isArray(body.data) ? body.data : [body.data];
  if (!records.length || records.length > 100) return null;
  const events: BankEvent[] = [];
  for (const data of records) {
    if (!record(data)) return null;
    // Outgoing signed amounts never become customer credits.
    const negative = typeof data.amount === 'number' && data.amount < 0;
    const event = normalize('CASSO', {
      id: data.id, amount: negative ? Math.abs(data.amount as number) : data.amount,
      content: data.description, date: data.transactionDateTime ?? data.when,
      direction: negative ? 'out' : 'in',
      account: data.accountNumber ?? data.bank_sub_acc_id ?? data.subAccId,
      sender: data.counterAccountName ?? data.corresponsiveName,
      bank: data.counterAccountBankName ?? data.corresponsiveBankName,
    }, { error: 0, data });
    if (!event) return null;
    events.push(event);
  }
  return events;
}

export function parseCasso(body: unknown): BankEvent | null {
  const events = parseCassoEvents(body);
  return events?.length === 1 ? events[0] : null;
}

async function hmacHex(secret: string, text: string, hash: 'SHA-256' | 'SHA-512'): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// SePay official HMAC signs timestamp + '.' + exact raw request body.
export async function verifySePaySignature(rawBody: string, signature: string | null,
  secret: string, timestamp: string | null, now = Date.now()): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)
    || !timestamp || !/^\d{10}$/.test(timestamp)
    || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return safeEqual(await hmacHex(secret, timestamp + '.' + rawBody, 'SHA-256'), signature.slice(7).toLowerCase());
}

export function verifySePayApiKey(header: string | null, secret: string): boolean {
  return Boolean(secret && header?.startsWith('Apikey ') && safeEqual(header.slice(7), secret));
}

export async function verifyHmacSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!secret || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  return safeEqual(await hmacHex(secret, rawBody, 'SHA-256'), signature.toLowerCase());
}

export function verifyCassoToken(header: string | null, secret: string): boolean {
  return Boolean(secret && header && safeEqual(header, secret));
}

// Casso V2 signs the data object's top-level keys sorted A→Z.
// Contract: github.com/CassoHQ/casso-webhook-v2-verify-signature.
export async function verifyCassoSignature(body: unknown, signature: string | null,
  secret: string): Promise<boolean> {
  if (!secret || !record(body) || body.error !== 0 || !record(body.data) || !signature) return false;
  const parts = /^t=(\d{13}),v1=([0-9a-f]{128})$/i.exec(signature);
  // Casso replays signed events for up to24 hours. Keep its documented signature
  // contract; provider transaction identity supplies durable replay protection.
  if (!parts) return false;
  const data = body.data;
  const sorted = Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]]));
  return safeEqual(await hmacHex(secret, parts[1] + '.' + JSON.stringify(sorted), 'SHA-512'), parts[2].toLowerCase());
}

