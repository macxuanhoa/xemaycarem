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
    if (['list_vehicles', 'list_acquisitions'].includes(name)) return reply({ items: [], total: 0 })
    if (name === 'validate_import_vehicles') { calls.validate.push(body); return reply(validate) }
    if (name === 'import_vehicles') {
      calls.imports.push(body)
      return reply({ imported_count: body.p_vehicles.length, vehicle_ids: body.p_vehicles.map(() => userId) })
    }
    if (name === 'acquire_vehicle') { calls.single.push(body); return reply(userId) }
    return reply({ items: [], total: 0 })
  })
  return calls
}

test('parses shorthand notes, requires review and imports the whole batch in one call', async ({ page }) => {
  const calls = await setupFixtures(page)
  await page.goto('/intake')
  await expect(page.getByRole('heading', { name: 'Thu xe tốc ký' })).toBeVisible()
  await page.locator('textarea.intake-notes').fill(
    'sh den bs 29b1-123.45 gia 18tr5\nwave rsx trang niemyet 12tr')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()

  const first = page.locator('.intake-entry').nth(0)
  await expect(first.getByLabel('Hãng xe')).toHaveValue('Honda')
  await expect(first.getByLabel('Dòng xe')).toHaveValue('SH')
  await expect(first.getByLabel('Biển số')).toHaveValue('29-B1 123.45')
  await expect(first.getByLabel('Màu sắc')).toHaveValue('Đen')
  await expect(first.getByLabel('Giá thu')).toHaveValue('18500000')
  await expect(first.getByText(/=\s*18\.500\.000/)).toBeVisible()
  const second = page.locator('.intake-entry').nth(1)
  await expect(second.getByLabel('Dòng xe')).toHaveValue('Wave RSX')
  await expect(second.getByLabel('Giá bán dự kiến')).toHaveValue('12000000')

  // Blocking: chassis and purchase price are missing, so nothing can be sent yet.
  await expect(page.getByRole('button', { name: /Thu 2 xe vào kho/ })).toBeDisabled()
  await first.getByLabel('Số khung').fill('RLH-E2E-001')
  await second.getByLabel('Số khung').fill('RLH-E2E-002')
  await second.getByLabel('Giá thu').fill('9tr5')
  await expect(page.getByRole('button', { name: /Thu 2 xe vào kho/ })).toBeEnabled()

  await page.getByRole('button', { name: /Thu 2 xe vào kho/ }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Xác nhận thu xe' }).click()

  await expect(page).toHaveURL(/\/acquisitions$/)
  expect(calls.validate).toHaveLength(1)
  expect(calls.imports).toHaveLength(1)
  expect(calls.single).toHaveLength(0) // never row-by-row writes: one atomic batch
  const rows = calls.imports[0].p_vehicles
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ brand: 'Honda', model: 'SH', frame_number: 'RLH-E2E-001',
    license_plate: '29-B1 123.45', color: 'Đen', purchase_price: 18500000 })
  expect(rows[1]).toMatchObject({ model: 'Wave RSX', frame_number: 'RLH-E2E-002', purchase_price: 9500000,
    asking_price: 12000000 })
})

test('learns a new abbreviation from an unrecognized token and reuses it on the next parse', async ({ page }) => {
  await setupFixtures(page)
  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('vision hg gia 10tr fk HG-01')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  const card = page.locator('.intake-entry').first()
  await expect(card.locator('.intake-token-chip')).toContainText('hg')

  await card.locator('.intake-token-chip').getByRole('button', { name: 'Học' }).click()
  const lesson = page.locator('.intake-lesson-form')
  await expect(lesson).toBeVisible()
  await lesson.getByLabel('Viết tắt').fill('hg')
  await lesson.getByLabel('Trường điền').selectOption('brand')
  await lesson.getByLabel('Thành').fill('Honda')
  await lesson.getByRole('button', { name: 'Lưu quy tắc' }).click()
  await expect(page.getByText(/Đã học: "hg"/)).toBeVisible()

  await page.getByRole('button', { name: 'Tách lại danh sách' }).click()
  await expect(page.locator('.intake-entry').first().getByLabel('Hãng xe')).toHaveValue('Honda')

  // The rule is persisted for this account and visible in the memory panel.
  await page.reload()
  await page.locator('.intake-dictionary summary').click()
  await expect(page.locator('.intake-rule-chip').filter({ hasText: 'hg' })).toContainText('Honda')
})

test('server-side duplicates block the batch before anything is saved', async ({ page }) => {
  const calls = await setupFixtures(page, { validate: { duplicates: [
    { index: 0, field: 'frame_number', value: 'X', message: 'Số khung đã tồn tại hoặc trùng trong file' }], errors: [] } })
  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('sh den gia 18tr fk RLH-DUP')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  await page.getByRole('button', { name: /Thu 1 xe vào kho/ }).click()
  await expect(page.locator('.intake-entry-issues li').first())
    .toContainText('Số khung đã tồn tại')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(calls.imports).toHaveLength(0)
})

test('staff without financial rights never sees or sends the purchase price', async ({ page }) => {
  const calls = await setupFixtures(page, { role: 'STAFF' })
  await page.goto('/intake')
  await page.locator('textarea.intake-notes').fill('vision den gia 20tr fk MH-01')
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  const card = page.locator('.intake-entry').first()
  await expect(card.getByLabel('Giá thu')).toHaveCount(0)
  await card.getByLabel('Giá bán dự kiến').fill('25tr')
  await page.getByRole('button', { name: /Thu 1 xe vào kho/ }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Xác nhận thu xe' }).click()
  expect(calls.imports).toHaveLength(1)
  const [row] = calls.imports[0].p_vehicles
  expect('purchase_price' in row).toBe(false)
  expect(row).toMatchObject({ brand: 'Honda', model: 'Vision', asking_price: 25000000 })
})

test('the shorthand recipe stays on screen above the paste box', async ({ page }) => {
  // A placeholder vanishes on the first keystroke, which is exactly when
  // someone mid-note needs to check how an abbreviation was spelled.
  await setupFixtures(page)
  await page.goto('/intake')
  const guide = page.locator('.intake-guide')
  await expect(guide).toBeVisible()
  await expect(guide.locator('.intake-guide-lines li')).toHaveCount(3)
  const [guideBox, notesBox] = await Promise.all([
    guide.boundingBox(),
    page.locator('textarea.intake-notes').boundingBox(),
  ])
  expect(guideBox.y + guideBox.height).toBeLessThanOrEqual(notesBox.y)

  // The sample must actually parse, or it teaches the wrong syntax.
  await page.getByRole('button', { name: 'Chèn mẫu 3 xe' }).click()
  const pasted = await page.locator('textarea.intake-notes').inputValue()
  expect(pasted.split(String.fromCharCode(10))).toHaveLength(3)
  await page.getByRole('button', { name: 'Tách thành danh sách' }).click()
  await expect(page.locator('.intake-entry')).toHaveCount(3)
  await expect(page.locator('.intake-notes-actions .muted')).toContainText('0 từ chưa nhận diện')
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
  const columns = await card.locator('.intake-entry-grid').evaluate((node) => {
    const fields = [...node.querySelectorAll(':scope > .field')]
    const left = fields[2].getBoundingClientRect()
    const right = fields[3].getBoundingClientRect()
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

