import { describe, expect, it, vi } from 'vitest'
import { parseGeminiBody, scanPublicText, validateInput } from '../../supabase/functions/post-ai/contracts'
import { loadEdgeHandler } from '../helpers/edge-handler'

const vehicleId = '11111111-1111-4111-8111-111111111111'
const strangerId = '22222222-2222-4222-8222-222222222222'

// Bản chiếu Tier-A đúng như RPC get_post_studio_context trả: không giá thu,
// không ghi chú, không người bán — mọi assert "không rò rỉ" dựa trên hình này.
const tierAContext = {
  id: vehicleId, internal_code: 'CR-01', license_plate: '43D1-111.22', frame_number: 'RLH160KD0123456',
  vehicle_type: 'Xe tay ga', year: 2023, color: 'Đen', status: 'IN_STOCK',
  vehicle_title: '43D1-111.22', vehicle_subtitle: 'Xe tay ga • 2023 • Đen', listed_at: '2026-10-01T00:00:00Z',
  images: [{ id: strangerId, storage_path: `${vehicleId}/photo-1.jpg` }],
  store: { store_name: 'Cà Rem', phone: '0914929292', address: 'Hội An' },
  actor: vehicleId,
}
const matchedStock = {
  items: [{ id: vehicleId, license_plate: '43D1-111.22', vehicle_type: 'Xe tay ga', year: 2023, color: 'Đen',
    status: 'IN_STOCK', vehicle_title: '43D1-111.22', vehicle_subtitle: 'Xe tay ga • 2023 • Đen',
    images: [{ id: strangerId, storage_path: `${vehicleId}/photo-1.jpg` }] }],
  total: 1,
}
const safeCaptions = { captions: ['Vision 2023 đen nhám vừa về Cà Rem, ghé quán xem nhé.', 'Xe ngon inbox Cà Rem liền tay.'] }
const geminiBody = (result: unknown) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(result ?? safeCaptions) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60 },
})

function harness(options: {
  enabled?: boolean; result?: unknown; providerStatus?: number | number[]; contextError?: string; env?: Record<string, string>
} = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'check_user_access') return { data: { allowed: true, must_change_password: false }, error: null }
    if (name === 'list_brand_memory') return { data: { items: [
      { entry_type: 'EXAMPLE', content: 'Xe vừa về, ghé Cà Rem uống trà xem xe nha bà con.' },
      { entry_type: 'RULE', content: 'Không bao giờ nêu giá trong bài đăng.' },
    ] }, error: null }
    if (name === 'get_post_studio_context') return options.contextError ? { data: null, error: { message: options.contextError } } : { data: tierAContext, error: null }
    if (name === 'find_matching_vehicles') return { data: matchedStock, error: null }
    return { data: null, error: null }
  })
  const caller = { auth: { getUser: async () => ({ data: { user: { id: vehicleId } }, error: null }) }, rpc }
  const statuses = Array.isArray(options.providerStatus) ? options.providerStatus : [options.providerStatus ?? 200]
  let providerCalls = 0
  const provider = vi.fn(async () => {
    const status = statuses[Math.min(providerCalls, statuses.length - 1)]
    providerCalls += 1
    return new Response(JSON.stringify(status === 200 ? geminiBody(options.result) : { error: { message: 'quota' } }), { status })
  })
  const createClient = vi.fn(() => caller)
  const log = { info: vi.fn(), error: vi.fn() }
  const handler = loadEdgeHandler('supabase/functions/post-ai/index.ts', {
    env: {
      SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'test-public',
      ...(options.enabled !== false ? { POST_AI_ENABLED: 'true', GEMINI_API_KEY: 'test-gemini-key', GEMINI_MODEL: 'gemini-3.8-flash' } : {}),
      ...options.env,
    },
    createClient, fetch: provider, log,
  })
  const invoke = (body: Record<string, unknown>, token = true) => handler(new Request('https://example.test/post-ai', {
    method: 'POST', headers: { ...(token ? { Authorization: 'Bearer test-user-jwt' } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { invoke, provider, rpc, log }
}

const captionsInput = { task: 'captions', consent: true, vehicle_id: vehicleId, post_kind: 'NEW_STOCK', channel: 'FACEBOOK' }
const replyInput = { task: 'reply', consent: true, message: 'Con Vision đen còn không shop, cho xin giá với ảnh' }

describe('post-ai contracts block unsafe inputs before any provider call', () => {
  it('requires consent, exact keys and a real vehicle for everything except buy-back calls', () => {
    expect(() => validateInput({ ...captionsInput, consent: undefined })).toThrow('EXPLICIT_PROCESSING_CONSENT_REQUIRED')
    expect(() => validateInput({ ...captionsInput, consent: true, sql: 'drop table' })).toThrow('INVALID_INPUT')
    expect(() => validateInput({ task: 'captions', consent: true, post_kind: 'NEW_STOCK', channel: 'FACEBOOK' })).toThrow('VEHICLE_REQUIRED')
    expect(validateInput({ task: 'captions', consent: true, post_kind: 'BUYBACK', channel: 'ZALO' })).toMatchObject({ post_kind: 'BUYBACK' })
    expect(() => validateInput({ ...captionsInput, consent: true, post_kind: 'POLITICS' })).toThrow('INVALID_INPUT')
    expect(() => validateInput({ ...captionsInput, consent: true, vehicle_id: 'not-a-uuid' })).toThrow('INVALID_VEHICLE_ID')
  })
  it('bounds editing turns and keeps pasted customer text in its own lane', () => {
    const turns = Array.from({ length: 7 }, (_, i) => ({ role: 'user', text: `lần ${i}` }))
    expect(() => validateInput({ task: 'refine', consent: true, channel: 'FACEBOOK', caption: 'a', instruction: 'b', turns })).toThrow('INVALID_INPUT')
    expect(() => validateInput({ task: 'reply', consent: true, message: 'còn xe không', caption: 'trộm gắn field' })).toThrow('INVALID_INPUT')
    expect(() => validateInput({ task: 'reply', consent: true, message: 'x'.repeat(2001) })).toThrow('INVALID_INPUT')
    expect(validateInput({ task: 'refine', consent: true, channel: 'ZALO', caption: 'a', instruction: 'ngắn lại' })).toMatchObject({ task: 'refine' })
  })
  it('rejects prices, foreign phones, CCCD digits, URLs and financial vocabulary but keeps the hotline', () => {
    expect(scanPublicText('Xe giá 35 triệu rẻ lắm')).toContain('MONEY')
    expect(scanPublicText('giá thu bao nhiêu cũng được')).toContain('FINANCIAL_TERM')
    expect(scanPublicText('gọi qua https://facebook.com/groups/abc')).toContain('URL')
    expect(scanPublicText('alo 0988.123.456 nha')).toContain('PHONE')
    expect(scanPublicText('012345678901')).toContain('CCCD')
    expect(scanPublicText('ghé quán hoặc gọi 0914.92.92.92')).toEqual([])
    expect(scanPublicText('Vision 2023, biển 43D1-111.22, đen nhám')).toEqual([])
  })
  it('parses only complete Gemini candidates and flags safety-blocked answers', () => {
    expect(parseGeminiBody(geminiBody(safeCaptions))).toMatchObject({ inputTokens: 120, outputTokens: 60 })
    expect(() => parseGeminiBody({ candidates: [] })).toThrow('INVALID_AI_RESULT')
    expect(() => parseGeminiBody({ candidates: [{ content: { parts: [{ text: '{"captions":["a","b","c","d","e"]}' }] }, finishReason: 'SAFETY' }] }))
      .toThrow('AI_ANSWER_BLOCKED')
  })
})

describe('post-ai edge function keeps authority, money and quota outside the model', () => {
  it('denies missing authentication and refuses to call Gemini when the feature is not configured', async () => {
    expect((await harness().invoke(captionsInput, false)).status).toBe(401)
    const h = harness({ enabled: false })
    const response = await h.invoke(captionsInput)
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('AI_NOT_CONFIGURED')
    expect(h.provider).not.toHaveBeenCalled()
  })
  it('only ever uses the configured free-tier model and never auto-switches', async () => {
    const h = harness({ env: { GEMINI_MODEL: 'Gemini 3.1 Pro Preview!' } })
    const response = await h.invoke(captionsInput)
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('GEMINI_MODEL_INVALID')
    expect(h.provider).not.toHaveBeenCalled()
    const ok = harness()
    expect((await ok.invoke(captionsInput)).status).toBe(200)
    const [endpoint, init] = ok.provider.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toContain('/v1beta/models/gemini-3.8-flash:generateContent')
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-gemini-key' })
    expect(JSON.stringify(init.headers)).not.toContain('test-user-jwt')
  })
  it('grounds captions in the live Tier-A context and shares only APPROVED brand memory', async () => {
    const h = harness()
    const response = await h.invoke(captionsInput)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ task: 'captions', model: 'gemini-3.8-flash', requires_human_review: true, captions: safeCaptions.captions })
    expect(h.rpc.mock.calls.map(([name]) => name)).toEqual(['check_user_access', 'list_brand_memory', 'get_post_studio_context', 'log_post_ai_usage'])
    expect(h.rpc).toHaveBeenCalledWith('list_brand_memory', { p_filters: { status: 'APPROVED', limit: 12 } })
    // Khóa Gemini chỉ được phép xuất hiện ở header vận chuyển, không bao giờ trong prompt.
    const sent = String((h.provider.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    expect(sent).toContain('43D1-111.22')
    expect(sent).toContain('Không bao giờ nêu giá trong bài đăng.')
    expect(sent).not.toContain('test-user-jwt')
    expect(sent).not.toContain('test-gemini-key')
    expect(sent).not.toContain('storage_path')
    expect(sent).not.toContain('purchase_price')
    expect(h.rpc).toHaveBeenCalledWith('log_post_ai_usage', expect.objectContaining({ p_task: 'captions', p_input_tokens: 120, p_output_tokens: 60, p_outcome: 'OK' }))
  })
  it('blocks a model that smuggles a price into a public caption and meters it as BLOCKED', async () => {
    const h = harness({ result: { captions: ['Xe chỉ 35 triệu thôi nha.', 'Inbox Cà Rem nhé bà con.', 'Ghé quán xem thực tế.'] } })
    const response = await h.invoke(captionsInput)
    expect(response.status).toBe(502)
    expect((await response.json()).error).toBe('AI_OUTPUT_UNSAFE')
    expect(h.rpc).toHaveBeenCalledWith('log_post_ai_usage', expect.objectContaining({ p_outcome: 'BLOCKED' }))
  })
  it('refuses stale vehicles before touching the provider', async () => {
    const h = harness({ contextError: 'POST_STUDIO_VEHICLE_UNAVAILABLE' })
    const response = await h.invoke(captionsInput)
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('VEHICLE_UNAVAILABLE')
    expect(h.provider).not.toHaveBeenCalled()
  })
  it('answers customer messages with stock the caller is allowed to see and drops invented ids', async () => {
    const h = harness({ result: { intent: 'PRICE', analysis: 'Khách hỏi giá và ảnh', reply: 'Dạ xe còn ở Cà Rem, ghé quán xem xe và thương lượng trực tiếp nhé!', vehicle_ids: [strangerId, vehicleId] } })
    const response = await h.invoke({ ...replyInput })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ task: 'reply', intent: 'PRICE', vehicle_ids: [vehicleId] })
    expect(body.vehicles.map((item: { id: string }) => item.id)).toEqual([vehicleId])
    const sent = String((h.provider.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    expect(sent).not.toContain('storage_path')
    expect(sent).not.toContain('test-gemini-key')
    expect(h.rpc).toHaveBeenCalledWith('find_matching_vehicles', { p_query: replyInput.message, p_limit: 8 })
  })
  it('rejects an unknown intent instead of shipping an unclassified answer', async () => {
    const h = harness({ result: { intent: 'CLOSE_THE_DEAL', analysis: 'a', reply: 'b', vehicle_ids: [] } })
    expect((await h.invoke({ ...replyInput })).status).toBe(502)
  })
  it('treats Gemini 429 as quota without retrying and maps 5xx to a single retry', async () => {
    const quota = harness({ providerStatus: 429 })
    const response = await quota.invoke(captionsInput)
    expect(response.status).toBe(429)
    expect((await response.json()).error).toBe('GEMINI_QUOTA')
    expect(quota.provider).toHaveBeenCalledTimes(1)
    expect(quota.rpc).toHaveBeenCalledWith('log_post_ai_usage', expect.objectContaining({ p_outcome: 'QUOTA' }))
    const flaky = harness({ providerStatus: [503, 200] })
    expect((await flaky.invoke(captionsInput)).status).toBe(200)
    expect(flaky.provider).toHaveBeenCalledTimes(2)
    const down = harness({ providerStatus: 500 })
    expect((await down.invoke(captionsInput)).status).toBe(502)
    expect(down.provider).toHaveBeenCalledTimes(2)
  })
  it('throttles a runaway caller before spending free-tier budget', async () => {
    const h = harness()
    for (let i = 0; i < 10; i += 1) expect((await h.invoke(captionsInput)).status).toBe(200)
    const blocked = await h.invoke(captionsInput)
    expect(blocked.status).toBe(429)
    expect((await blocked.json()).error).toBe('POST_AI_RATE_LIMITED')
    expect(h.provider).toHaveBeenCalledTimes(10)
  })
})
