import { test, expect } from '@playwright/test'

// Runtime proof for the local scanning layer: a real Chromium page boots the
// actual Tesseract worker + WASM core (served from /tesseract/) + language
// data, reads a genuinely rendered plate image with real OCR, resolves it in
// the mocked inventory and never contacts ai-assist. A production build only
// proves the files exist — this proves they load and compute. The language
// model comes from jsDelivr; if the sandbox has no CDN reachability the OCR
// engine degrades to "unavailable" and this spec skips with that reason.
const userId = '11111111-1111-4111-8111-111111111111'
const vehicleId = '22222222-2222-4222-8222-222222222222'
const known = { id: vehicleId, internal_code: 'XE-TEST-000001', vehicle_type_id: 'vt-ga', vehicle_type: 'Xe tay ga',
  frame_number: 'RLHTEST000001', license_plate: '59A1-234.56', status: 'IN_STOCK', purchase_date: '2026-10-01', year: 2022, color: 'Đen' }

test('smart camera runtime: real WASM OCR reads a rendered plate with zero cloud calls', async ({ page }) => {
  test.setTimeout(240_000)
  const calls = { assist: [], tesseract: [], cdn: [] }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test',
    created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture-signature'
  await page.addInitScript(({ session }) => {
    localStorage.setItem('xe-remember', 'true')
    localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(session))
    // On-device OCR ON, cloud fully OFF: nothing may reach the provider.
    localStorage.setItem('xe_crm_smartcam_settings', JSON.stringify({ mode: 'photo', sound: true, autoOpen: false, localOcr: true, cloudMode: 'off' }))
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/tesseract/')) calls.tesseract.push({ path: url.pathname, status: response.status() })
    if ((url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com') && url.pathname.includes('traineddata')) calls.cdn.push(url.pathname)
  })
  await page.route('https://xe-test.supabase.co/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const isJson = (request.headers()['content-type'] ?? '').includes('application/json')
    const body = request.postData() && isJson ? request.postDataJSON() : {}
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (path === '/auth/v1/user') return reply(user)
    if (path === '/rest/v1/profiles') return reply({ id: userId, full_name: 'Fixture Owner', username: 'fixture_owner',
      role: 'OWNER', active: true, can_view_financials: true, must_change_password: false, deleted_at: null })
    if (path === '/functions/v1/ai-assist') { calls.assist.push(body); return reply({ error: 'cloud must never be called' }, 500) }
    const name = path.split('/').at(-1)
    if (name === 'check_user_access') return reply({ allowed: true, role: 'OWNER', must_change_password: false })
    if (name === 'get_settings') return reply({ store_name: 'Xe CRM fixture', phone: '', address: '' })
    if (name === 'list_vehicles') {
      const search = String(body.p_filters?.search ?? '').toUpperCase()
      const hay = row => `${row.license_plate ?? ''} ${row.frame_number ?? ''} ${row.internal_code ?? ''} ${row.color ?? ''} ${row.vehicle_type ?? ''}`.toUpperCase()
      const items = search ? [known].filter(row => hay(row).includes(search)) : [known]
      return reply({ items, total: items.length })
    }
    return reply({ message: `Unexpected fixture request: ${path}` }, 400)
  })
  await page.goto('/capture')
  await expect(page.getByRole('heading', { name: 'Camera thông minh' })).toBeVisible()

  // Render a large clean plate image in the browser and feed it as a file —
  // the same pixels a phone camera would deliver, minus the blur.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1400
    canvas.height = 400
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 200px Arial, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText('59A1-234.56', 60, 210)
    return canvas.toDataURL('image/png')
  })
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64')
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: 'plate.png', mimeType: 'image/png', buffer })

  // Real recognition over the real engine — or an honest environment skip.
  const matched = page.getByText(/Đã xác khớp xe trong kho: 59A1-234\.56 · RLHTEST000001/)
  const degraded = page.getByText('OCR trên máy không tải được — dùng ảnh thư viện, AI hoặc nhập tay')
  await Promise.race([
    matched.waitFor({ timeout: 200_000 }),
    degraded.waitFor({ timeout: 200_000 }),
    page.getByText('Ảnh này chưa đọc được gì — thử rõ hơn hoặc nhập tay.').waitFor({ timeout: 200_000 }),
  ]).catch(() => {})
  if (await degraded.isVisible())
    test.skip(true, 'Tesseract runtime could not load in this environment (language data CDN unreachable) — live check, not a code failure')
  if (await page.getByText('Ảnh này chưa đọc được gì').isVisible())
    expect(await matched.textContent(), 'local OCR produced no readable plate from a clean rendered image').toBeTruthy()

  await expect(matched).toBeVisible()
  // The engine status line reports the worker as ready, and the WASM assets
  // were actually served from the same origin.
  await expect(page.getByText('OCR trên máy: sẵn sàng', { exact: false })).toBeVisible()
  expect(calls.tesseract.filter(entry => entry.path.endsWith('worker.min.js'))).toHaveLength(1)
  // The LSTM core is served from our own /tesseract/core/ (worker.min.js and
  // the core loader arrive as *.wasm.js — the binary comes with them).
  expect(calls.tesseract.some(entry => entry.path.startsWith('/tesseract/core/')), JSON.stringify(calls.tesseract)).toBe(true)
  expect(calls.tesseract.every(entry => entry.status === 200)).toBe(true)
  expect(calls.cdn.length).toBeGreaterThan(0) // traineddata fetched once
  // Hard cost proof: the paid provider was never contacted for this scan.
  expect(calls.assist).toEqual([])
})
