import { test, expect } from '@playwright/test'

const userId = '11111111-1111-4111-8111-111111111111'
async function setup(page, { role = 'OWNER', unavailable = false } = {}) {
  const calls = { reports: [], digests: 0, businessWrites: [] }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'runtime@example.test', created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture-signature'
  await page.addInitScript(({ session }) => {
    localStorage.setItem('xe-remember', 'true')
    localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(session))
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  await page.route('https://xe-test.supabase.co/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    const body = request.postData() ? request.postDataJSON() : {}
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (path === '/auth/v1/user') return reply(user)
    if (path === '/rest/v1/profiles') return reply({ id: userId, username: 'runtime_fixture', full_name: 'Runtime Fixture', role, active: true, must_change_password: false, deleted_at: null, can_view_financials: role === 'OWNER' })
    const name = path.split('/').at(-1)
    if (name === 'check_user_access') return reply({ allowed: true, role, must_change_password: false })
    if (name === 'get_settings') return reply({ store_name: 'Xe Máy Cà Rem', phone: '', address: '' })
    if (name === 'get_seasonal_theme') return reply({ mode: 'DEFAULT', tet_start: null, tet_end: null, cinematic_enabled: false, is_active: false })
    if (name === 'list_notifications') return reply({ items: [], total: 0, unread_count: 0 })
    if (name === 'list_active_announcements') return reply([])
    if (name === 'report_client_issue') { calls.reports.push(body.p_data); return reply({ recorded: true }) }
    if (name === 'list_client_issues') {
      calls.digests++
      if (unavailable) return reply({ code: 'PGRST202', message: 'Could not find the function public.list_client_issues' }, 404)
      return reply({ days: 7, total_occurrences: 3, items: [{ source: 'global', code: 'JS_ERROR', operation: 'global', route: '/settings', release: '1.0.0', environment: 'production', occurrences: 3, first_seen: '2026-10-09T10:00:00Z', last_seen: '2026-10-09T11:00:00Z' }] })
    }
    calls.businessWrites.push({ name, body })
    return reply({ message: `Unexpected fixture operation ${name}` }, 400)
  })
  return calls
}

test('runtime monitoring: reports safe global errors, deduplicates and loads OWNER digest only in Device tab', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/settings?CCCD=079123456789&token=PRIVATE-TOKEN')
  await expect(page.getByRole('heading', { name: 'Hồ sơ của bạn' })).toBeVisible()
  expect(calls.digests).toBe(0)
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE CUSTOMER 079123456789', filename: 'https://private.test/vehicle/PRIVATE-ID?token=PRIVATE-TOKEN', error: new Error('PRIVATE STACK') }))
  })
  await expect.poll(() => calls.reports.length, { timeout: 15000 }).toBe(1)
  expect(Object.keys(calls.reports[0]).sort()).toEqual(['code', 'environment', 'operation', 'release', 'route', 'source'])
  expect(calls.reports[0]).toMatchObject({ source: 'global', code: 'JS_ERROR', operation: 'global', route: '/settings' })
  expect(JSON.stringify(calls.reports)).not.toMatch(/PRIVATE|079123456789|token|stack|filename|message/)
  await page.getByRole('button', { name: 'Ứng dụng & Dữ liệu', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Theo dõi hoạt động' })).toBeVisible()
  await expect(page.getByText('Lỗi ứng dụng', { exact: true })).toBeVisible()
  expect(calls.digests).toBe(1)
  await expect(page.getByText('JS_ERROR · 1.0.0 · production', { exact: false })).toBeHidden()
  await page.getByText('Chi tiết kỹ thuật', { exact: true }).click()
  await expect(page.getByText('JS_ERROR · 1.0.0 · production', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click()
  await expect.poll(() => calls.digests).toBe(2)
  expect(calls.businessWrites).toEqual([])
})

for (const role of ['STAFF', 'MANAGER']) test(`runtime monitoring: ${role} has no OWNER diagnostics card or digest request`, async ({ page }) => {
  const calls = await setup(page, { role })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Ứng dụng & Dữ liệu', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Luôn sẵn sàng trên thiết bị' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Theo dõi hoạt động' })).toHaveCount(0)
  expect(calls.digests).toBe(0)
  expect(calls.businessWrites).toEqual([])
})

test('runtime monitoring: unavailable backend shows a retrieval error instead of a healthy zero count', async ({ page }) => {
  const calls = await setup(page, { unavailable: true })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Ứng dụng & Dữ liệu', exact: true }).click()
  await expect(page.getByText('Chức năng chưa được đồng bộ với cơ sở dữ liệu.', { exact: false })).toBeVisible()
  await expect(page.getByText('Chưa ghi nhận sự cố trong khoảng thời gian này.', { exact: true })).toHaveCount(0)
  expect(calls.reports).toEqual([])
  expect(calls.businessWrites).toEqual([])
})
