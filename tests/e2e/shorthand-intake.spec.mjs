import { test, expect } from '@playwright/test'

const userId = '11111111-1111-4111-8111-111111111111'
async function setupFixtures(page, { role = 'OWNER', validate = { duplicates: [], errors: [] } } = {}) {
  const calls = { validate: [], imports: [], single: [] }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test',
    created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture-signature'
  await page.addInitScript(({ session }) => {
    localStorage.setItem('xe-remember', 'true')
    localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(session))
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  await page.route('https://xe-test.supabase.co/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.postData() ? request.postDataJSON() : {}
    const reply = (value, status = 200) => route.fulfill({ status, contentType: 'application/json',
      body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (path === '/auth/v1/user') return reply(user)
    if (path === '/rest/v1/profiles') return reply({ id: userId, full_name: `Fixture ${role}`, username: `fixture_${role.toLowerCase()}`,
      role, active: true, can_view_financials: role === 'OWNER', must_change_password: false, deleted_at: null })
    const name = path.split('/').at(-1)
    if (name === 'check_user_access') return reply({ allowed: true, role, must_change_password: false })
    if (name === 'get_settings') return reply({ store_name: 'Cà Rem fixture', phone: '', address: '' })
    // Danh mục loại xe là nguồn cho bộ chọn "Loại xe" của từng thẻ; thiếu
    // stub mảng này thì mock rơi vào nhánh object và useVehicleTypes crash.
    if (name === 'list_vehicle_types') return reply([
      { id: 'vt-ga', name: 'Xe tay ga', vehicle_count: 0 },
      { id: 'vt-so', name: 'Xe số', vehicle_count: 0 },
      { id: 'vt-con', name: 'Xe côn tay', vehicle_count: 0 },
      { id: 'vt-dien', name: 'Xe điện', vehicle_count: 0 },
      { id: 'vt-chua', name: 'Chưa phân loại', vehicle_count: 0 },
    ])
    if (['list_vehicles', 'list_acquisitions'].includes(name)) return reply({ items: [], total: 0 })
    if (name === 'validate_import_vehicles') { calls.validate.push(body); return reply(validate) }
    if (name === 'import_vehicles') {
      calls.imports.push(body)
      const rows = body.p_vehicles.rows
      return reply({ imported_count: rows.length, vehicle_ids: rows.map(() => userId) })
    }
    if (name === 'acquire_vehicle') { calls.single.push(body); return reply(userId) }
    return reply({ items: [], total: 0 })
  })
  return calls
}

test('parses shorthand notes, requires a free-text type and imports the whole batch in one call', async ({ page }) => {
  const calls = await setupFixtures(page)
  await page.goto('/intake')
  await expect(page.getByRole('heading', { name: 'Thu xe tốc ký' })).toBeVisible()
  await page.locator('textarea.intake-notes').fill(
    'sh den bs 29b1-123.45 gia 18tr5\nwave rsx trang niemyet 12tr')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()

  // Hãng/Dòng xe/Giá bán dự kiến đã bị xoá khỏi hồ sơ — thẻ tốc ký chỉ còn
  // định danh Biển số · Số khung, phân loại bằng Loại xe (tên nhập tự do) và Giá thu.
  const first = page.locator('.intake-entry').nth(0)
  await expect(first.getByLabel('Biển số')).toHaveValue('29B1-123.45')
  await expect(first.getByLabel('Màu sắc')).toHaveValue('Đen')
  await expect(first.getByLabel('Giá thu')).toHaveValue('18.500.000')
  // The review card must confirm the amount it read, in words under the
  // committed field and in digits while shorthand is still being typed.
  await expect(first.getByText(/mười tám triệu năm trăm nghìn đồng/i)).toBeVisible()
  const priceField = first.getByLabel('Giá thu')
  await priceField.fill('19tr5')
  await expect(priceField).toHaveValue('19tr5')
  await expect(first.getByText(/19\.500\.000/)).toBeVisible()
  await priceField.fill('18.500.000')
  const second = page.locator('.intake-entry').nth(1)
  // Số tiền thứ hai của dòng (12tr) nay là GIÁ THU duy nhất của xe thứ hai —
  // hệ thống không còn giữ giá bán dự kiến.
  await expect(second.getByLabel('Màu sắc')).toHaveValue('Trắng')
  await expect(second.getByLabel('Giá thu')).toHaveValue('12.000.000')

  // Loại xe bắt buộc khi tạo hồ sơ, nên nút thu chưa mở được khi chưa nhập.
  const importButton = page.getByRole('button', { name: /Thu 2 xe vào kho/ })
  await expect(importButton).toBeDisabled()
  await first.getByLabel('Loại xe *').fill('Xe tay ga')
  await second.getByLabel('Loại xe *').fill('Xe số')
  await first.getByLabel('Số khung').fill('RLH-E2E-001')
  await second.getByLabel('Số khung').fill('RLH-E2E-002')
  await expect(importButton).toBeEnabled()

  await importButton.click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Xác nhận thu xe' }).click()

  await expect(page).toHaveURL(/\/acquisitions$/)
  expect(calls.validate).toHaveLength(1)
  expect(calls.imports).toHaveLength(1)
  expect(calls.single).toHaveLength(0) // never row-by-row writes: one atomic batch
  expect(calls.imports[0].p_vehicles.request_id).toMatch(/^[0-9a-f-]{36}$/)
  const rows = calls.imports[0].p_vehicles.rows
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ vehicle_type: 'Xe tay ga', frame_number: 'RLH-E2E-001',
    license_plate: '29B1-123.45', color: 'Đen', purchase_price: 18500000 })
  expect(rows[1]).toMatchObject({ vehicle_type: 'Xe số', frame_number: 'RLH-E2E-002',
    color: 'Trắng', purchase_price: 12000000 })
  for (const row of rows) {
    expect('brand' in row).toBe(false)
    expect('model' in row).toBe(false)
    expect('asking_price' in row).toBe(false)
  }
})

test('any role manages "Bộ nhớ viết tắt thu xe" in Settings and it feeds the next parse', async ({ page }) => {
  // Cơ chế "Học" ngay trên thẻ tốc ký đã được thay bằng trang Cài đặt —
  // nhân viên thường (STAFF) cũng thêm/xoá được quy tắc của chính mình.
  await setupFixtures(page, { role: 'STAFF' })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Bộ nhớ viết tắt thu xe' }).click()
  await expect(page.getByRole('heading', { name: 'Bộ nhớ viết tắt thu xe' })).toBeVisible()
  const form = page.locator('.settings-rule-form')
  await form.getByLabel('Viết tắt').fill('hg')
  await form.getByLabel('Trường điền').selectOption('vehicle_type')
  await form.getByLabel('Thành').fill('Xe tay ga')
  await form.getByRole('button', { name: 'Lưu quy tắc' }).click()
  await expect(page.locator('.intake-rule-chip').filter({ hasText: 'hg' })).toContainText('Xe tay ga')

  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('hg den gia 10tr fk HG-01')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  await expect(page.locator('.intake-entry').first().getByLabel('Loại xe *')).toHaveValue('Xe tay ga')
})

test('server-side duplicates block the batch before anything is saved', async ({ page }) => {
  const calls = await setupFixtures(page, { validate: { duplicates: [
    { index: 0, field: 'frame_number', value: 'X', message: 'Số khung đã tồn tại hoặc trùng trong file' }], errors: [] } })
  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('sh den gia 18tr fk RLH-DUP')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  const card = page.locator('.intake-entry').first()
  await card.getByLabel('Loại xe *').fill('Xe tay ga')
  await page.getByRole('button', { name: /Thu 1 xe vào kho/ }).click()
  // Lỗi server định trường được hiển thị ngay tại ô nhập tương ứng,
  // không còn dồn danh sách cảnh báo cuối thẻ.
  await expect(card.locator('.field-error'))
    .toContainText('Số khung đã tồn tại')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(calls.imports).toHaveLength(0)
})

test('every role types the intake price: staff sees Giá thu, sends it, and cannot skip it', async ({ page }) => {
  // Không còn ô giá bị che theo quyền — chính nhân viên thu xe là người bấm giá
  // thu, nên thẻ tốc ký luôn hiện ô này và bắt buộc phải có số (> 0).
  const calls = await setupFixtures(page, { role: 'STAFF' })
  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('vision den gia 20tr fk MH0123')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  const card = page.locator('.intake-entry').first()
  await expect(card.getByLabel('Giá thu')).toHaveCount(1)
  await card.getByLabel('Loại xe *').fill('Xe tay ga')

  // Bỏ giá thu thì nút lưu khóa lại kèm hướng dẫn bằng tiếng Việt.
  await card.getByLabel('Giá thu').fill('')
  await expect(page.getByRole('button', { name: /Thu 1 xe vào kho/ })).toBeDisabled()
  await expect(card.locator('.field-error')).toContainText('Nhập giá thu xe')
  await card.getByLabel('Giá thu').fill('20tr')

  await page.getByRole('button', { name: /Thu 1 xe vào kho/ }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Xác nhận thu xe' }).click()
  expect(calls.imports).toHaveLength(1)
  const [row] = calls.imports[0].p_vehicles.rows
  expect('asking_price' in row).toBe(false)
  expect('brand' in row).toBe(false)
  expect(row).toMatchObject({
    vehicle_type: 'Xe tay ga', frame_number: 'MH0123', color: 'Đen', purchase_price: 20_000_000,
  })
})

test('mobile review cards stay two-up, tappable and free of iOS zoom', async ({ page }) => {
  // Regression: the cards were one long single-column stack of 13px inputs,
  // so every field punched the viewport in on focus and three vehicles meant
  // scrolling ~6 screens.
  await setupFixtures(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('sh den bs 29b1-123.45 gia 18tr5\nex abs trang 27tr niemyet 32tr')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  const card = page.locator('.intake-entry').first()
  await expect(card).toBeVisible()

  // Short fields pair up; the identifier fields keep a full row to themselves.
  // "Loại xe *" spans the full first row, so the first two-column pair is now
  // Số khung · Biển số (fields[1] & fields[2]).
  const columns = await card.locator('.intake-entry-grid').evaluate((node) => {
    const fields = [...node.querySelectorAll(':scope > .field')]
    const left = fields[1].getBoundingClientRect()
    const right = fields[2].getBoundingClientRect()
    const wide = fields[0].getBoundingClientRect()
    const grid = node.getBoundingClientRect()
    return { sideBySide: Math.abs(left.top - right.top) < 2, wideSpansGrid: Math.abs(wide.width - grid.width) < 2 }
  })
  expect(columns).toEqual({ sideBySide: true, wideSpansGrid: true })

  // 16px floor on every control, including the nested autocomplete inputs.
  const small = await card.evaluate((node) =>
    [...node.querySelectorAll('input, textarea, select')]
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((size) => size < 16))
  expect(small).toEqual([])

  // Fingertip-sized actions.
  expect(await card.locator('.intake-remove').evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)

  // Nothing may hang off the edge of the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

