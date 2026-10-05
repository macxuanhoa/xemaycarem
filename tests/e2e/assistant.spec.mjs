import { test, expect } from '@playwright/test'

const userId = '11111111-1111-4111-8111-111111111111'
const vehicleId = '22222222-2222-4222-8222-222222222222'
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2sAAAAASUVORK5CYII=', 'base64')
const vehicle = { id: vehicleId, internal_code: 'XE-TEST-000001', brand: 'Honda', model: 'SH160', frame_number: 'RLH-TEST-123',
  license_plate: '43A1-12345', status: 'IN_STOCK', purchase_date: '2026-09-30', asking_price: 93000000,
  year: 2024, color: 'Trắng', odometer: 18500, images: [], expenses: [], sales: [], activity: [] }
function draftResponse(task, draft) {
  return { kind: 'draft', task, vehicle_id: vehicleId, draft, human_confirmation_required: true,
    warnings: ['Kiểm tra lại số khung, xe và số tiền trước khi lưu.'] }
}
async function setup(page, { role = 'OWNER', result, status = 200 } = {}) {
  const calls = { assist: [], writes: [], storage: [] }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test',
    created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture-signature'
  await page.addInitScript(({ session }) => {
    localStorage.setItem('xe-remember', 'true')
    localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(session))
    window.SpeechRecognition = undefined
    window.webkitSpeechRecognition = undefined
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  await page.route('https://xe-test.supabase.co/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.postData() ? request.postDataJSON() : {}
    const reply = (value, replyStatus = 200) => route.fulfill({ status: replyStatus, contentType: 'application/json',
      body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (path === '/auth/v1/user') return reply(user)
    if (path === '/rest/v1/profiles') return reply({ id: userId, full_name: `Fixture ${role}`, username: `fixture_${role.toLowerCase()}`,
      role, active: true, can_view_financials: role === 'OWNER', must_change_password: false, deleted_at: null })
    if (path === '/functions/v1/ai-assist') {
      calls.assist.push(body)
      return reply(result ?? { kind: 'read_result', facts: { available: true, month: '2026-09', acquisitions_count: 4 }, source: 'authorized_database_rpc' }, status)
    }
    if (path.startsWith('/storage/')) { calls.storage.push(path); return reply({ error: 'UNEXPECTED_STORAGE_UPLOAD' }, 403) }
    const name = path.split('/').at(-1)
    if (name === 'check_user_access') return reply({ allowed: true, role, must_change_password: false })
    if (name === 'get_vehicle') return reply(vehicle)
    if (name === 'get_settings') return reply({ store_name: 'Xe CRM fixture', phone: '', address: '' })
    if (['list_vehicles', 'list_expenses', 'list_acquisitions'].includes(name)) return reply({ items: [], total: 0 })
    if (['save_expense', 'acquire_vehicle', 'sell_vehicle', 'add_payment'].includes(name)) { calls.writes.push({ name, body }); return reply(vehicleId) }
    return reply({ message: `Unexpected fixture request: ${path}` }, 400)
  })
  return calls
}
async function acceptProcessing(page) {
  await page.getByRole('checkbox', { name: /Cho phép gửi nội dung/ }).check()
}
async function selectImage(page) {
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: pixel })
  await expect(page.getByRole('img', { name: 'Ảnh đang chuẩn bị đọc' })).toBeVisible()
}
async function submitDraft(page) {
  // The auth bootstrap can remount /assist once while the session resolves,
  // which wipes local form state. Re-enter the image and consent if the
  // submit button never becomes enabled, so the assertion covers the settled
  // UI instead of a transient remount.
  const button = page.getByRole('button', { name: 'Chuẩn bị bản nháp', exact: true })
  for (let attempt = 1; ; attempt++) {
    await selectImage(page)
    await acceptProcessing(page)
    try {
      await expect(button).toBeEnabled({ timeout: 10000 })
      await button.click()
      return
    } catch (error) {
      if (attempt >= 2) throw error
    }
  }
}

test('assistant requires explicit consent, makes no provider calls on render and displays grounded counts', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assist')
  await expect(page.getByRole('heading', { name: /Hỏi (Cà Rem|Xe CRM) \/ Chuẩn bị bản nháp/ })).toBeVisible()
  await page.getByLabel('Câu hỏi', { exact: true }).fill('Tháng này thu bao nhiêu xe?')
  await expect(page.getByRole('button', { name: 'Tra cứu dữ liệu' })).toBeDisabled()
  expect(calls.assist).toHaveLength(0)
  await acceptProcessing(page)
  await page.getByRole('button', { name: 'Tra cứu dữ liệu' }).click()
  await expect(page.getByText('Xe thu trong kỳ', { exact: true })).toBeVisible()
  expect(calls.assist).toHaveLength(1)
  expect(calls.assist[0]).toMatchObject({ consent: true, task: 'business_question', text: 'Tháng này thu bao nhiêu xe?' })
  expect(calls.writes).toHaveLength(0)
})

test('unconfigured AI keeps ordinary manual entry and search available', async ({ page }) => {
  const calls = await setup(page, { status: 503, result: { error: 'AI_NOT_CONFIGURED', message: 'Chưa thể xử lý.' } })
  await page.goto('/assist')
  await page.getByLabel('Câu hỏi', { exact: true }).fill('Tồn kho bao nhiêu?')
  await acceptProcessing(page)
  await page.getByRole('button', { name: 'Tra cứu dữ liệu' }).click()
  await expect(page.getByText('Nếu dịch vụ chưa được bật, bạn vẫn có thể tìm xe và nhập biểu mẫu thông thường.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Thu xe bằng biểu mẫu' })).toBeVisible()
  expect(calls.writes).toHaveLength(0)
})

test('receipt capture stays transient and saves only after review in the existing expense form', async ({ page }) => {
  const calls = await setup(page, { result: draftResponse('receipt', { amount: 850000, date: '2026-09-30', merchant: 'Fixture', description: 'Thay lốp', expense_type: 'PARTS' }) })
  await page.goto(`/assist?task=receipt&vehicle=${vehicleId}`)
  await submitDraft(page)
  await expect(page.getByRole('heading', { name: 'Kiểm tra bản nháp' })).toBeVisible()
  expect(calls.writes).toHaveLength(0)
  expect(calls.storage).toHaveLength(0)
  await page.getByRole('button', { name: 'Kiểm tra chi phí cho xe đang chọn' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Số tiền chi (₫) *', { exact: true })).toHaveValue('850.000')
  await expect(dialog.getByLabel('Nội dung chi tiết *', { exact: true })).toHaveValue('Thay lốp')
  expect(calls.writes).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Lưu chi phí' }).click()
  await expect(dialog).toBeHidden()
  expect(calls.writes).toHaveLength(1)
  expect(calls.writes[0]).toMatchObject({ name: 'save_expense', body: { p_kind: 'vehicle', p_data: { vehicle_id: vehicleId, expense_type: 'PARTS', amount: 850000, description: 'Thay lốp' } } })
})

test('staff document draft opens a review form without financial fields or automatic acquisition', async ({ page }) => {
  const calls = await setup(page, { role: 'STAFF', result: draftResponse('vehicle_document', { frame_number: 'RLHNEW123', engine_number: 'E123', license_plate: '43A1-45678', brand: 'Honda', model: 'SH160', color: 'Trắng', year: 2024 }) })
  await page.goto('/assist?task=vehicle_document')
  await submitDraft(page)
  await page.getByRole('link', { name: 'Kiểm tra trong phiếu thu xe' }).click()
  await expect(page).toHaveURL(/\/acquisitions\/new$/)
  // The inline duplicate-chassis feedback extends the input's accessible name
  // ("Số khung Số khung chưa có trong hệ thống"), so match by prefix. Số
  // khung became an optional field in migration 20261005000000 — no asterisk.
  await expect(page.getByLabel(/^Số khung/)).toHaveValue('RLHNEW123')
  await expect(page.getByLabel('Giá thu (₫) *', { exact: true })).toHaveCount(0)
  expect(calls.writes).toHaveLength(0)
})

test('malicious provider text is displayed as escaped text and cannot run scripts', async ({ page }) => {
  const malicious = '<img src="x" onerror="window.__assistantInjected=1">'
  const calls = await setup(page, { result: draftResponse('receipt', { amount: 850000, date: null, merchant: null, description: malicious, expense_type: 'OTHER' }) })
  await page.goto(`/assist?task=receipt&vehicle=${vehicleId}`)
  await submitDraft(page)
  await expect(page.getByText(malicious, { exact: true })).toBeVisible()
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__assistantInjected)).toBeUndefined()
  expect(calls.writes).toHaveLength(0)
})

test('voice retains typed transcript fallback and returns a draft without business writes', async ({ page }) => {
  const calls = await setup(page, { result: draftResponse('voice', { intent: 'ADD_VEHICLE_EXPENSE', amount: 500000, description: 'Sửa thắng', expense_type: 'REPAIR', date: null }) })
  await page.goto(`/assist?task=voice&vehicle=${vehicleId}`)
  await page.getByRole('button', { name: 'Nhập giọng nói bằng trình duyệt' }).click()
  await page.getByLabel('Nội dung / ghi chú', { exact: true }).fill('Thêm 500 nghìn sửa thắng')
  await acceptProcessing(page)
  await page.getByRole('button', { name: 'Chuẩn bị bản nháp', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Kiểm tra bản nháp' })).toBeVisible()
  expect(calls.assist[0]).toMatchObject({ task: 'voice', vehicle_id: vehicleId, text: 'Thêm 500 nghìn sửa thắng' })
  expect(calls.writes).toHaveLength(0)
})
