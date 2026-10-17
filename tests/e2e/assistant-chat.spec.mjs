import { test, expect } from '@playwright/test'

/**
 * Trợ lý Cà Rem — mặt phẳng AI duy nhất sau khi gộp "Tra cứu AI Cà Rem".
 * Phủ: một điểm vào duy nhất, khung trả lời thẳng (không nghiêng), thanh chat
 * nằm yên khi lướt, chủ đề mở câu hỏi thay vì hỏi bừa, gợi ý hỏi tiếp,
 * lịch sử giữ theo phiên và lời nhắn chỉ đọc (không ghi dữ liệu).
 */

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
    if (name === 'get_settings') return reply({ store_name: 'Cà Rem fixture', phone: '', address: '' })
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

const editor = page => page.getByLabel('Bạn muốn hỏi gì về cửa hàng?')
const sendButton = page => page.getByRole('button', { name: 'Hỏi Cà Rem', exact: true })

test('one assistant entry point replaces the two old AI pages', async ({ page }) => {
  await setup(page)
  await page.goto('/')
  await expect(page.getByRole('link', { name: /Tra cứu AI Cà Rem/ })).toHaveCount(0)
  await page.getByRole('button', { name: /TRỢ LÝ AI/ }).click()
  await expect(page.getByRole('link', { name: /Trợ lý Cà Rem/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Tài liệu cửa hàng/ })).toBeVisible()
  await page.getByRole('link', { name: /Trợ lý Cà Rem/ }).click()
  await expect(page).toHaveURL(/\/assistant$/)

  // URL cũ của trang "Tra cứu AI" vẫn sống nhưng đáp về đúng một mặt phẳng.
  await page.goto('/copilot')
  await expect(page).toHaveURL(/\/assistant$/)
  await expect(page.getByRole('heading', { name: 'Trợ lý Cà Rem' })).toBeVisible()
})

test('the intro banner shows before the first question and yields space to the chat after', async ({ page }) => {
  await setup(page)
  await page.goto('/assistant')
  await expect(page.getByRole('heading', { name: /Mình có thể giúp gì cho bạn/ })).toBeVisible()
  await expect(page.getByRole('img', { name: /robot thân thiện/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Kho & Tồn xe/ })).toBeVisible()

  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()
  await expect(page.locator('.ca-msg-bot')).toHaveCount(1)

  // Đã trò chuyện: banner robot + 6 chủ đề + banner phụ nhường toàn bộ chiều cao cho khung chat.
  await expect(page.getByRole('heading', { name: /Mình có thể giúp gì cho bạn/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Kho & Tồn xe/ })).toHaveCount(0)
  await expect(page.locator('.ca-banner')).toHaveCount(0)

  // Mở đoạn chat mới thì mặt phẳng giới thiệu quay lại.
  await page.getByRole('button', { name: /Đoạn chat mới/ }).click()
  await expect(page.getByRole('heading', { name: /Mình có thể giúp gì cho bạn/ })).toBeVisible()
  await expect(page.locator('.ca-msg')).toHaveCount(0)
})

test('a topic card drills in place — thay lưới thẻ bằng câu hỏi, có nút quay lại, không bắn truy vấn mù', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assistant')
  const cats = page.locator('.ca-cats')
  await expect(cats.locator('.ca-cat')).toHaveCount(6)

  // Bấm chủ đề: lưới 6 thẻ BIẾN MẤT tại chỗ, thay bằng câu hỏi của chủ đề đó
  // (không trải thêm hàng dài xuống vùng chat), và chưa có truy vấn nào bắn ra.
  await page.getByRole('button', { name: /Kho & Tồn xe/ }).click()
  await expect(cats).toHaveCount(0)
  expect(calls.assist).toHaveLength(0)

  const panel = page.getByRole('group', { name: 'Câu hỏi chủ đề Kho & Tồn xe' })
  await expect(panel.locator('.ca-ask')).toHaveCount(4)

  // Nút quay lại đưa đúng 6 chủ đề trở lại, đóng cấp 2.
  await panel.getByRole('button', { name: /Quay lại sáu chủ đề/ }).click()
  await expect(cats.locator('.ca-cat')).toHaveCount(6)
  await expect(panel).toHaveCount(0)

  // Vào lại rồi hỏi một câu: đúng một lượt truy vấn chỉ đọc.
  await page.getByRole('button', { name: /Kho & Tồn xe/ }).click()
  await panel.getByRole('button', { name: 'Xe nào tồn lâu nhất?' }).click()
  expect(calls.assist).toHaveLength(1)
  expect(calls.assist[0]).toMatchObject({ task: 'copilot', consent: true, mode: 'deterministic', text: 'Xe nào tồn lâu nhất?' })
  expect(calls.writes).toHaveLength(0)
  await expect(page.locator('.ca-bubble-user')).toContainText('Xe nào tồn lâu nhất?')
})

test('the answer surface stays straight and never tilted like the old shared class', async ({ page }) => {
  await setup(page)
  await page.goto('/assistant')
  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()
  const bubble = page.locator('.ca-bubble').first()
  await expect(bubble).toBeVisible()
  expect(await bubble.evaluate(el => getComputedStyle(el).transform)).toBe('none')
  expect(await bubble.evaluate(el => getComputedStyle(el).textAlign)).toBe('left')
  // bong bóng trang trí của hero vẫn nghiêng có chủ đích, không liên quan khung trả lời.
  expect(await page.locator('.ca-hero-speech').count()).toBe(0)
})

test('the composer stays pinned in place while the conversation scrolls', async ({ page }) => {
  await setup(page)
  await page.goto('/assistant')
  const before = await page.locator('.ca-composer').boundingBox()
  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()
  await expect(page.locator('.ca-msg-bot')).toHaveCount(1)

  // Hỏi thêm nhiều lượt để khung chat tràn chiều cao.
  for (const question of ['Doanh thu tháng này?', 'Ai đang nợ nhiều nhất?', 'Chi phí sửa xe gần đây?', 'Đơn bán gần đây?']) {
    await editor(page).fill(question)
    await sendButton(page).click()
  }
  await expect(page.locator('.ca-msg-bot')).toHaveCount(5)

  const after = await page.locator('.ca-composer').boundingBox()
  expect(Math.abs(after.y - before.y)).toBeLessThan(2)
  const scroll = await page.locator('.ca-scroll').evaluate(el => ({ top: el.scrollTop, client: el.clientHeight, full: el.scrollHeight }))
  expect(scroll.full).toBeGreaterThan(scroll.client)
  // Only the message frame scrolls; the document never drifts.
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  // Thanh chat phải SÁT ĐÁY: không còn khoảng chết giữa đáy dock và mép dưới,
  // và document không dài quá màn hình để mà kéo cả trang lên xuống.
  const edge = await page.evaluate(() => {
    const dock = document.querySelector('.ca-dock').getBoundingClientRect()
    return { gap: Math.round(window.innerHeight - dock.bottom), over: document.documentElement.scrollHeight - window.innerHeight }
  })
  expect(edge.gap).toBeLessThanOrEqual(1)
  expect(edge.over).toBe(0)

  // Một dải chrome xen vào đầu trang (thông báo, gợi ý cài app) từng làm cả
  // trang nhấc lên hạ xuống; trang phải tự đo lại và giữ nguyên thế cố định.
  await page.evaluate(() => {
    const fake = document.createElement('div')
    fake.style.cssText = 'height:48px'
    document.querySelector('.main-content').before(fake)
  })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBe(0)
  await expect.poll(() => page.evaluate(() => {
    const dock = document.querySelector('.ca-dock').getBoundingClientRect()
    return Math.round(window.innerHeight - dock.bottom)
  })).toBeLessThanOrEqual(1)
})

test('on phones the dock rests flush on the bottom navigation, not floating above it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.goto('/assistant')
  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()
  await expect(page.locator('.ca-msg-bot')).toHaveCount(1)

  const gap = await page.evaluate(() => {
    const dock = document.querySelector('.ca-dock').getBoundingClientRect()
    const nav = document.querySelector('.bottom-nav').getBoundingClientRect()
    return Math.round(nav.top - dock.bottom)
  })
  expect(Math.abs(gap)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBe(0)
})

test('every answer offers the next question the assistant can actually answer', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assistant')
  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()

  const followUps = page.getByRole('group', { name: 'Câu hỏi tiếp theo' })
  await expect(followUps).toBeVisible()
  await expect(followUps.getByRole('button').first()).toContainText('Xe nào tồn lâu nhất?')

  await followUps.getByRole('button', { name: 'Xe nào tồn lâu nhất?' }).click()
  expect(calls.assist).toHaveLength(2)
  expect(calls.assist[1]).toMatchObject({ text: 'Xe nào tồn lâu nhất?' })
  await expect(page.locator('.ca-bubble-user').nth(1)).toContainText('Xe nào tồn lâu nhất?')
  // Chip đã hỏi bị loại nên danh sách gợi ý không lặp lại vòng hỏi.
  await expect(page.getByRole('group', { name: 'Câu hỏi tiếp theo' }).last().getByRole('button', { name: 'Xe nào tồn lâu nhất?' })).toHaveCount(0)
})

test('history survives leaving the page and coming back inside the same tab', async ({ page }) => {
  await setup(page)
  await page.goto('/assistant')
  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()
  await expect(page.locator('.ca-bubble')).toHaveCount(1)

  await page.goto('/vehicles')
  await page.goto('/assistant')
  await expect(page.locator('.ca-bubble-user')).toContainText('Còn bao nhiêu xe trong kho?')
  await expect(page.locator('.ca-bubble')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: /Mình có thể giúp gì cho bạn/ })).toHaveCount(0)

  await page.getByRole('button', { name: /Đoạn chat mới/ }).click()
  await expect(page.getByRole('heading', { name: /Mình có thể giúp gì cho bạn/ })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('carem-assistant-thread-v1'))).toBeNull()
})

test('the quick row sits above the input bar and asks without typing', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assistant')
  const row = page.getByRole('group', { name: 'Hỏi nhanh' })
  await expect(row).toBeVisible()
  const rowBox = await row.boundingBox()
  const composerBox = await page.locator('.ca-composer').boundingBox()
  expect(rowBox.y).toBeLessThan(composerBox.y)

  await row.getByRole('button', { name: 'Tóm tắt hôm nay' }).click()
  expect(calls.assist[0]).toMatchObject({ text: 'Tình hình cửa hàng hôm nay?' })
})

test('evidence stays folded and every claim opens the screen that proves it', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assistant')
  await editor(page).fill('Còn bao nhiêu xe trong kho?')
  await sendButton(page).click()

  const fact = page.locator('.copilot-facts li').filter({ hasText: 'Xe đang tồn kho' })
  await expect(fact).toBeHidden()
  await expect(page.getByText(/Tồn kho là số xe hiện tại/)).toBeVisible()
  await page.locator('.copilot-evidence > summary').click()
  await expect(fact).toBeVisible()
  await expect(fact.getByText('7 xe')).toBeVisible()
  expect(calls.writes).toHaveLength(0)

  await page.locator('.citation-list').getByRole('link', { name: 'Mở nguồn Xe: Honda SH160' }).click()
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
})

test('document evidence stays readable and external URLs never become links', async ({ page }) => {
  await setup(page)
  await page.goto('/docs')
  await page.locator('summary.docs-category-title', { hasText: 'Vận hành & Phát hành' }).click()
  await page.getByRole('link', { name: /Checklist phát hành Cà Rem/ }).click()
  await expect(page.getByRole('heading', { name: 'Kiểm thử' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'sổ nợ' })).toHaveAttribute('href', '/receivables')
  await expect(page.locator('a[href="https://evil.test"]')).toHaveCount(0)
  await page.getByRole('link', { name: /Hỏi AI về tài liệu này/ }).click()
  await expect(page).toHaveURL(/\/assistant$/)
})

test('only the owner can switch on the AI prose summary', async ({ page }) => {
  // Máy dùng chung có thể còn cài đặt của chủ cửa hàng: nhân viên vẫn tra trực tiếp.
  await page.addInitScript(() => localStorage.setItem('carem-copilot-mode', 'llm'))
  const calls = await setup(page, { role: 'STAFF' })
  await page.goto('/assistant')
  await expect(page.getByRole('checkbox', { name: /Bật AI viết câu tóm tắt/ })).toHaveCount(0)
  await expect(page.locator('.ca-topbar .ca-mode-chip')).toHaveCount(0)
  await expect(page.getByText(/Chỉ chủ cửa hàng bật được/)).toHaveCount(0)
  await editor(page).fill('Tồn kho bao nhiêu?')
  await sendButton(page).click()
  expect(calls.assist[0]).toMatchObject({ mode: 'deterministic' })
})

test('the owner keeps the prose switch and it is remembered for the next question', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assistant')
  // Công tắc AI nằm gọn trên header trợ lý, chỉ còn tên gọi tắt "AI".
  const toggle = page.locator('.ca-topbar').getByRole('checkbox', { name: /Bật AI viết câu tóm tắt/ })
  await expect(toggle).toBeVisible()
  await expect(page.locator('.ca-topbar .ca-mode-chip')).toContainText('AI')
  // Mặc định tra trực tiếp; bật lên thì câu kế dùng bản tóm tắt do AI viết.
  await expect(toggle).not.toBeChecked()
  await editor(page).fill('Doanh thu tháng này?')
  await sendButton(page).click()
  expect(calls.assist[0]).toMatchObject({ mode: 'deterministic' })
  await toggle.check()
  await editor(page).fill('Lợi nhuận tháng này?')
  await sendButton(page).click()
  expect(calls.assist[1]).toMatchObject({ mode: 'llm' })
  expect(await page.evaluate(() => localStorage.getItem('carem-copilot-mode'))).toBe('llm')
})

test('a pending lookup locks the composer and one submit sends one read-only request', async ({ page }) => {
  let release
  const assistGate = new Promise(resolve => { release = resolve })
  const calls = await setup(page, { assistGate })
  await page.goto('/assistant')
  try {
    await editor(page).fill('Còn bao nhiêu xe trong kho?')
    await sendButton(page).click()
    await expect(editor(page)).toBeDisabled()
    await expect(page.getByRole('group', { name: 'Hỏi nhanh' }).getByRole('button').first()).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: /Bật AI viết câu tóm tắt/ })).toBeDisabled()
    await page.locator('.ca-composer').evaluate(form => form.requestSubmit())
    await expect.poll(() => calls.assist.length).toBe(1)
    expect(calls.writes).toHaveLength(0)
  } finally {
    release()
  }
  await expect(page.locator('.ca-bubble-user')).toContainText('Còn bao nhiêu xe trong kho?')
  await expect(editor(page)).toBeEnabled()
  await expect(page.locator('.copilot-evidence')).not.toHaveAttribute('open')
  expect(calls.assist).toHaveLength(1)
})

test('failures show a friendly reason, offer a retry and write nothing', async ({ page }) => {
  const calls = await setup(page, { status: 403, result: { error: 'LLM_MODE_OWNER_ONLY', message: 'Chỉ chủ cửa hàng bật được chế độ AI.' } })
  await page.goto('/assistant')
  await editor(page).fill('Lợi nhuận tháng 9?')
  await sendButton(page).click()
  await expect(page.getByText(/Chỉ chủ cửa hàng bật được chế độ AI/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hỏi lại' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Tồn kho/ })).toBeVisible()
  expect(calls.writes).toHaveLength(0)
})

test('hostile AI text stays escaped and cannot execute', async ({ page }) => {
  const injected = '<img src="x" onerror="window.__assistantInjected=1">'
  await setup(page, { result: { ...evidence, answer_markdown: `Cảnh báo: ${injected}` } })
  await page.goto('/assistant')
  await editor(page).fill('Có rủi ro gì không?')
  await sendButton(page).click()
  await expect(page.getByText(injected).first()).toBeVisible()
  await expect(page.locator('img[src="x"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__assistantInjected)).toBeUndefined()
})

test('a shorthand command still hands its draft to the confirmed expense form', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/assistant')
  await editor(page).fill('chi 500k thay nhớt cho xe 59B1-123.45')
  await sendButton(page).click()
  await expect(page.getByText(/Chưa khớp được xe với biển số 59B1-123.45/)).toBeVisible()
  await page.getByRole('button', { name: 'Kiểm tra & lưu chi phí', exact: true }).click()
  await expect(page).toHaveURL(/\/expenses$/)
  await expect(page.getByRole('heading', { name: 'Thêm chi phí xe', exact: true })).toBeVisible()
  await expect(page.getByLabel('Tìm xe', { exact: true })).toHaveValue('59B1-123.45')
  await expect(page.getByLabel('Số tiền (₫) *', { exact: true })).toHaveValue('500.000')
  expect(calls.writes).toEqual([])
})
