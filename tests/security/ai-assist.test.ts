import { describe, expect, it, vi } from 'vitest'
import { outputSchema, readBusinessFacts, validateInput, validateOutput } from '../../supabase/functions/ai-assist/contracts'
import { loadEdgeHandler } from '../helpers/edge-handler'

const owner = { role: 'OWNER', can_view_financials: true }
const staff = { role: 'STAFF', can_view_financials: false }
const vehicleId = '11111111-1111-4111-8111-111111111111'
const png = Buffer.from('\x89PNG\r\n\x1a\n' + 'test fixture bytes', 'latin1').toString('base64')
const inputImage = { mime_type: 'image/png', base64: png }
const plan = (kind: string) => ({ kind, month: '2026-09', query: null, vehicle_id: null })
const draft = (task: Parameters<typeof outputSchema>[0], values = {}) => ({
  ...Object.fromEntries(Object.keys(outputSchema(task).properties).map((key) => [key, null])), ...values,
})
function harness(options: { enabled?: boolean; role?: string; result?: Record<string, unknown>; rpcError?: boolean } = {}) {
  const caller = {
    auth: { getUser: async () => ({ data: { user: { id: vehicleId } }, error: null }) },
    from: () => {
      const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { role: options.role ?? 'OWNER', can_view_financials: true }, error: null }) }
      return chain
    },
    rpc: vi.fn(async (name: string) => name === 'check_user_access' ? { data: { allowed: true, must_change_password: false }, error: null }
      : { data: { gross_profit: 123, acquisitions_count: 4, in_stock: 5, reserved: 1 }, error: options.rpcError ? { message: 'unavailable' } : null }),
  }
  const provider = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(options.result ?? draft('receipt', { amount: 850000 })) }] }], usage: { input_tokens: 20, output_tokens: 10 } }), { status: 200 }))
  const createClient = vi.fn(() => caller)
  const log = { info: vi.fn(), error: vi.fn() }
  const handler = loadEdgeHandler('supabase/functions/ai-assist/index.ts', {
    env: { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'test-public', ...(options.enabled ? { AI_ENABLED: 'true', AI_PROVIDER_API_KEY: 'test-provider-key', AI_MODEL: 'configured-test-model' } : {}) },
    createClient, fetch: provider, log,
  })
  const invoke = (body: Record<string, unknown>, token = true) => handler(new Request('https://example.test/ai-assist', {
    method: 'POST', headers: { ...(token ? { Authorization: 'Bearer test-user-jwt' } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { invoke, provider, caller, log, createClient }
}

describe('AI drafts and read tools preserve authority outside the model', () => {
  it('requires explicit processing consent and rejects unknown instructions/unsafe images', () => {
    expect(() => validateInput({ task: 'receipt', image: inputImage }, owner)).toThrow('EXPLICIT_PROCESSING_CONSENT_REQUIRED')
    expect(() => validateInput({ task: 'receipt', consent: true, image: inputImage, sql: 'delete' }, owner)).toThrow('INVALID_INPUT')
    expect(() => validateInput({ task: 'receipt', consent: true, image: { mime_type: 'image/png', base64: Buffer.from('wrong bytes of file').toString('base64') } }, owner)).toThrow('INVALID_IMAGE')
    expect(() => validateInput({ task: 'receipt', consent: true, image: inputImage }, staff)).toThrow('ACCESS_DENIED')
  })
  it('validates financial amounts, dates, categories and exact extracted field sets', () => {
    expect(() => validateOutput('receipt', draft('receipt', { amount: -1 }), owner)).toThrow('INVALID_AI_RESULT')
    expect(() => validateOutput('receipt', draft('receipt', { date: '2026-02-30' }), owner)).toThrow('INVALID_AI_RESULT')
    expect(() => validateOutput('receipt', draft('receipt', { expense_type: 'SQL' }), owner)).toThrow('INVALID_AI_RESULT')
    expect(() => validateOutput('receipt', draft('receipt', { sql: 'arbitrary mutation' }), owner)).toThrow('INVALID_INPUT')
    expect(() => validateOutput('business_question', plan('profit'), staff)).toThrow('FINANCIAL_ACCESS_DENIED')
    expect(() => validateOutput('voice', draft('voice', { intent: 'ADD_VEHICLE_EXPENSE' }), staff)).toThrow('ACCESS_DENIED')
  })
  it('gates the smart camera vehicle_scan task on consent, role and exact image output', () => {
    expect(() => validateInput({ task: 'vehicle_scan', image: inputImage }, staff)).toThrow('EXPLICIT_PROCESSING_CONSENT_REQUIRED')
    expect(() => validateInput({ task: 'vehicle_scan', consent: true, text: 'xe vision đen' }, staff)).toThrow('INVALID_INPUT')
    expect(validateInput({ task: 'vehicle_scan', consent: true, image: inputImage }, staff)).toMatchObject({ task: 'vehicle_scan' })
    // Hợp đồng đầu ra chỉ còn đúng bốn trường nhìn được; loại xe do người chọn.
    expect(Object.keys(outputSchema('vehicle_scan').properties))
      .toEqual(['license_plate', 'frame_number', 'color', 'year'])
    // A STAFF scan is allowed (intake is an operational task) but extra keys never pass.
    expect(() => validateOutput('vehicle_scan', { ...draft('vehicle_scan'), purchase_price: 18000000 }, staff)).toThrow('INVALID_INPUT')
    // Tên trường đã xoá vĩnh viễn (08/10/2026) bị chặn ngay ở bước kiểm khoá,
    // kể cả khi model còn trả về theo khuôn cũ.
    for (const purged of [{ odometer: 99999999 }, { brand: 'Honda' }, { model: 'Vision' }, { variant: 'ABS' }, { engine_number: 'KF30E-7412345' }])
      expect(() => validateOutput('vehicle_scan', draft('vehicle_scan', purged), staff), JSON.stringify(purged)).toThrow('INVALID_INPUT')
    expect(() => validateOutput('vehicle_scan', draft('vehicle_scan', { year: 1850 }), staff)).toThrow('INVALID_AI_RESULT')
    expect(() => validateOutput('vehicle_scan', draft('vehicle_scan', { license_plate: 'X'.repeat(31) }), staff)).toThrow('INVALID_AI_RESULT')
    expect(validateOutput('vehicle_scan', draft('vehicle_scan', {
      license_plate: '59-A1 234.56', frame_number: 'RLH160KD12345', color: 'Đen', year: 2022,
    }), staff))
      .toMatchObject({ license_plate: '59-A1 234.56', frame_number: 'RLH160KD12345', color: 'Đen', year: 2022 })
  })
  it('executes only allowlisted read RPCs and uses database facts, preserving known vehicle context', async () => {
    const caller = { rpc: vi.fn(async (name: string) => { void name; return { data: { gross_profit: 123, expenses: [] }, error: null } }) }
    expect(await readBusinessFacts(plan('profit'), caller)).toMatchObject({ month: '2026-09', gross_profit: 123 })
    expect(caller.rpc).toHaveBeenCalledWith('dashboard', { p_from: '2026-09-01', p_to: '2026-09-30' })
    await readBusinessFacts({ ...plan('vehicle_expenses'), vehicle_id: '22222222-2222-4222-8222-222222222222' }, caller, vehicleId)
    expect(caller.rpc).toHaveBeenLastCalledWith('get_vehicle', { p_id: vehicleId })
    await expect(readBusinessFacts(plan('sell_vehicle'), caller)).rejects.toThrow('DATA_UNAVAILABLE')
    expect(caller.rpc.mock.calls.every(([name]) => ['dashboard', 'get_vehicle'].includes(name))).toBe(true)
  })
  it('returns unavailable when retrieval fails rather than inventing business numbers', async () => {
    const caller = { rpc: vi.fn(async () => ({ data: null, error: { message: 'offline' } })) }
    await expect(readBusinessFacts(plan('profit'), caller)).rejects.toThrow('DATA_UNAVAILABLE')
  })
  it('rejects missing authentication and returns 503 without provider configuration', async () => {
    const h = harness()
    expect((await h.invoke({ task: 'receipt', consent: true, image: inputImage }, false)).status).toBe(401)
    const response = await h.invoke({ task: 'receipt', consent: true, image: inputImage })
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('AI_NOT_CONFIGURED')
    expect(h.provider).not.toHaveBeenCalled()
  })
  it('returns reviewable drafts, uses store:false and never sends user JWT/database records to provider', async () => {
    const h = harness({ enabled: true })
    const response = await h.invoke({ task: 'receipt', consent: true, image: inputImage, vehicle_id: vehicleId })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'draft', human_confirmation_required: true, vehicle_id: vehicleId, draft: { amount: 850000 } })
    const request = h.provider.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(request[1].body))
    expect(body.store).toBe(false)
    expect(String(request[1].body)).not.toContain('test-user-jwt')
    expect(String(request[1].body)).not.toContain('gross_profit')
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain(png)
    expect(h.caller.rpc.mock.calls.every(([name]) => ['check_user_access', 'get_vehicle'].includes(name))).toBe(true)
  })
  it('denies a model request to see restricted profit and performs no business query', async () => {
    const h = harness({ enabled: true, role: 'STAFF', result: plan('profit') })
    expect((await h.invoke({ task: 'business_question', consent: true, text: 'Cho tôi lợi nhuận' })).status).toBe(403)
    expect(h.caller.rpc.mock.calls.map(([name]) => name)).toEqual(['check_user_access'])
  })
  it('answers business questions with authorized facts and no LLM-generated totals', async () => {
    const h = harness({ enabled: true, result: plan('acquisitions') })
    const response = await h.invoke({ task: 'business_question', consent: true, text: 'Tháng này thu bao nhiêu xe?' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'read_result', facts: { acquisitions_count: 4 }, source: 'authorized_database_rpc' })
    expect(h.createClient).toHaveBeenCalledTimes(1)
  })
})
