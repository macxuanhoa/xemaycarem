import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

let db
test.beforeAll(async () => { db = await createDatabase({ engine: 'postgres' }) })
test.afterAll(async () => { await db?.close() })

test('stale due-date and expense editors reject overwrites; reopening uses the current revision', async ({ page }) => {
  const ids = { owner: randomUUID(), colleague: randomUUID() }
  const { day, next } = (await db.query('SELECT private.today()::text AS day,(private.today()+7)::text AS next')).rows[0]
  for (const [name, id] of Object.entries(ids)) {
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `due-${id}@example.test`, JSON.stringify({ full_name: `Due test ${name}` })])
    await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name === 'owner' ? 'OWNER' : 'STAFF', id])
  }
  const call = (actor, name, args = '', values = []) => asUser(db, ids[actor], c => rpc(c, name, args, values))
  const vehicleId = await call('owner', 'save_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), vehicle_type: 'Xe số', purchase_date: day, purchase_price: 80 })])
  const saleId = await call('colleague', 'sell_vehicle', '$1::jsonb', [JSON.stringify({ vehicle_id: vehicleId, customer_name: 'Due-date UI synthetic customer', sale_price: 100, sale_date: day, initial_payment: 20 })])
  const original = await call('owner', 'get_sale', '$1::uuid', [saleId])
  const authUser = { id: ids.owner, aud: 'authenticated', role: 'authenticated', email: `due-${ids.owner}@example.test`, created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} }
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: ids.owner, exp: expiresAt })).toString('base64url')}.test`
  const session = { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user: authUser }
  await page.addInitScript(value => localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(value)), session)
  const dueRequests = []
  const expenseRequests = []
  await page.route('https://xe-test.supabase.co/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.postDataJSON() ?? {}
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (url.pathname === '/auth/v1/user') return reply(authUser)
    const connection = await db.connection()
    try {
      const result = await asUser(connection, ids.owner, async c => {
        if (url.pathname === '/rest/v1/profiles') return (await c.query('SELECT * FROM public.profiles WHERE id=$1', [ids.owner])).rows[0]
        if (!url.pathname.startsWith('/rest/v1/rpc/')) throw new Error(`Unhandled test endpoint ${url.pathname}`)
        const name = url.pathname.split('/').at(-1)
        if (name === 'save_expense') expenseRequests.push(body)
        if (name === 'update_sale_due_date') {
          dueRequests.push(body)
          // The HTTP boundary sends the actual overload arguments to PostgreSQL.
          return rpc(c, name, '$1::uuid,$2::date,$3::timestamptz', [body.p_sale_id, body.p_due_date, body.p_expected_updated_at])
        }
        const signatures = (await c.query("SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name])).rows
        const entries = Object.entries(body)
        const types = signatures.map(({ args }) => Object.fromEntries(args.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean).map(pair => {
          const cleaned = pair.replace(/\s+DEFAULT\s+.*$/i, '').trim()
          const space = cleaned.indexOf(' ')
          return [cleaned.slice(0, space), cleaned.slice(space + 1)]
        }))).find(candidate => entries.every(([key]) => candidate[key]))
        if (!types) throw new Error(`RPC signature missing: ${name}`)
        const sql = entries.map(([key], index) => `${key}=>$${index + 1}::${types[key]}`).join(',')
        return rpc(c, name, sql, entries.map(([key, value]) => types[key] === 'jsonb' ? JSON.stringify(value) : value))
      })
      return reply(result)
    } catch (error) { return reply({ code: error.code ?? 'TEST', message: error.message }, 400) }
    finally { await connection.close() }
  })

  await page.goto('/receivables')
  await page.getByRole('button', { name: 'Hẹn ngày', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hẹn ngày thanh toán' })).toBeVisible()
  await page.getByRole('button', { name: '+3 ngày', exact: true }).click()
  await call('colleague', 'update_sale_due_date', '$1::uuid,$2::date,$3::timestamptz', [saleId, next, original.updated_at])
  const auditBefore = Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_SALE_DUE_DATE'", [saleId])).rows[0].n)
  await page.getByRole('button', { name: 'Lưu hạn trả', exact: true }).click()
  await expect(page.getByText('Giao dịch đã được cập nhật. Hạn trả của bạn chưa được lưu; hãy đóng, tải lại danh sách công nợ và đối chiếu trước khi sửa tiếp.')).toBeVisible()
  expect(dueRequests).toHaveLength(1)
  expect(dueRequests[0].p_expected_updated_at).toBe(original.updated_at)
  expect((await call('owner', 'get_sale', '$1::uuid', [saleId])).due_date).toBe(next)
  expect(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_SALE_DUE_DATE'", [saleId])).rows[0].n)).toBe(auditBefore)

  await page.getByRole('button', { name: 'Đóng', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Đổi ngày hẹn trả', exact: true }).click()
  await page.getByRole('button', { name: 'Xóa hạn thanh toán', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Xóa hạn thanh toán', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Hẹn ngày thanh toán' })).toBeHidden()
  expect(dueRequests).toHaveLength(2)
  expect(dueRequests[1].p_due_date).toBeNull()
  expect(dueRequests[1].p_expected_updated_at).not.toBe(original.updated_at)
  const final = await call('owner', 'get_sale', '$1::uuid', [saleId])
  expect(final.due_date).toBeNull()
  expect(final.paid_amount).toBe(20)
  expect(final.remaining_amount).toBe(80)

  const expenseData = { category: 'OTHER', description: 'Expense UI synthetic conflict', amount: 100, expense_date: day }
  const expenseId = await call('owner', 'save_expense', '$1::text,$2::jsonb', ['business', JSON.stringify(expenseData)])
  const expenseOriginal = (await db.query('SELECT to_jsonb(e) AS data FROM public.business_expenses e WHERE id=$1', [expenseId])).rows[0].data
  await page.goto('/expenses?kind=business')
  await page.getByRole('button', { name: `Sửa chi phí ${expenseData.description}`, exact: true }).click()
  await page.getByRole('textbox', { name: 'Số tiền (₫) *', exact: true }).fill('130')
  await call('owner', 'save_expense', '$1::text,$2::jsonb,$3::uuid', ['business', JSON.stringify({ ...expenseData, amount: 160, expected_updated_at: expenseOriginal.updated_at }), expenseId])
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click()
  await expect(page.getByText('Chi phí đã được người khác cập nhật. Thay đổi của bạn chưa được lưu; hãy đóng, tải lại danh sách và đối chiếu trước khi sửa tiếp.')).toBeVisible()
  expect(expenseRequests).toHaveLength(1)
  expect(expenseRequests[0].p_data.expected_updated_at).toBe(expenseOriginal.updated_at)
  expect(Number((await db.query('SELECT amount FROM public.business_expenses WHERE id=$1', [expenseId])).rows[0].amount)).toBe(160)
  await page.getByRole('button', { name: 'Đóng biểu mẫu chi phí', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: `Sửa chi phí ${expenseData.description}`, exact: true }).click()
  await page.getByRole('textbox', { name: 'Số tiền (₫) *', exact: true }).fill('180')
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Chỉnh sửa chi phí cửa hàng', exact: true })).toBeHidden()
  expect(expenseRequests).toHaveLength(2)
  expect(expenseRequests[1].p_data.expected_updated_at).not.toBe(expenseOriginal.updated_at)
  expect(Number((await db.query('SELECT amount FROM public.business_expenses WHERE id=$1', [expenseId])).rows[0].amount)).toBe(180)
})
