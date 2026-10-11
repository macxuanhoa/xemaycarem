import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as adapter from '../../supabase/functions/bank-webhook/adapter'

function webhook(env: Record<string, string> = {}, fetcher = vi.fn<typeof fetch>()) {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const source = readFileSync('supabase/functions/bank-webhook/index.ts', 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(compiled, {
    exports: {}, require: () => adapter, Response, Request, TextDecoder, Uint8Array,
    AbortSignal, fetch: fetcher,
    Deno: { env: { get: (name: string) => env[name] }, serve: (callback: typeof handler) => { handler = callback } },
  })
  return { handle: (request: Request) => handler!(request), fetcher }
}
const body = { id: 92704, transferAmount: 5000000, transferType: 'in',
  content: 'CAREM GD01001', transactionDate: '2026-10-11 09:00:00', accountNumber: '123456789' }
const post = (data: unknown = body, headers: Record<string, string> = {}) => new Request('https://synthetic.test/bank-webhook',
  { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
const configuration = { SUPABASE_URL: 'https://database.synthetic.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-only',
  BANK_WEBHOOK_SEPAY_API_KEY: 'synthetic-provider-key' }

describe('bank webhook authenticated persistence boundary', () => {
  it('unsigned requests never reach the database even with service credentials', async () => {
    const worker = webhook(configuration)
    const result = await worker.handle(post())
    expect(result.status).toBe(401)
    expect(await result.json()).toEqual({ status: 'UNAUTHORIZED' })
    expect(worker.fetcher).not.toHaveBeenCalled()
  })

  it('genuine SePay API-key requests pass exact amount/account to service-only RPC with neutral ack', async () => {
    for (const outcome of ['MATCHED_PENDING', 'UNMATCHED', 'MANUAL_REVIEW', 'RECORDED']) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: outcome, amount: 5000000, secret: 'never-return' })))
      const result = await webhook(configuration, fetcher).handle(post(body, { Authorization: 'Apikey synthetic-provider-key' }))
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({ success: true })
      expect(result.headers.get('Cache-Control')).toBe('no-store')
      expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).p_data)
        .toMatchObject({ amount: '5000000', direction: 'in', account_number: '123456789', provider_txn_id: '92704' })
    }
  })

  it('verifies timestamped SePay signatures against exact raw body before persistence', async () => {
    const raw = JSON.stringify(body), at = String(Math.floor(Date.now() / 1000)), secret = 'synthetic-hmac'
    const signature = 'sha256=' + createHmac('sha256', secret).update(at + '.' + raw).digest('hex')
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'))
    const worker = webhook({ ...configuration, BANK_WEBHOOK_SEPAY_API_KEY: '', BANK_WEBHOOK_SEPAY_SECRET: secret }, fetcher)
    const valid = await worker.handle(post(body, { 'X-SePay-Signature': signature, 'X-SePay-Timestamp': at }))
    expect(valid.status).toBe(200)
    const forged = await worker.handle(post({ ...body, transferAmount: 6000000 }, { 'X-SePay-Signature': signature, 'X-SePay-Timestamp': at }))
    expect(forged.status).toBe(401)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('authenticated debits are acknowledged without writing a bank credit', async () => {
    const worker = webhook(configuration)
    const result = await worker.handle(post({ ...body, transferType: 'out' }, { Authorization: 'Apikey synthetic-provider-key' }))
    expect(await result.json()).toEqual({ success: true })
    expect(worker.fetcher).not.toHaveBeenCalled()
  })

  it('malformed, oversized and missing database configuration fail without fabricated receipt', async () => {
    const worker = webhook({ BANK_WEBHOOK_SEPAY_API_KEY: 'synthetic-provider-key' })
    const noDatabase = await worker.handle(post(body, { Authorization: 'Apikey synthetic-provider-key' }))
    expect(noDatabase.status).toBe(503)
    expect(await noDatabase.json()).toEqual({ status: 'NOT_CONFIGURED' })
    const bad = await worker.handle(post({ ...body, transferAmount: '-5000000' }, { Authorization: 'Apikey synthetic-provider-key' }))
    expect(bad.status).toBe(400)
    const large = await worker.handle(post({ padding: 'x'.repeat(128 * 1024) }))
    expect(large.status).toBe(413)
    expect(worker.fetcher).not.toHaveBeenCalled()
  })

  it('database rejection and timeouts never expose financial payload or acknowledge persistence', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message: 'private amount5000000' }), { status: 400 })),
      vi.fn<typeof fetch>(async () => { throw new Error('secret synthetic-service-only') }),
    ]) {
      const result = await webhook(configuration, fetcher).handle(post(body, { Authorization: 'Apikey synthetic-provider-key' }))
      expect(result.status).toBe(500)
      expect(await result.json()).toEqual({ status: 'INGEST_FAILED' })
    }
  })

  it('Casso secure-token batches persist every valid credit and skip outgoing transfers', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'))
    const worker = webhook({ ...configuration, BANK_WEBHOOK_CASSO_TOKEN: 'synthetic-casso' }, fetcher)
    const result = await worker.handle(post({ error: 0, data: [
      { id: 1, amount: 100, description: 'memo', when: '2026-10-11 09:00:00', bank_sub_acc_id: '123456789' },
      { id: 2, amount: -200, when: '2026-10-11 09:00:00', bank_sub_acc_id: '123456789' },
      { id: 3, amount: 300, when: '2026-10-11 09:00:00', bank_sub_acc_id: '123456789' },
    ] }, { 'secure-token': 'synthetic-casso' }))
    expect(await result.json()).toEqual({ success: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1]!.signal).toBe(fetcher.mock.calls[1][1]!.signal)
  })

  it('health includes generic HMAC readiness while revealing no secrets', async () => {
    const worker = webhook({ SUPABASE_URL: configuration.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: configuration.SUPABASE_SERVICE_ROLE_KEY,
      BANK_WEBHOOK_HMAC_SECRET: 'synthetic-hidden' })
    const result = await worker.handle(new Request('https://synthetic.test/bank-webhook'))
    expect(await result.json()).toEqual({ status: 'CONFIGURED' })
    expect(worker.fetcher).not.toHaveBeenCalled()
  })
})

