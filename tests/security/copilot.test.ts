import { describe, expect, it, vi } from 'vitest'
import { buildEvidence } from '../../supabase/functions/ai-assist/copilot'
import { detectPeriod, normalize } from '../../supabase/functions/ai-assist/copilot'
import { validateGroundedAnswer, validateInput } from '../../supabase/functions/ai-assist/contracts'
import { loadEdgeHandler } from '../helpers/edge-handler'

const owner = { role: 'OWNER', can_view_financials: true }
const staff = { role: 'STAFF', can_view_financials: false }
const vehicleId = '11111111-1111-4111-8111-111111111111'

/** Every RPC the deterministic copilot is allowed to call. Nothing else may appear. */
const READ_ONLY_RPCS = ['check_user_access', 'get_vehicle', 'search_knowledge', 'dashboard', 'list_vehicles', 'list_receivables', 'list_expenses', 'list_audit', 'list_profiles', 'get_settings']

const knowledgeRow = {
  id: '33333333-3333-4333-8333-333333333333', slug: 'operations-release-checklist', title: 'Checklist phát hành Cà Rem',
  section: 'Kiểm thử', audience: 'MANAGER', source_path: 'docs/OPERATIONS.md', rank: 0.61, excerpt: 'Chạy kiểm thử DB trước khi phát hành.',
}

function harness(options: { role?: 'OWNER' | 'STAFF'; enabled?: boolean; result?: Record<string, unknown> | null } = {}) {
  const caller = {
    auth: { getUser: async () => ({ data: { user: { id: vehicleId } }, error: null }) },
    from: () => {
      const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { role: options.role ?? 'OWNER', can_view_financials: true }, error: null }) }
      return chain
    },
    rpc: vi.fn(async (name: string) => {
      if (name === 'check_user_access') return { data: { allowed: true, must_change_password: false }, error: null }
      if (name === 'search_knowledge') return { data: [knowledgeRow], error: null }
      if (name === 'dashboard') {
        return { data: { in_stock: 7, reserved: 1, inventory_cost_pending: 0, acquisitions_count: 3, sales_count: 2, revenue: 120_000_000, gross_profit: 9_000_000, old_inventory_count: 2,
          longest_stock: [{ id: vehicleId, brand: 'Honda', model: 'Wave', license_plate: '59-B1 123', days_in_inventory: 71 }] }, error: null }
      }
      if (name === 'list_vehicles') return { data: { items: [{ id: vehicleId, brand: 'Honda', model: 'Wave', license_plate: '59-B1 123', asking_price: 25_000_000 }], total: 1 }, error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    }),
  }
  const provider = vi.fn(async () => new Response(JSON.stringify({
    status: 'completed', usage: { input_tokens: 30, output_tokens: 12 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(options.result ?? { answer_markdown: 'Cần kiểm tra thêm.', citation_ids: [], insufficient: true }) }] }],
  }), { status: 200 }))
  const createClient = vi.fn(() => caller)
  const handler = loadEdgeHandler('supabase/functions/ai-assist/index.ts', {
    env: { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'test-public',
      ...(options.enabled ? { AI_ENABLED: 'true', AI_PROVIDER_API_KEY: 'test-provider-key', AI_MODEL: 'configured-test-model' } : {}) },
    createClient, fetch: provider, log: { info: vi.fn(), error: vi.fn() },
  })
  const invoke = (body: Record<string, unknown>) => handler(new Request('https://example.test/ai-assist', {
    method: 'POST', headers: { Authorization: 'Bearer test-user-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { invoke, provider, caller, createClient }
}

describe('AI copilot input contract', () => {
  it('accepts text questions for any active operator and only two modes', () => {
    expect(validateInput({ task: 'copilot', consent: true, text: 'Còn bao nhiêu xe?' }, staff)).toMatchObject({ task: 'copilot' })
    expect(() => validateInput({ task: 'copilot', consent: true }, staff)).toThrow('INVALID_TEXT')
    expect(() => validateInput({ task: 'copilot', consent: true, text: 'x', image: { mime_type: 'image/png', base64: 'aa' } }, staff)).toThrow('INVALID_TEXT')
    expect(() => validateInput({ task: 'copilot', consent: true, text: 'abc', mode: 'auto' }, owner)).toThrow('INVALID_MODE')
    expect(() => validateInput({ task: 'copilot', consent: true, text: 'abc', role: 'OWNER' }, owner)).toThrow('INVALID_INPUT')
  })
  it('keeps LLM prose mode owner-only and never lets it become a write tool', () => {
    expect(() => validateInput({ task: 'copilot', consent: true, text: 'abc', mode: 'llm' }, staff)).toThrow('LLM_MODE_OWNER_ONLY')
    expect(validateInput({ task: 'copilot', consent: true, text: 'abc', mode: 'llm' }, owner).mode).toBe('llm')
    expect(() => validateInput({ task: 'copilot', consent: true, text: 'abc', vehicle_id: 'not-a-uuid' }, owner)).toThrow('INVALID_VEHICLE_ID')
  })
})

describe('AI copilot evidence grounding', () => {
  it('builds clickable evidence from read RPCs only, under the caller role', async () => {
    const rpc = vi.fn(async (name: string) => name === 'search_knowledge' ? { data: [knowledgeRow], error: null }
      : name === 'dashboard' ? { data: { in_stock: 7, reserved: 1 }, error: null } : { data: null, error: { message: 'no' } })
    const evidence = await buildEvidence('Còn bao nhiêu xe trong kho?', { rpc }, owner)
    expect(evidence.coverage).toBe('both')
    expect(evidence.insufficient).toBe(false)
    expect(evidence.facts.some((fact) => fact.display === '7 xe')).toBe(true)
    expect(evidence.citations.find((citation) => citation.type === 'document')).toMatchObject({ route: '/docs/operations-release-checklist' })
    for (const fact of evidence.facts) {
      expect(evidence.citations.map((citation) => citation.id)).toContain(fact.citation)
      expect(evidence.answer_markdown).toContain(`[${fact.citation}]`)
    }
    expect(rpc.mock.calls.map(([name]) => name).every((name) => READ_ONLY_RPCS.includes(name))).toBe(true)
  })

  it('hides figures it may not read instead of inventing them', async () => {
    const rpc = vi.fn(async (name: string) => name === 'dashboard'
      ? { data: { in_stock: 4, revenue: 500_000_000, gross_profit: null }, error: null }
      : { data: [], error: null })
    const evidence = await buildEvidence('Lợi nhuận tháng này bao nhiêu?', { rpc }, staff)
    expect(evidence.facts).toEqual([])
    expect(evidence.warnings.join(' ')).toContain('quyền cao hơn')
    expect(evidence.insufficient).toBe(true)
  })

  it('reads Vietnamese periods and accent-free keywords', () => {
    expect(normalize('Tồn kho')).toBe('ton kho')
    expect(detectPeriod('doanh thu tháng 9', new Date('2026-10-01T02:00:00Z'))).toMatchObject({ from: '2026-09-01', to: '2026-09-30', label: 'Tháng 09/2026' })
    expect(detectPeriod('báo cáo 2026-08', new Date('2026-10-01T02:00:00Z'))?.from).toBe('2026-08-01')
    expect(detectPeriod('hôm nay ra sao', new Date('2026-10-01T02:00:00Z'))).toMatchObject({ from: '2026-10-01' })
  })

  it('rejects AI prose that cites unknown evidence, links outside the app, or claims without proof', () => {
    expect(validateGroundedAnswer({ answer_markdown: 'Tồn 7 xe [m1]', citation_ids: ['m1'], insufficient: false }, ['m1']))
      .toMatchObject({ answer_markdown: 'Tồn 7 xe [m1]' })
    expect(() => validateGroundedAnswer({ answer_markdown: 'Tồn 7 xe [zz9]', citation_ids: ['zz9'], insufficient: false }, ['m1'])).toThrow('INVALID_AI_RESULT')
    expect(() => validateGroundedAnswer({ answer_markdown: 'Xem tại https://evil.test/x', citation_ids: [], insufficient: false }, [])).toThrow('INVALID_AI_RESULT')
    expect(() => validateGroundedAnswer({ answer_markdown: '', citation_ids: [], insufficient: true }, [])).toThrow('INVALID_AI_RESULT')
    expect(() => validateGroundedAnswer({ answer_markdown: 'Tự tin nhé', citation_ids: [], insufficient: false }, ['m1'])).toThrow('INVALID_AI_RESULT')
    expect(() => validateGroundedAnswer({ answer_markdown: 'a', citation_ids: ['m1'], insufficient: false, sql: 1 }, ['m1'])).toThrow('INVALID_INPUT')
    // External links are stripped; only internal routes survive as links.
    expect(validateGroundedAnswer({ answer_markdown: 'Xem [sổ nợ](/receivables) và [mở web](https://evil.test)', citation_ids: [], insufficient: true }, []))
      .toMatchObject({ answer_markdown: 'Xem [sổ nợ](/receivables) và mở web' })
  })
})

describe('AI copilot edge handler', () => {
  it('answers deterministically with no provider configured and never calls the model', async () => {
    const h = harness()
    const response = await h.invoke({ task: 'copilot', consent: true, text: 'Còn bao nhiêu xe trong kho?' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ kind: 'copilot', mode: 'deterministic', available: true })
    expect(body.citations.some((citation: { type: string }) => citation.type === 'document')).toBe(true)
    expect(h.provider).not.toHaveBeenCalled()
    expect(h.caller.rpc.mock.calls.map(([name]) => name).every((name: string) => READ_ONLY_RPCS.includes(name))).toBe(true)
  })

  it('refuses LLM mode for staff before touching the provider', async () => {
    const h = harness({ role: 'STAFF', enabled: true })
    const response = await h.invoke({ task: 'copilot', consent: true, text: 'Tồn kho bao nhiêu?', mode: 'llm' })
    expect(response.status).toBe(403)
    expect((await response.json()).error).toBe('LLM_MODE_OWNER_ONLY')
    expect(h.provider).not.toHaveBeenCalled()
    expect(h.caller.rpc.mock.calls.map(([name]) => name)).toEqual(['check_user_access'])
  })

  it('lets the owner add AI prose over the same evidence without sending credentials to the provider', async () => {
    const h = harness({ enabled: true, result: { answer_markdown: 'Quy trình kiểm thử có 4 bước [d1].', citation_ids: ['d1'], insufficient: false } })
    const response = await h.invoke({ task: 'copilot', consent: true, text: 'Còn bao nhiêu xe trong kho?', mode: 'llm' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.mode).toBe('llm')
    expect(body.answer_markdown).toContain('[d1]')
    expect(body.citations.map((citation: { id: string }) => citation.id)).toContain('d1')
    const sent = JSON.stringify(h.provider.mock.calls[0] ?? '')
    expect(sent).not.toContain('test-user-jwt')
    expect(JSON.stringify((h.createClient.mock.calls[0] as unknown[] | undefined) ?? [])).not.toContain('service_role')
  })

  it('falls back to the deterministic answer when the model cites evidence that does not exist', async () => {
    const h = harness({ enabled: true, result: { answer_markdown: 'Lợi nhuận 999 tỷ [zz9]', citation_ids: ['zz9'], insufficient: false } })
    const response = await h.invoke({ task: 'copilot', consent: true, text: 'Còn bao nhiêu xe trong kho?', mode: 'llm' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.mode).toBe('deterministic')
    expect(body.answer_markdown).not.toContain('999')
    expect(body.warnings.join(' ')).toContain('bị loại')
  })

  it('degrades to the grounded lookup when the provider is unavailable', async () => {
    const h = harness({ enabled: true })
    h.provider.mockRejectedValue(new Error('network down'))
    const response = await h.invoke({ task: 'copilot', consent: true, text: 'Còn bao nhiêu xe trong kho?', mode: 'llm' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'deterministic', available: true })
  })
})
