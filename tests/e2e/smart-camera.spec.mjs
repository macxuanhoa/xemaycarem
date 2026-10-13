import { test, expect } from '@playwright/test'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// Smart Camera vertical slice: an image (from the gallery fallback, so the
// spec needs no fake video device) → ai-assist `vehicle_scan` draft → secure
// list_vehicles lookup → either open the matched vehicle or hand a structured
// recognition result to the EXISTING Shorthand Intake for confirmed save.
const userId = '11111111-1111-4111-8111-111111111111'
const vehicleId = '22222222-2222-4222-8222-222222222222'
const pixel = await sharp({ create: { width: 480, height: 320, channels: 3, background: '#eeeeee' } }).png().toBuffer()
const known = { id: vehicleId, internal_code: 'XE-TEST-000001', vehicle_type_id: 'vt-ga', vehicle_type: 'Xe tay ga',
  frame_number: 'RLHTEST000001', license_plate: '59A1-234.56', status: 'IN_STOCK', purchase_date: '2026-10-01', year: 2022, color: 'Đen' }
function scanDraft(values) {
  const empty = { license_plate: null, frame_number: null }
  return { kind: 'draft', task: 'vehicle_scan', vehicle_id: null, draft: { ...empty, ...values },
    human_confirmation_required: true, warnings: ['Kiểm tra lại từng trường trước khi lưu.'] }
}
async function setup(page, { result, role = 'OWNER', identityVehicles = [known] } = {}) {
  const calls = { assist: [], reads: [], writes: [], storage: [], ocr: [] }
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
    // Only the AI choice remains configurable. OCR and continuous scanning
    // are defaults; this suite models an unavailable worker to deterministically
    // cover cloud fallback. The genuine WASM runtime has its own separate spec.
    localStorage.setItem('xe_crm_smartcam_settings', JSON.stringify({ mode: 'scan', cloudMode: 'auto' }))
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  await page.route('**/tesseract/worker.min.js', async route => {
    calls.ocr.push(route.request().url())
    await route.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("message", () => { throw new Error("Fixture OCR unavailable"); });' })
  })
  await page.route('**/*traineddata*', route => route.abort())
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
      role, active: true, can_view_financials: role !== 'STAFF', must_change_password: false, deleted_at: null })
    if (path === '/functions/v1/ai-assist') { calls.assist.push(body); return reply(typeof result === 'function' ? result(body) : result ?? scanDraft({ license_plate: '59A1-234.56' })) }
    if (path.startsWith('/storage/')) { calls.storage.push(path); return reply({ Path: 'fixture/scan.jpg' }) }
    const name = path.split('/').at(-1)
    if (name === 'check_user_access') return reply({ allowed: true, role, must_change_password: false })
    if (name === 'get_settings') return reply({ store_name: 'Xe Máy Cà Rem', phone: '', address: '' })
    if (name === 'list_vehicle_types') return reply([
      { id: 'vt-ga', name: 'Xe tay ga', vehicle_count: 1 },
      { id: 'vt-so', name: 'Xe số', vehicle_count: 0 },
      { id: 'vt-chua', name: 'Chưa phân loại', vehicle_count: 0 },
    ])
    if (name === 'get_vehicle') { calls.reads.push({ name, body }); return reply(known) }
    if (name === 'lookup_identity_document_vehicles') { calls.reads.push({ name, body }); return reply(identityVehicles) }
    if (name === 'report_client_issue') return reply({ recorded: true })
    if (name === 'lookup_vehicle_identifiers') {
      const compact = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const plate = compact(body.p_license_plate), frame = compact(body.p_frame_number)
      const all = [known, ...imported]
      calls.reads.push({ name, body })
      return reply({ plate_matches: plate ? all.filter(row => compact(row.license_plate) === plate) : [],
        frame_matches: frame.length >= 11 ? all.filter(row => compact(row.frame_number) === frame) : [] })
    }
    if (name === 'list_vehicles') {
      calls.reads.push({ name, body })
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
async function expectUnifiedIdentifierScan(page) {
  await expect(page.getByRole('group', { name: 'Thông tin cần quét' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Cả hai|Biển số|Số khung)$/ })).toHaveCount(0)
}
async function scanFromLibrary(page) {
  await expectUnifiedIdentifierScan(page)
  await page.getByRole('checkbox', { name: /Dùng AI để nhận diện ảnh/ }).check()
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: 'scan.jpg', mimeType: 'image/jpeg', buffer: pixel })
}

async function mockCameraHardware(page, enumeration = 'multiple') {
  await page.addInitScript(({ enumeration }) => {
    const hardware = { requests: [], streams: [] }
    window.__smartcamHardware = hardware
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      hardware.requests.push(constraints)
      const deviceId = constraints.video.deviceId?.exact
      const facing = deviceId ? (deviceId === 'front-device' ? 'user' : 'environment') : constraints.video.facingMode?.ideal ?? 'environment'
      const state = { facing, deviceId: facing === 'user' ? 'front-device' : 'rear-device', torch: false, stopped: false, constraints: [] }
      hardware.streams.push(state)
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 800
      const context = canvas.getContext('2d')
      const draw = () => {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.fillStyle = '#000000'
        context.font = 'bold 130px Arial, sans-serif'
        context.textBaseline = 'middle'
        context.textAlign = 'center'
        context.fillText(facing === 'user' ? 'CAMERA FRONT' : 'CAMERA REAR', 640, 410)
      }
      draw()
      const stream = canvas.captureStream(10)
      const track = stream.getVideoTracks()[0]
      const timer = setInterval(draw, 100)
      const stop = track.stop.bind(track)
      track.stop = () => { state.stopped = true; clearInterval(timer); stop() }
      track.getSettings = () => ({ deviceId: state.deviceId, facingMode: facing, width: 1280, height: 800, torch: state.torch })
      track.getCapabilities = () => facing === 'environment' ? { torch: true } : {}
      track.applyConstraints = async constraints => {
        state.constraints.push(constraints)
        if (constraints.advanced?.[0]?.torch !== undefined) state.torch = constraints.advanced[0].torch
        track.dispatchEvent(new Event('constraintchange'))
      }
      window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
      return stream
    } })
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => {
      if (enumeration === 'unavailable') throw new DOMException('Fixture camera enumeration unavailable', 'NotAllowedError')
      const rear = { deviceId: 'rear-device', groupId: 'rear-group', kind: 'videoinput', label: 'Back camera' }
      return enumeration === 'single' ? [rear] : [rear, { deviceId: 'front-device', groupId: 'front-group', kind: 'videoinput', label: 'Front camera' }]
    } })
  }, { enumeration })
}

test('smart camera: device tools appear only once the camera runs and drive the live track', async ({ page }) => {
  const calls = await setup(page, { result: scanDraft({}) })
  await mockCameraHardware(page)
  await page.goto('/capture')
  // Before the camera opens there is no torch, lens-flip or zoom tooling to
  // show — the quick toolbar only exists while a stream is live.
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Camera trước', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Mở camera', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mở camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Bật đèn pin', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Tắt đèn pin', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => window.__smartcamHardware.streams[0].torch)).toBe(true)
  await page.getByRole('button', { name: 'Tắt đèn pin', exact: true }).click()
  expect(await page.evaluate(() => window.__smartcamHardware.streams[0].torch)).toBe(false)
  await page.getByRole('button', { name: 'Bật đèn pin', exact: true }).click()
  const scansBeforeSwitch = calls.assist.length
  await page.getByRole('button', { name: 'Camera trước', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Camera sau', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeDisabled()
  await expect(page.getByText('Camera này không hỗ trợ đèn pin. Có thể đổi sang camera sau.')).toBeVisible()
  expect(await page.evaluate(() => window.__smartcamHardware.streams.map(({ facing, torch, stopped }) => ({ facing, torch, stopped })))).toEqual([
    { facing: 'environment', torch: false, stopped: true },
    { facing: 'user', torch: false, stopped: false },
  ])
  // The new stream proceeds to a genuine automatic cloud fallback. No new
  // open-camera or shutter action is needed after changing the lens.
  await expect.poll(() => calls.assist.length, { timeout: 20000 }).toBeGreaterThan(scansBeforeSwitch)
  expect(calls.assist.at(-1)).toMatchObject({ scan_mode: 'identifiers', scan_target: 'both' })
  await expect(page.getByRole('button', { name: 'Camera sau', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Camera sau', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.__smartcamHardware.requests.map(request => request.video))).toEqual([
    { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    { deviceId: { exact: 'front-device' } },
    { deviceId: { exact: 'rear-device' } },
  ])
  await page.getByRole('button', { name: 'Tắt camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mở camera', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeHidden()
  expect(await page.evaluate(() => window.__smartcamHardware.streams.every(stream => stream.stopped))).toBe(true)
  expect(calls.writes).toEqual([])
})

for (const enumeration of ['single', 'unavailable']) test(`smart camera: front and rear selection works when camera enumeration is ${enumeration}`, async ({ page }) => {
  await setup(page)
  await mockCameraHardware(page, enumeration)
  await page.goto('/capture')
  // Lens tools are hidden until the camera opens; choosing remains a live
  // action on the running stream, never a permission request beforehand.
  await expect(page.getByRole('button', { name: 'Camera trước', exact: true })).toBeHidden()
  expect(await page.evaluate(() => window.__smartcamHardware.requests)).toEqual([])
  await page.getByRole('button', { name: 'Mở camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Tắt camera', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Camera trước', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Camera trước', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Camera sau', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Camera sau', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Camera trước', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__smartcamHardware.requests.map(request => request.video.facingMode?.ideal))).toEqual(['environment', 'user', 'environment'])
  expect(await page.evaluate(() => window.__smartcamHardware.streams.map(({ facing, stopped }) => ({ facing, stopped })))).toEqual([
    { facing: 'environment', stopped: true },
    { facing: 'user', stopped: true },
    { facing: 'environment', stopped: false },
  ])
})

test('smart camera: known plate scan resolves to the existing vehicle profile', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await expect(page.getByRole('heading', { name: 'Camera thông minh' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Chế độ camera' }).getByRole('button')).toHaveCount(3)
  await expectUnifiedIdentifierScan(page)
  await expect(page.getByText('Tra cứu xe thủ công', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toHaveCount(1)
  await expect(page.getByText('Quét liên tục khi mở camera', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Chụp ngay|Nhận diện ngay/ })).toHaveCount(0)
  await scanFromLibrary(page)
  // A safe exact identifier opens the vehicle immediately; no confirmation button.
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  const assist = calls.assist.find(entry => entry.task === 'vehicle_scan')
  expect(assist).toMatchObject({ consent: true, scan_mode: 'identifiers', scan_target: 'both' })
  expect(typeof assist.image.base64).toBe('string')
  // No write ever happened for a read-only identification.
  expect(calls.writes).toEqual([])
})

test('smart camera: disabling AI sends no image when local OCR is unavailable', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await page.getByRole('checkbox', { name: /Dùng AI để nhận diện ảnh/ }).uncheck()
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: 'scan.jpg', mimeType: 'image/jpeg', buffer: pixel })
  await expect(page.getByText('Chưa đọc được thông tin. Chọn ảnh rõ hơn hoặc bật AI để thử tiếp.')).toBeVisible()
  expect(calls.assist).toEqual([])
  expect(calls.writes).toEqual([])
  await expect(page.locator('.smartcam-result')).toHaveCount(0)
})

async function qrImage(payload, errorCorrectionLevel = 'M') {
  return { name: 'qr.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(payload, { width: 720, margin: 4, errorCorrectionLevel }) }
}

for (const format of ['legacy URL', 'stable payload']) test(`smart camera: a real vehicle QR upload (${format}) opens its verified vehicle without AI`, async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await page.getByRole('button', { name: /QR xe/ }).click()
  await expectUnifiedIdentifierScan(page)
  await expect(page.getByRole('button', { name: /Chụp ngay/ })).toHaveCount(0)
  const payload = format === 'stable payload' ? `carem:vehicle:v1:${vehicleId}` : `http://127.0.0.1:4184/vehicles/${vehicleId}`
  await page.getByLabel('Chọn ảnh QR xe từ thư viện').setInputFiles(await qrImage(payload))
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  expect(calls.reads.some(entry => entry.name === 'get_vehicle' && entry.body.p_id === vehicleId)).toBe(true)
  expect(calls.assist).toEqual([])
  expect(calls.ocr).toEqual([])
  expect(calls.writes).toEqual([])
})

test('smart camera: identifier mode ignores QR payloads until QR mode is selected', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await page.getByRole('checkbox', { name: /Dùng AI để nhận diện ảnh/ }).uncheck()
  const image = await qrImage(`http://127.0.0.1:4184/vehicles/${vehicleId}`)
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles(image)
  await expect(page.getByText('Chưa đọc được thông tin. Chọn ảnh rõ hơn hoặc bật AI để thử tiếp.')).toBeVisible()
  await expect(page).toHaveURL(/\/capture$/)
  expect(calls.reads.filter(entry => entry.name === 'get_vehicle')).toEqual([])
  await page.getByRole('button', { name: /QR xe/ }).click()
  await page.getByLabel('Chọn ảnh QR xe từ thư viện').setInputFiles(image)
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  expect(calls.assist).toEqual([])
})

test('smart camera: CCCD photo upload uses exact identity lookup and opens the stored vehicle', async ({ page }) => {
  const calls = await setup(page, { result: scanDraft({ identity_number: '079090123456' }) })
  await page.goto('/capture')
  await page.getByRole('button', { name: /CCCD/ }).click()
  await expectUnifiedIdentifierScan(page)
  await page.getByLabel('Chọn ảnh CCCD từ thư viện').setInputFiles({ name: 'cccd.png', mimeType: 'image/png', buffer: pixel })
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  expect(calls.assist).toHaveLength(1)
  expect(calls.assist[0]).toMatchObject({ scan_mode: 'identity', consent: true })
  expect(calls.reads.filter(entry => entry.name === 'lookup_identity_document_vehicles')).toEqual([{ name: 'lookup_identity_document_vehicles', body: { p_id_number: '079090123456' } }])
  expect(calls.reads.filter(entry => entry.name === 'list_vehicles')).toEqual([])
  expect(calls.writes).toEqual([])
  expect(calls.storage).toEqual([])
})

for (const correction of ['M', 'H']) test(`smart camera: native CCCD QR upload (${correction}) resolves locally without exposing identity data to AI`, async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/capture')
  await page.getByRole('button', { name: /CCCD/ }).click()
  await page.getByRole('checkbox', { name: /Dùng AI để nhận diện ảnh/ }).uncheck()
  await page.getByLabel('Chọn ảnh CCCD từ thư viện').setInputFiles(await qrImage('079090123456||NGUYEN VAN A|15051990|Nam|TP Ho Chi Minh|01012020', correction))
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  expect(calls.reads.filter(entry => entry.name === 'lookup_identity_document_vehicles')).toEqual([{ name: 'lookup_identity_document_vehicles', body: { p_id_number: '079090123456' } }])
  expect(calls.assist).toEqual([])
  expect(calls.ocr).toEqual([])
  expect(calls.writes).toEqual([])
})

test('smart camera: multiple CCCD vehicles require an explicit choice', async ({ page }) => {
  const otherId = '44444444-4444-4444-8444-444444444444'
  const other = { ...known, id: otherId, frame_number: 'RLHTEST000002', license_plate: '61B1-777.77', status: 'RESERVED' }
  const calls = await setup(page, { result: scanDraft({ identity_number: '079090123456' }), identityVehicles: [known, other] })
  await page.goto('/capture')
  await page.getByRole('button', { name: /CCCD/ }).click()
  await page.getByLabel('Chọn ảnh CCCD từ thư viện').setInputFiles({ name: 'cccd.png', mimeType: 'image/png', buffer: pixel })
  await expect(page.getByText('CCCD này liên quan tới nhiều xe trong kho. Chọn xe cần mở.')).toBeVisible()
  await expect(page).toHaveURL(/\/capture$/)
  await expect(page.locator('.smartcam-candidate')).toHaveCount(2)
  await page.locator('.smartcam-candidate').filter({ hasText: '61B1-777.77' }).click()
  await expect(page).toHaveURL(new RegExp(`/vehicles/${otherId}$`))
  expect(calls.writes).toEqual([])
})

test('smart camera: uncertain identifier characters stay red and block automatic navigation', async ({ page }) => {
  const calls = await setup(page, { result: scanDraft({ license_plate: known.license_plate, color: 'Trắng', year: 2023, vehicle_type: 'Xe số', uncertain_characters: { license_plate: [2] } }) })
  await page.goto('/capture')
  await scanFromLibrary(page)
  await expect(page.getByText('Xe có thể khớp — kiểm tra chữ đỏ trước khi mở:', { exact: false })).toBeVisible()
  await expect(page.locator('.smartcam-risk-char')).toHaveText('A')
  await expect(page.locator('.smartcam-risk-char')).toHaveAttribute('title', 'Ký tự có thể đọc nhầm')
  await expect(page.getByText('Chữ tô đỏ cần kiểm tra lại với ảnh gốc.')).toBeVisible()
  await expect(page).toHaveURL(/\/capture$/)
  await expect(page.locator('.smartcam-fields')).not.toContainText('Trắng')
  await expect(page.locator('.smartcam-fields')).not.toContainText('2023')
  await expect(page.locator('.smartcam-fields')).not.toContainText('Xe số')
  expect(calls.assist[0].scan_target).toBe('both')
  expect(calls.writes).toEqual([])
})

test('smart camera: STAFF cannot select the restricted CCCD mode', async ({ page }) => {
  const calls = await setup(page, { role: 'STAFF' })
  await page.goto('/capture')
  await expect(page.getByRole('button', { name: /CCCD/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Biển số \/ số khung/ })).toBeEnabled()
  expect(calls.reads.filter(entry => entry.name === 'lookup_identity_document_vehicles')).toEqual([])
})

test('smart camera: unknown plate scan asks to collect the vehicle or keep scanning the frame', async ({ page }) => {
  const calls = await setup(page, { result: scanDraft({ license_plate: '61B1-777.77' }) })
  await page.goto('/capture')
  await scanFromLibrary(page)
  await expect(page.getByText('Bạn muốn thu xe này, hay quét tiếp số khung?', { exact: false })).toBeVisible()
  const continueButton = page.getByRole('button', { name: 'Quét tiếp số khung', exact: true })
  await expect(continueButton).toBeVisible()
  await page.getByRole('button', { name: 'Thu xe mới', exact: true }).click()
  await expect(page).toHaveURL(/\/intake$/)
  // Thu xe carries every field the camera has read so far into the intake cards.
  await expect(page.getByPlaceholder('59A1-234.56')).toHaveValue('61B1-777.77')
  expect(calls.writes).toEqual([])
})

test('smart camera: CCCD with no stored number explains the missing card number instead of stopping', async ({ page }) => {
  const calls = await setup(page, { result: scanDraft({ identity_number: '079090123456' }), identityVehicles: [] })
  await page.goto('/capture')
  await page.getByRole('button', { name: /CCCD/ }).click()
  await page.getByLabel('Chọn ảnh CCCD từ thư viện').setInputFiles({ name: 'cccd.png', mimeType: 'image/png', buffer: pixel })
  await expect(page.getByText('Không có xe trong kho đang lưu số CCCD này', { exact: false })).toBeVisible()
  await expect(page.getByText('nhập đủ 12 số căn cước', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quét biển số / số khung để tìm xe', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/capture$/)
  expect(calls.writes).toEqual([])
})

async function waitForCameraLayout(page, width) {
  await expect(page.getByRole('heading', { name: 'Camera thông minh' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Chế độ camera' }).getByRole('button')).toHaveCount(3)
  await expectUnifiedIdentifierScan(page)
  if (width < 1000) {
    await expect(page.locator('.sidebar')).toHaveAttribute('aria-hidden', 'true')
    await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0)
  }
  await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const card = await page.locator('.smartcam-card').boundingBox()
  expect(card.x).toBeGreaterThanOrEqual(0)
  expect(card.x + card.width).toBeLessThanOrEqual(width + 1)
  for (const button of await page.getByRole('group', { name: 'Chế độ camera' }).getByRole('button').all()) {
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(card.x)
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 1)
  }
}

async function expectCameraControlsAboveNavigation(page, running = false) {
  const navigation = await page.locator('.bottom-nav').boundingBox()
  // Idle: the open/upload text buttons. Running: the icon quick toolbar
  // (tắt cam, tải ảnh, đèn pin, đổi cam) sits directly under the stage.
  const controls = running
    ? [
        page.getByRole('button', { name: 'Tắt camera', exact: true }),
        page.locator('.smartcam-quick-upload'),
        page.getByRole('button', { name: 'Bật đèn pin', exact: true }),
        page.getByRole('button', { name: 'Camera trước', exact: true }),
      ]
    : [
        page.getByRole('button', { name: 'Mở camera', exact: true }),
        page.locator('.smartcam-btn-upload'),
      ]
  if (running) {
    await expect(page.getByRole('button', { name: 'Mở camera', exact: true })).toBeHidden()
    await expect(page.locator('.smartcam-btn-upload')).toBeHidden()
  } else {
    await expect(page.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Camera trước', exact: true })).toBeHidden()
  }
  const boxes = []
  for (const control of controls) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThan(navigation.y)
    // Also catch a raised navigation item or another overlay intercepting
    // touches even when the bounding boxes alone appear clear.
    expect(await control.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
    boxes.push(box)
  }
  if (running) {
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1)
    expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThanOrEqual(1)
  } else {
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1)
  }
}

test('smart camera: desktop workspace and mobile controls stay accessible at responsive sizes', async ({ page }) => {
  await mkdir(resolve('scratch'), { recursive: true })
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 1280, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
    { width: 320, height: 740 },
  ]) {
    const surface = await page.context().newPage()
    await surface.setViewportSize(viewport)
    await setup(surface, { result: scanDraft({}) })
    await mockCameraHardware(surface)
    await surface.goto('/capture')
    await waitForCameraLayout(surface, viewport.width)
    const modes = await surface.getByRole('group', { name: 'Chế độ camera' }).boundingBox()
    const stage = await surface.locator('.smartcam-stage').boundingBox()
    const actions = await surface.locator('.smartcam-control-panel').boundingBox()
    expect(Math.abs(stage.x - actions.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(stage.width - actions.width)).toBeLessThanOrEqual(1)
    if (viewport.width >= 1000) {
      expect(modes.x).toBeGreaterThanOrEqual(stage.x + stage.width)
    } else {
      expect(modes.y + modes.height).toBeLessThanOrEqual(stage.y)
    }
    if (viewport.width === 1440) await surface.screenshot({ path: resolve('scratch/camera-desktop.png'), fullPage: true, animations: 'disabled' })
    if (viewport.width === 1280) await surface.screenshot({ path: resolve('scratch/camera-desktop-narrow.png'), fullPage: true, animations: 'disabled' })
    if (viewport.width === 768) await surface.screenshot({ path: resolve('scratch/camera-tablet.png'), fullPage: true, animations: 'disabled' })
    if (viewport.width === 360) await surface.screenshot({ path: resolve('scratch/camera-mobile-compact.png'), fullPage: true, animations: 'disabled' })
    if (viewport.width === 320) await surface.screenshot({ path: resolve('scratch/camera-mobile-small.png'), fullPage: true, animations: 'disabled' })
    if (viewport.width === 390 || viewport.width === 360) {
      await expectCameraControlsAboveNavigation(surface)
      if (viewport.width === 390) await surface.screenshot({ path: resolve('scratch/camera-mobile-ready.png'), fullPage: true, animations: 'disabled' })
      await surface.getByRole('button', { name: 'Mở camera', exact: true }).click()
      await expect(surface.getByRole('button', { name: 'Bật đèn pin', exact: true })).toBeEnabled()
      await expectCameraControlsAboveNavigation(surface, true)
      if (viewport.width === 390) await surface.screenshot({ path: resolve('scratch/camera-mobile-live.png'), fullPage: true, animations: 'disabled' })
      await surface.getByRole('button', { name: 'Tắt camera', exact: true }).click()
    }
    await surface.close()
  }
})
