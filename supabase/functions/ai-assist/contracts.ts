// Pure contracts shared by the Edge handler and local security tests.
export class AssistError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export type Caller = { rpc: (name: string, parameters?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
export type AccessProfile = { role: string; can_view_financials: boolean };
export const tasks = ['receipt', 'vehicle_document', 'vehicle_scan', 'license_plate', 'odometer', 'voice', 'business_question', 'copilot'] as const;
export type Task = typeof tasks[number];
// 'deterministic' answers come only from authorized read RPCs; 'llm' adds a
// provider-written summary on top of the same retrieved evidence (OWNER only).
export const copilotModes = ['deterministic', 'llm'] as const;
export type CopilotMode = typeof copilotModes[number];
export type AssistInput = { task: Task; consent: true; text?: string; vehicle_id?: string; mode?: CopilotMode; image?: { mime_type: string; base64: string } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const categories = ['REPAIR', 'TRANSPORT', 'PAPERWORK', 'PARTS', 'CLEANING', 'INSPECTION', 'OTHER'];
const queryKinds = ['inventory', 'acquisitions', 'sales', 'revenue', 'profit', 'aging', 'vehicle_search', 'vehicle_expenses', 'vehicle_history', 'unavailable'];
export const canManage = (p: AccessProfile) => ['OWNER', 'MANAGER'].includes(p.role);
export const canFinance = (p: AccessProfile) => p.role === 'OWNER' || (p.role === 'MANAGER' && p.can_view_financials);
const canOperate = (p: AccessProfile) => ['OWNER', 'MANAGER', 'STAFF'].includes(p.role);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistError(400, 'INVALID_INPUT');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new AssistError(400, 'INVALID_INPUT');
}
export function validateInput(value: unknown, profile: AccessProfile): AssistInput {
  const input = object(value);
  exactKeys(input, ['task', 'consent', 'text', 'vehicle_id', 'mode', 'image']);
  if (!tasks.includes(input.task as Task) || input.consent !== true) throw new AssistError(400, 'EXPLICIT_PROCESSING_CONSENT_REQUIRED');
  if (input.mode !== undefined && !copilotModes.includes(input.mode as CopilotMode)) throw new AssistError(400, 'INVALID_MODE');
  if (input.task === 'copilot') {
    if (input.mode !== undefined && input.mode !== 'deterministic' && profile.role !== 'OWNER') throw new AssistError(403, 'LLM_MODE_OWNER_ONLY');
  }
  if (input.vehicle_id !== undefined && (typeof input.vehicle_id !== 'string' || !uuid.test(input.vehicle_id))) throw new AssistError(400, 'INVALID_VEHICLE_ID');
  if (['receipt'].includes(String(input.task)) && !canManage(profile)) throw new AssistError(403, 'ACCESS_DENIED');
  if (['vehicle_document', 'vehicle_scan', 'voice'].includes(String(input.task)) && !canOperate(profile)) throw new AssistError(403, 'ACCESS_DENIED');
  if (input.task === 'copilot' && !canOperate(profile)) throw new AssistError(403, 'ACCESS_DENIED');
  if (['voice', 'business_question', 'copilot'].includes(String(input.task))) {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || input.image !== undefined) throw new AssistError(400, 'INVALID_TEXT');
  } else {
    if (input.text !== undefined) throw new AssistError(400, 'INVALID_INPUT');
    const image = object(input.image);
    exactKeys(image, ['mime_type', 'base64']);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(image.mime_type)) || typeof image.base64 !== 'string'
      || image.base64.length > 2_796_204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64) || image.base64.length % 4 !== 0) {
      throw new AssistError(400, 'INVALID_IMAGE');
    }
    let bytes: string;
    try { bytes = atob(image.base64); } catch { throw new AssistError(400, 'INVALID_IMAGE'); }
    if (bytes.length > 2_097_152 || bytes.length < 12) throw new AssistError(400, 'INVALID_IMAGE');
    const mime = image.mime_type;
    const valid = mime === 'image/jpeg' ? bytes.charCodeAt(0) === 255 && bytes.charCodeAt(1) === 216
      : mime === 'image/png' ? bytes.slice(0, 8) === '\x89PNG\r\n\x1a\n'
      : bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP';
    if (!valid) throw new AssistError(400, 'INVALID_IMAGE');
  }
  return input as AssistInput;
}

const nullableText = { type: ['string', 'null'] };
const nullableMoney = { type: ['integer', 'null'], minimum: 1, maximum: 1_000_000_000_000 };
const nullableDate = { type: ['string', 'null'] };
const category = { type: ['string', 'null'], enum: [...categories, null] };
function schema(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export function outputSchema(task: Task) {
  // The copilot never asks a model for a draft; it answers from retrieved evidence.
  if (task === 'copilot') throw new AssistError(400, 'INVALID_INPUT');
  if (task === 'receipt') return schema({ amount: nullableMoney, date: nullableDate, merchant: nullableText, description: nullableText, expense_type: category });
  if (task === 'vehicle_document') return schema({ frame_number: nullableText, engine_number: nullableText, license_plate: nullableText,
    brand: nullableText, model: nullableText, color: nullableText, year: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 } });
  // Smart Camera reads everything visible on one bike in one pass. `variant` and
  // `odometer` join the document fields so the intake form can be prefilled from
  // a single normalized result; every field stays nullable because the provider
  // must answer null for anything it cannot actually see.
  if (task === 'vehicle_scan') return schema({ license_plate: nullableText, frame_number: nullableText, engine_number: nullableText,
    brand: nullableText, model: nullableText, variant: nullableText, color: nullableText,
    year: { type: ['integer', 'null'], minimum: 1900, maximum: 2100 }, odometer: { type: ['integer', 'null'], minimum: 0, maximum: 10_000_000 } });
  if (task === 'license_plate') return schema({ license_plate: nullableText });
  if (task === 'odometer') return schema({ odometer: { type: ['integer', 'null'], minimum: 0, maximum: 10_000_000 } });
  if (task === 'voice') return schema({ intent: { type: 'string', enum: ['CREATE_ACQUISITION', 'ADD_VEHICLE_EXPENSE', 'PREPARE_SALE', 'UNKNOWN'] },
    frame_number: nullableText, license_plate: nullableText, brand: nullableText, model: nullableText, color: nullableText,
    purchase_price: nullableMoney, sale_price: nullableMoney, amount: nullableMoney, description: nullableText, expense_type: category, date: nullableDate });
  return schema({ kind: { type: 'string', enum: queryKinds }, month: nullableText, query: nullableText, vehicle_id: nullableText });
}
const textLimits: Record<string, number> = { frame_number: 100, engine_number: 100, license_plate: 30, brand: 80, model: 120, variant: 120, color: 80,
  merchant: 200, description: 1000, date: 10, month: 7, query: 100, vehicle_id: 36 };
export function validateOutput(task: Task, value: unknown, profile: AccessProfile): Record<string, unknown> {
  const result = object(value);
  const keys = Object.keys(outputSchema(task).properties);
  exactKeys(result, keys);
  if (keys.some((key) => !Object.hasOwn(result, key))) throw new AssistError(502, 'INVALID_AI_RESULT');
  for (const [key, field] of Object.entries(result)) {
    if (field === null) continue;
    if (textLimits[key] && (typeof field !== 'string' || field.length > textLimits[key])) throw new AssistError(502, 'INVALID_AI_RESULT');
    if (['amount', 'purchase_price', 'sale_price', 'year', 'odometer'].includes(key)) {
      const min = key === 'odometer' ? 0 : key === 'year' ? 1900 : 1;
      const max = key === 'year' ? 2100 : key === 'odometer' ? 10_000_000 : 1_000_000_000_000;
      if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < min || field > max) throw new AssistError(502, 'INVALID_AI_RESULT');
    }
    if (key === 'expense_type' && !categories.includes(String(field))) throw new AssistError(502, 'INVALID_AI_RESULT');
    if (key === 'date') {
      const parsed = typeof field === 'string' ? new Date(field + 'T00:00:00Z') : null;
      if (typeof field !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(field) || !parsed || !Number.isFinite(parsed.getTime())
        || parsed.toISOString().slice(0, 10) !== field) throw new AssistError(502, 'INVALID_AI_RESULT');
    }
  }
  if (task === 'voice') {
    if (!['CREATE_ACQUISITION', 'ADD_VEHICLE_EXPENSE', 'PREPARE_SALE', 'UNKNOWN'].includes(String(result.intent))) throw new AssistError(502, 'INVALID_AI_RESULT');
    if (result.intent === 'ADD_VEHICLE_EXPENSE' && !canManage(profile)) throw new AssistError(403, 'ACCESS_DENIED');
    if (result.purchase_price !== null && !canFinance(profile)) throw new AssistError(403, 'FINANCIAL_ACCESS_DENIED');
  }
  if (task === 'business_question') {
    if (!queryKinds.includes(String(result.kind)) || (result.month !== null && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(result.month)))
      || (result.vehicle_id !== null && !uuid.test(String(result.vehicle_id)))) throw new AssistError(502, 'INVALID_AI_RESULT');
    if (result.kind === 'profit' && !canFinance(profile)) throw new AssistError(403, 'FINANCIAL_ACCESS_DENIED');
    if (['revenue', 'vehicle_expenses'].includes(String(result.kind)) && !canManage(profile)) throw new AssistError(403, 'ACCESS_DENIED');
  }
  return result;
}

export async function readBusinessFacts(plan: Record<string, unknown>, caller: Caller, contextVehicleId?: string, today = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' }).formatToParts(today);
  const currentMonth = `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
  const month = String(plan.month ?? currentMonth);
  const [year, monthNumber] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = `${month}-${new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()}`;
  const vehicleId = contextVehicleId ?? (typeof plan.vehicle_id === 'string' ? plan.vehicle_id : undefined);
  let functionName: string;
  let parameters: Record<string, unknown>;
  if (plan.kind === 'unavailable') return { available: false, message: 'Câu hỏi này chưa được hỗ trợ. Dữ liệu chưa sẵn sàng.' };
  if (plan.kind === 'vehicle_search') {
    if (typeof plan.query !== 'string' || plan.query.trim().length < 2) throw new AssistError(400, 'SEARCH_REQUIRED');
    functionName = 'list_vehicles'; parameters = { p_filters: { search: plan.query.trim(), limit: 25 } };
  } else if (['vehicle_expenses', 'vehicle_history'].includes(String(plan.kind))) {
    if (!vehicleId) throw new AssistError(400, 'VEHICLE_CONTEXT_REQUIRED');
    functionName = 'get_vehicle'; parameters = { p_id: vehicleId };
  } else {
    functionName = 'dashboard'; parameters = { p_from: from, p_to: to };
  }
  // No provider-selected RPC name is executed. All reads use the caller's JWT.
  const { data, error } = await caller.rpc(functionName, parameters);
  if (error || !data || typeof data !== 'object') throw new AssistError(503, 'DATA_UNAVAILABLE');
  const record = data as Record<string, unknown>;
  if (plan.kind === 'vehicle_search') return { available: true, query: plan.query, matches: record.items, total: record.total, limit: 25 };
  if (plan.kind === 'vehicle_expenses') return { available: true, vehicle_id: vehicleId, expenses: record.expenses };
  if (plan.kind === 'vehicle_history') return { available: true, vehicle_id: vehicleId, history: record.activity };
  const fields: Record<string, string[]> = { inventory: ['in_stock', 'reserved'], acquisitions: ['acquisitions_count'], sales: ['sales_count'],
    revenue: ['revenue'], profit: ['gross_profit'], aging: ['old_inventory_count', 'aging', 'longest_stock'] };
  const selected = fields[String(plan.kind)];
  if (!selected || selected.some((key) => record[key] === undefined || record[key] === null)) throw new AssistError(503, 'DATA_UNAVAILABLE');
  return { available: true, month, ...Object.fromEntries(selected.map((key) => [key, record[key]])) };
}

/** Strict provider schema for the OWNER-only copilot summary: prose plus citation ids, nothing else. */
export function copilotSchema(allowedIds: string[]) {
  return {
    type: 'object',
    properties: {
      answer_markdown: { type: 'string' },
      citation_ids: { type: 'array', items: allowedIds.length ? { type: 'string', enum: allowedIds } : { type: 'string' }, maxItems: 20 },
      insufficient: { type: 'boolean' },
    },
    required: ['answer_markdown', 'citation_ids', 'insufficient'],
    additionalProperties: false,
  };
}

export type GroundedAnswer = { answer_markdown: string; citation_ids: string[]; insufficient: boolean };

/**
 * Reject a provider summary that cites unknown evidence, keeps an external link
 * or is not grounded at all. Citation ids must already exist in the retrieved
 * set, so every claim still points at a button the user can reopen.
 */
export function validateGroundedAnswer(value: unknown, allowedIds: string[]): GroundedAnswer {
  const result = object(value);
  exactKeys(result, ['answer_markdown', 'citation_ids', 'insufficient']);
  const known = new Set(allowedIds);
  const raw = typeof result.answer_markdown === 'string' ? result.answer_markdown.trim() : '';
  if (!raw || raw.length > 4000) throw new AssistError(502, 'INVALID_AI_RESULT');
  const cleaned = raw
    .replace(/\[([^\]]{1,160})\]\(([^)\s]{1,240})\)/g, (match, text: string, href: string) => (href.startsWith('/') && !href.startsWith('//') ? match : text))
    .replace(/https?:\/\/\S+/gi, '')
    .trim();
  if (!cleaned || cleaned.length > 4000) throw new AssistError(502, 'INVALID_AI_RESULT');
  const ids = Array.isArray(result.citation_ids) ? result.citation_ids : [];
  if (ids.length > 20 || ids.some((id) => typeof id !== 'string' || !known.has(id))) throw new AssistError(502, 'INVALID_AI_RESULT');
  const markers = [...cleaned.matchAll(/\[([a-z]{1,3}\d{1,3})\]/g)].map((marker) => marker[1]);
  if (markers.some((marker) => !known.has(marker))) throw new AssistError(502, 'INVALID_AI_RESULT');
  const insufficient = result.insufficient === true;
  if (!insufficient && !ids.length && !markers.length) throw new AssistError(502, 'INVALID_AI_RESULT');
  return { answer_markdown: cleaned, citation_ids: ids as string[], insufficient };
}
