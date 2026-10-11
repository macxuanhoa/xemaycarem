import { test, expect } from '@playwright/test'

const userId = '11111111-1111-4111-8111-111111111111'
const vehicleId = '22222222-2222-4222-8222-222222222222'

const evidence = {
  kind: 'copilot',
  mode: 'deterministic',
  available: true,
  coverage: 'both',
  period: 'Tháng 09/2026',
  facts: [{ label: 'Xe đang tồn kho', value: 7, display: '7 xe', citation: 'm2' }],
  citations: [
    { id: 'd1', type: 'document', label: 'Checklist phát hành Cà Rem', detail: 'Kiểm thử', route: '/docs/operations-release-checklist' },
    { id: 'm2', type: 'metric', label: 'Xe đang tồn kho', detail: 'Tháng 09/2026', route: '/vehicles' },
    { id: 'v3', type: 'vehicle', label: 'Honda SH160', detail: '43A1-12345', route: `/vehicles/${vehicleId}` },
  ],
  doc_excerpts: [{ id: 'd1', title: 'Checklist phát hành Cà Rem', section: 'Kiểm thử', excerpt: 'Chạy npm run check:db trước khi phát hành.' }],
  answer_markdown: 'Số liệu kỳ **Tháng 09/2026**:\n- Xe đang tồn kho: **7 xe** [m2]\nTài liệu liên quan:\n- **Checklist phát hành Cà Rem — Kiểm thử** [d1]',
  suggestions: [{ label: 'Mở danh sách xe', route: '/vehicles' }],
  insufficient: false,
  warnings: [],
}

async function setup(page, { role = 'OWNER', result = evidence, status = 200, assistGate } = {}) {
  const calls = { assist: [], writes: [] }
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
    const reply = (value, replyStatus = 200) => route.fulfill({ status: replyStatus, contentType: 'application/json',
      body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    if (path === '/auth/v1/user') return reply(user)
    if (path === '/rest/v1/profiles') return reply({ id: userId, full_name: `Fixture ${role}`, username: `fixture_${role.toLowerCase()}`,
      role, active: true, can_view_financials: role === 'OWNER', must_change_password: false, deleted_at: null })
    if (path === '/functions/v1/ai-assist') {
      calls.assist.push(body)
      if (assistGate) await assistGate
      return reply(result, status)
    }
    const name = path.split('/').at(-1)
    if (request.method() === 'POST' && ['save_vehicle', 'sell_vehicle', 'save_expense', 'acquire_vehicle', 'add_payment'].includes(name)) {
      calls.writes.push({ name, body }); return reply(vehicleId)
    }
    if (name === 'check_user_access') return reply({ allowed: true, role, must_change_password: false })
    if (name === 'get_settings') return reply({ store_name: 'Xe CRM fixture', phone: '', address: '' })
    if (name === 'list_knowledge') return reply({ items: [
      { slug: 'operations-release-checklist', title: 'Checklist phát hành Cà Rem', section: 'Kiểm thử', audience: 'MANAGER', source_path: 'docs/OPERATIONS.md' },
      { slug: 'readme-gioi-thieu', title: 'Giới thiệu Cà Rem', section: null, audience: 'ALL', source_path: 'README.md' },
    ], total: 2 })
    if (name === 'search_knowledge') return reply([{ slug: 'operations-release-checklist', title: 'Checklist phát hành Cà Rem', section: 'Kiểm thử',
      audience: 'MANAGER', source_path: 'docs/OPERATIONS.md', rank: 0.6, excerpt: 'Chạy npm run check:db trước khi phát hành.' }])
    if (name === 'get_knowledge_article') return reply({ slug: 'operations-release-checklist', title: 'Checklist phát hành Cà Rem', section: 'Kiểm thử',
      audience: 'MANAGER', source_path: 'docs/OPERATIONS.md', updated_at: '2026-09-30T00:00:00Z',
      body_md: '## Kiểm thử\n- Chạy `npm run check:db`\n\nXem [sổ nợ](/receivables) và [web ngoài](https://evil.test).' })
    if (name === 'dashboard') return reply({ in_stock: 7, reserved: 1, longest_stock: [] })
    if (['list_vehicles', 'list_expenses', 'list_acquisitions', 'list_sales'].includes(name)) return reply({ items: [], total: 0 })
    return reply({ message: `Unexpected fixture request: ${path}` }, 400)
  })
  return calls
}

test('AI mode lives in the sidebar and every claim opens its own evidence', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/')
  // The AI section is collapsed by default and expands via its toggle.
  await expect(page.getByRole('link', { name: /Hỏi AI Cà Rem/ })).toBeHidden()
  await page.getByRole('button', { name: /TRỢ LÝ AI/ }).click()
  await expect(page.getByRole('link', { name: /Hỏi AI Cà Rem/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Tài liệu cửa hàng/ })).toBeVisible()
  await page.getByRole('link', { name: /Hỏi AI Cà Rem/ }).click()
  await expect(page).toHaveURL(/\/copilot$/)

  await page.getByLabel('Bạn muốn hỏi gì về cửa hàng?').fill('Còn bao nhiêu xe trong kho?')
  await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
  const fact = page.locator('.copilot-facts li').filter({ hasText: 'Xe đang tồn kho' })
  await expect(fact).toBeHidden()
  await expect(page.getByText(/Tồn kho là số xe hiện tại/)).toBeVisible()
  await page.locator('.copilot-evidence > summary').click()
  await expect(fact).toBeVisible()
  await expect(fact.getByText('7 xe')).toBeVisible()
  expect(calls.assist[0]).toMatchObject({ task: 'copilot', consent: true, mode: 'deterministic', text: 'Còn bao nhiêu xe trong kho?' })
  expect(calls.writes).toHaveLength(0)

  // Source names replace opaque IDs without changing destinations.
  await expect(page.locator('.copilot-answer').getByRole('link', { name: 'Mở nguồn Số liệu: Xe đang tồn kho' })).toBeVisible()
  await page.locator('.citation-list').getByRole('link', { name: 'Mở nguồn Xe: Honda SH160' }).click()
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
})

test('the answer keeps its document evidence readable inside the app', async ({ page }) => {
  await setup(page)
  await page.goto('/copilot')
  await page.getByLabel('Bạn muốn hỏi gì về cửa hàng?').fill('Checklist phát hành có gì?')
  await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
  await page.locator('.copilot-answer').getByRole('link', { name: 'Mở nguồn Tài liệu: Checklist phát hành Cà Rem' }).click()
  await expect(page).toHaveURL(/\/docs\/operations-release-checklist$/)
  await expect(page.getByRole('heading', { name: 'Kiểm thử' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'sổ nợ' })).toHaveAttribute('href', '/receivables')
  // External URLs are never turned into links by the answer renderer.
  await expect(page.locator('a[href="https://evil.test"]')).toHaveCount(0)
})

test('only the owner can switch on AI prose mode', async ({ page }) => {
  // A shared device can retain the owner's setting; STAFF still requests direct lookup.
  await page.addInitScript(() => localStorage.setItem('carem-copilot-mode', 'llm'))
  const calls = await setup(page, { role: 'STAFF' })
  await page.goto('/copilot')
  await expect(page.getByRole('checkbox', { name: /Bật AI viết câu tóm tắt/ })).toHaveCount(0)
  await expect(page.getByText(/Chỉ chủ cửa hàng bật được/)).toBeVisible()
  await page.getByLabel('Bạn muốn hỏi gì về cửa hàng?').fill('Tồn kho bao nhiêu?')
  await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
  expect(calls.assist[0]).toMatchObject({ mode: 'deterministic' })
})

test('pending lookup locks the composer and a repeated submit sends one read-only request', async ({ page }) => {
  let release
  const assistGate = new Promise(resolve => { release = resolve })
  const calls = await setup(page, { assistGate })
  await page.goto('/copilot')
  const editor = page.getByLabel('Bạn muốn hỏi gì về cửa hàng?')
  const suggestions = page.getByRole('group', { name: 'Câu hỏi gợi ý', exact: true })
  await expect(suggestions.getByRole('button')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Đơn bán gần đây?' })).toBeHidden()
  await editor.fill('Còn bao nhiêu xe trong kho?')
  try {
    await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
    await expect(editor).toBeDisabled()
    await expect(suggestions.getByRole('button').first()).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: /Bật AI viết câu tóm tắt/ })).toBeDisabled()
    await page.locator('.copilot-composer form').evaluate(form => form.requestSubmit())
    await expect.poll(() => calls.assist.length).toBe(1)
    expect(calls.writes).toHaveLength(0)
  } finally {
    release()
  }
  await expect(page.locator('.copilot-question-echo')).toContainText('Còn bao nhiêu xe trong kho?')
  await expect(editor).toBeEnabled()
  await expect(page.locator('.copilot-evidence')).not.toHaveAttribute('open')
  expect(calls.assist).toHaveLength(1)
})

test('copilot failures keep the ordinary pages usable and write nothing', async ({ page }) => {
  const calls = await setup(page, { status: 403, result: { error: 'LLM_MODE_OWNER_ONLY', message: 'Chỉ chủ cửa hàng bật được chế độ AI.' } })
  await page.goto('/copilot')
  await page.getByLabel('Bạn muốn hỏi gì về cửa hàng?').fill('Lợi nhuận tháng 9?')
  await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
  await expect(page.getByText(/Chỉ chủ cửa hàng bật được chế độ AI/)).toBeVisible()
  await expect(page.getByRole('link', { name: /Tồn kho/ })).toBeVisible()
  expect(calls.writes).toHaveLength(0)
})

test('hostile AI text stays escaped and cannot execute', async ({ page }) => {
  const injected = '<img src="x" onerror="window.__copilotInjected=1">'
  await setup(page, { result: { ...evidence, answer_markdown: `Cảnh báo: ${injected}` } })
  await page.goto('/copilot')
  await page.getByLabel('Bạn muốn hỏi gì về cửa hàng?').fill('Có rủi ro gì không?')
  await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
  await expect(page.getByText(injected).first()).toBeVisible()
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__copilotInjected)).toBeUndefined()
})

test('document index lists only the sections the caller may read', async ({ page }) => {
  await setup(page)
  await page.goto('/docs')
  // Shelves collapse to keep the page short, so open the OPS shelf first.
  await page.locator('summary.docs-category-title', { hasText: 'Vận hành & Phát hành' }).click()
  await expect(page.getByRole('link', { name: /Checklist phát hành Cà Rem/ })).toBeVisible()
  await expect(page.getByText('2 phần tài liệu bạn được đọc')).toBeVisible()
  await page.getByRole('link', { name: /Checklist phát hành Cà Rem/ }).click()
  await expect(page.getByRole('heading', { name: 'Checklist phát hành Cà Rem' })).toBeVisible()
})

test('unresolved expense plate opens a reviewed draft and closing clears it before another expense', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/copilot')
  await page.getByLabel('Bạn muốn hỏi gì về cửa hàng?').fill('chi 500k thay nhớt cho xe 59B1-123.45')
  await page.getByRole('button', { name: 'Hỏi Cà Rem' }).click()
  await expect(page.getByText(/Chưa khớp được xe với biển số 59B1-123.45/)).toBeVisible()
  await page.getByRole('button', { name: 'Kiểm tra & lưu chi phí', exact: true }).click()
  await expect(page).toHaveURL(/\/expenses$/)
  await expect(page.getByRole('heading', { name: 'Thêm chi phí xe', exact: true })).toBeVisible()
  await expect(page.getByLabel('Tìm xe', { exact: true })).toHaveValue('59B1-123.45')
  await expect(page.getByLabel('Số tiền (₫) *', { exact: true })).toHaveValue('500.000')
  await expect(page.getByLabel('Nội dung chi phí *', { exact: true })).toHaveValue('thay nhớt')
  await expect(page.getByText(/Bản nháp gợi ý từ Cà Rem AI Copilot/)).toBeVisible()
  await page.getByRole('button', { name: 'Lưu chi phí', exact: true }).click()
  await expect(page.getByText('Chọn xe cần ghi nhận chi phí.', { exact: true })).toBeVisible()
  expect(calls.writes).toEqual([])
  await page.getByRole('button', { name: 'Đóng biểu mẫu chi phí', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Thêm chi phí xe', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Thêm chi phí', exact: true }).click()
  await expect(page.getByLabel('Tìm xe', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Nội dung chi phí *', { exact: true })).toHaveValue('')
  await expect(page.getByText(/Bản nháp gợi ý từ Cà Rem AI Copilot/)).toHaveCount(0)
  expect(calls.writes).toEqual([])
})
