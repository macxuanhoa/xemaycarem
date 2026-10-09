import { test, expect } from '@playwright/test'

// Smart Camera vertical slice: an image (from the gallery fallback, so the
// spec needs no fake video device) → ai-assist `vehicle_scan` draft → secure
// list_vehicles lookup → either open the matched vehicle or hand a structured
// recognition result to the EXISTING Shorthand Intake for confirmed save.
const userId = '11111111-1111-4111-8111-111111111111'
const vehicleId = '22222222-2222-4222-8222-222222222222'
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2sAAAAASUVORK5CYII=', 'base64')
const known = { id: vehicleId, internal_code: 'XE-TEST-000001', vehicle_type_id: 'vt-ga', vehicle_type: 'Xe tay ga',
  frame_number: 'RLHTEST000001', license_plate: '59A1-234.56', status: 'IN_STOCK', purchase_date: '2026-10-01', year: 2022, color: 'Đen' }
function scanDraft(values) {
  // Hợp đồng `vehicle_scan` mới chỉ còn bộ four nhận diện: biển · khung · màu · đời.
  const empty = { license_plate: null, frame_number: null, color: null, year: null }
  return { kind: 'draft', task: 'vehicle_scan', vehicle_id: null, draft: { ...empty, ...values },
    human_confirmation_required: true, warnings: ['Kiểm tra lại từng trường trước khi lưu.'] }
}
async function setup(page, { result } = {}) {
  const calls = { assist: [], writes: [], storage: [] }
  // Rows created by import_vehicles, so later list_vehicles searches resolve
  // them exactly like the real substring-search RPC would.
  const imported = []
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test',
    created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture-signature'
  await page.addInitScript(({ session }) => {
    localStorage.setItem('xe-remember', 'true')
    localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(session))
    // E2E runs never download the real Tesseract WASM: on-device OCR is turned
    // off here so the cloud path stays the one under test.
    localStorage.setItem('xe_crm_smartcam_settings', JSON.stringify({ mode: 'scan', sound: true, autoOpen: false, localOcr: false, cloudMode: 'auto' }))
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  await page.route('https://xe-test.supabase.co/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    // Storage uploads arrive as multipart form data — only JSON bodies are parsed.
    const isJson = (request.headers()['content-type'] ?? '').includes('application/json')
    const body = request.postData() && isJson ? request.postDataJSON() : {}
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (path === '/auth/v1/user') return reply(user)
    if (path === '/rest/v1/profiles') return reply({ id: userId, full_name: 'Fixture Owner', username: 'fixture_owner',
      role: 'OWNER', active: true, can_view_financials: true, must_change_password: false, deleted_at: null })
    if (path === '/functions/v1/ai-assist') { calls.assist.push(body); return reply(result ?? scanDraft({ license_plate: '59A1-234.56' })) }
    if (path.startsWith('/storage/')) { calls.storage.push(path); return reply({ Path: 'fixture/scan.jpg' }) }
    const name = path.split('/').at(-1)
    if (name === 'check_user_access') return reply({ allowed: true, role: 'OWNER', must_change_password: false })
    if (name === 'get_settings') return reply({ store_name: 'Xe CRM fixture', phone: '', address: '' })
    if (name === 'list_vehicle_types') return reply([
      { id: 'vt-ga', name: 'Xe tay ga', vehicle_count: 1 },
      { id: 'vt-so', name: 'Xe số', vehicle_count: 0 },
      { id: 'vt-chua', name: 'Chưa phân loại', vehicle_count: 0 },
    ])
    if (name === 'get_vehicle') return reply(known)
    if (name === 'list_vehicles') {
      const search = String(body.p_filters?.search ?? '').toUpperCase()
      const all = [known, ...imported]
      const hay = row => `${row.license_plate ?? ''} ${row.frame_number ?? ''} ${row.internal_code ?? ''} ${row.color ?? ''} ${row.vehicle_type ?? ''}`.toUpperCase()
      const items = search ? all.filter(row => hay(row).includes(search)) : all
      return reply({ items, total: items.length })
    }
    if (name === 'validate_import_vehicles') { calls.writes.push({ name, body }); return reply({ duplicates: [], errors: [] }) }
    if (name === 'import_vehicles') {
      calls.writes.push({ name, body })
      // Mirror the real RPC: server-issued vehicle_ids aligned with row order.
      const rows = body.p_vehicles?.rows ?? []
      imported.push(...rows.map((row, i) => ({ ...row, id: `77777777-7777-4777-8777-77777777777${i}` })))
      return reply({ imported_count: rows.length, vehicle_ids: imported.slice(imported.length - rows.length).map(row => row.id) })
    }
    if (name === 'register_vehicle_image') { calls.writes.push({ name, body }); return reply({ id: '33333333-3333-4333-8333-333333333333' }) }
    return reply({ message: `Unexpected fixture request: ${path}` }, 400)
  })
  return calls
}
async function scanFromLibrary(page) {
  await page.getByRole('checkbox', { name: /Cho phép gửi ảnh đang chụp/ }).check()
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: 'scan.jpg', mimeType: 'image/jpeg', buffer: pixel })
}

test('smart camera: known plate scan resolves to the existing vehicle profile', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await expect(page.getByRole('heading', { name: 'Camera thông minh' })).toBeVisible()
  await scanFromLibrary(page)
  await expect(page.getByText(/Đã xác khớp xe trong kho: 59A1-234\.56 · RLHTEST000001/)).toBeVisible()
  const assist = calls.assist.find(entry => entry.task === 'vehicle_scan')
  expect(assist).toMatchObject({ consent: true })
  expect(typeof assist.image.base64).toBe('string')
  await page.getByRole('button', { name: 'Mở hồ sơ xe', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  // No write ever happened for a read-only identification.
  expect(calls.writes).toEqual([])
})

test('smart camera: unknown scan prefills the existing shorthand intake and saves only after confirmation', async ({ page }) => {
  const calls = await setup(page, { result: scanDraft({ license_plate: '61B1-777.77', color: 'Trắng', year: 2023 }) })
  await page.goto('/capture')
  await scanFromLibrary(page)
  await expect(page.getByText('Không tìm thấy xe này trong kho. Có thể là xe mới về.')).toBeVisible()
  await page.getByRole('button', { name: 'Thu xe mới', exact: true }).click()
  await expect(page).toHaveURL(/\/intake$/)
  // Structured handoff: fields land in the existing intake cards, marked for review.
  await expect(page.getByPlaceholder('59A1-234.56')).toHaveValue('61B1-777.77')
  await expect(page.getByText('Bản nháp từ Camera thông minh', { exact: false })).toBeVisible()
  await expect(page.locator('.fs-badge.warn').first()).toBeVisible()
  // Camera không còn đọc hãng/dòng xe, nên nhân viên phải nhập Loại xe
  // (ô tên tự do) ngay trên thẻ thì nút thu mới mở.
  await page.getByLabel('Loại xe *').fill('Xe tay ga')
  await page.getByRole('button', { name: /Thu 1 xe vào kho/ }).click()
  await page.getByRole('button', { name: 'Xác nhận thu xe' }).click()
  const imported = calls.writes.find(entry => entry.name === 'import_vehicles')
  const row = imported.body.p_vehicles.rows[0]
  expect(row).toMatchObject({ license_plate: '61B1-777.77', vehicle_type: 'Xe tay ga', color: 'Trắng', year: 2023 })
  expect('brand' in row).toBe(false)
  expect('model' in row).toBe(false)
  // The approved scan photo rides the normal secure upload path afterwards —
  // attached via the trusted vehicle_ids from THIS transaction, never a
  // substring re-search of the inventory.
  await expect(page.getByText(/Đã đính 1 ảnh camera/)).toBeVisible()
  expect(calls.storage.length).toBeGreaterThan(0)
  expect(calls.writes.filter(entry => entry.name === 'import_vehicles')).toHaveLength(1)
  const photoRegistrations = calls.writes.filter(entry => entry.name === 'register_vehicle_image')
  expect(photoRegistrations.map(entry => entry.body.p_vehicle_id)).toEqual(['77777777-7777-4777-8777-777777777770'])
})

test('smart camera: refusal to send images keeps every field manual', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: 'scan.jpg', mimeType: 'image/jpeg', buffer: pixel })
  await expect(page.getByText(/Bật đồng ý gửi ảnh/)).toBeVisible()
  expect(calls.assist).toEqual([])
})
