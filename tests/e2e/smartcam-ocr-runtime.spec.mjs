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
  frame_number: 'RLH160KD12345', license_plate: '59A1-234.56', status: 'IN_STOCK', purchase_date: '2026-10-01', year: 2022, color: 'Đen' }

async function setup(page) {
  const calls = { assist: [], lookups: [], tesseract: [], cdn: [], languageFailures: [] }
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test',
    created_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: userId, role: 'authenticated', aud: 'authenticated', exp: expires }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.fixture-signature'
  await page.addInitScript(({ session }) => {
    localStorage.setItem('xe-remember', 'true')
    localStorage.setItem('sb-xe-test-auth-token', JSON.stringify(session))
    // Legacy OFF flags must migrate to mandatory local OCR and automatic opening.
    // AI remains fully OFF: no image may reach the provider.
    localStorage.setItem('xe_crm_smartcam_settings', JSON.stringify({ mode: 'scan', sound: false, autoOpen: false, localOcr: false, cloudMode: 'off' }))
  }, { session: { access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expires, user } })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/tesseract/')) calls.tesseract.push({ path: url.pathname, status: response.status() })
    if ((url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com') && url.pathname.includes('traineddata')) {
      calls.cdn.push(url.pathname)
      if (response.status() >= 400) calls.languageFailures.push(`${response.status()} ${url.hostname}`)
    }
  })
  page.on('requestfailed', request => {
    if (request.url().includes('traineddata')) calls.languageFailures.push(request.failure()?.errorText ?? 'language-data request failed')
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
    if (name === 'get_settings') return reply({ store_name: 'Cà Rem fixture', phone: '', address: '' })
    if (name === 'get_vehicle') return reply(known)
    if (name === 'get_acquisition_for_vehicle') return reply(null)
    if (name === 'list_vehicle_images' || name === 'list_vehicle_history') return reply([])
    if (name === 'report_client_issue') return reply({ recorded: true })
    if (name === 'lookup_vehicle_identifiers') {
      const compact = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const plate = compact(body.p_license_plate), frame = compact(body.p_frame_number)
      const all = [known]
      calls.lookups.push(String(body.p_license_plate || body.p_frame_number || ''))
      return reply({ plate_matches: plate ? all.filter(row => compact(row.license_plate) === plate) : [],
        frame_matches: frame.length >= 11 ? all.filter(row => compact(row.frame_number) === frame) : [] })
    }
    if (name === 'list_vehicles') {
      const search = String(body.p_filters?.search ?? '').toUpperCase()
      calls.lookups.push(search)
      const hay = row => `${row.license_plate ?? ''} ${row.frame_number ?? ''} ${row.internal_code ?? ''} ${row.color ?? ''} ${row.vehicle_type ?? ''}`.toUpperCase()
      const items = search ? [known].filter(row => hay(row).includes(search)) : [known]
      return reply({ items, total: items.length })
    }
    return reply({ message: `Unexpected fixture request: ${path}` }, 400)
  })
  return calls
}

for (const [scene, expected] of [['offcenter two-line plate', known.license_plate], ['angled frame with background text', known.frame_number]]) {
test(`smart camera runtime: localized ${scene} resolves with real WASM and AI off`, async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const calls = await setup(page)
  await page.goto('/capture')
  await expect(page.getByRole('checkbox', { name: /Dùng AI để nhận diện ảnh/ })).not.toBeChecked()
  const fixture = await page.evaluate(async scene => {
    const canvas = document.createElement('canvas')
    canvas.width = 1600
    canvas.height = 1000
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#eeeeee'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#333333'
    ctx.font = 'bold 50px Arial, sans-serif'
    ctx.fillText('CA REM MOTOR', 830, 640)
    ctx.font = '42px Arial, sans-serif'
    ctx.fillText('HOTLINE 0901234567', 830, 720)
    ctx.fillText('2026 - XE MAY', 830, 795)
    if (scene.startsWith('offcenter')) {
      // This plate is entirely above the old lower-middle fixed band.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(60, 60, 470, 340)
      ctx.fillStyle = '#000000'
      ctx.font = 'bold 100px Arial, sans-serif'
      ctx.fillText('59A1', 140, 150)
      ctx.fillText('234.56', 95, 295)
    } else {
      ctx.save()
      ctx.translate(220, 280)
      ctx.rotate(12 * Math.PI / 180)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(-30, -70, 1090, 145)
      ctx.fillStyle = '#000000'
      ctx.font = 'bold 92px Arial, sans-serif'
      ctx.fillText('RLH160KD12345', 0, 0)
      ctx.restore()
    }
    const { analyzeFrame } = await import('/src/lib/smartcam/local/frames.ts')
    return { dataUrl: canvas.toDataURL('image/png'), analysis: analyzeFrame(canvas) }
  }, scene)
  await testInfo.attach('pixel-localization', { body: JSON.stringify(fixture.analysis, null, 2), contentType: 'application/json' })
  if (scene.startsWith('offcenter')) {
    expect(fixture.analysis.regions.slice(0, 2).some(region => region.kind === 'block' && region.normalized.y < 0.12), `two-line offcenter plate not prioritized for focused OCR: ${JSON.stringify(fixture.analysis.regions)}`).toBe(true)
  } else {
    expect(fixture.analysis.regions.slice(0, 2).some(region => Math.abs(region.angleDegrees - 12) < 2 && region.normalized.y < 0.30), 'tilted frame baseline not prioritized for focused OCR').toBe(true)
  }
  const buffer = Buffer.from(fixture.dataUrl.split(',')[1], 'base64')
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: 'localized-scene.png', mimeType: 'image/png', buffer })
  const outcome = await Promise.race([
    page.waitForURL(new RegExp(`/vehicles/${vehicleId}$`), { timeout: 200_000 }).then(() => 'matched'),
    page.getByText('Bộ đọc trên máy chưa tải được. Có thể bật AI để đọc ảnh.', { exact: true }).waitFor({ timeout: 200_000 }).then(() => 'unavailable'),
    page.getByText('Chưa đọc được thông tin. Chọn ảnh rõ hơn hoặc bật AI để thử tiếp.', { exact: true }).waitFor({ timeout: 200_000 }).then(() => 'unreadable'),
  ])
  if (outcome === 'unavailable' || (outcome === 'unreadable' && calls.languageFailures.length)) {
    expect(calls.languageFailures.length).toBeGreaterThan(0)
    test.skip(true, `Tesseract language data unavailable: ${calls.languageFailures.join(', ')}`)
  }
  expect(outcome, `localized ${scene} did not resolve its genuine rendered pixels`).toBe('matched')
  expect(calls.lookups).toContain(expected)
  expect(calls.assist).toEqual([])
  expect(calls.tesseract.some(entry => entry.path.startsWith('/tesseract/core/'))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('localized-ocr-vehicle.png'), fullPage: true })
})
}

async function expectUnifiedIdentifierScan(page) {
  await expect(page.getByRole('group', { name: 'Thông tin cần quét' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Cả hai|Biển số|Số khung)$/ })).toHaveCount(0)
}

for (const [target, value, fontSize] of [['plate', known.license_plate, 130], ['frame', known.frame_number, 110]]) {
test(`smart camera runtime: continuous live ${target} scan votes and opens the vehicle without a shutter`, async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const calls = await setup(page)
  await page.addInitScript(({ value, fontSize }) => {
    window.__smartcamRuntimeRecognitions = 0
    const postMessage = Worker.prototype.postMessage
    Worker.prototype.postMessage = function(message, ...args) {
      if (message?.action === 'recognize') window.__smartcamRuntimeRecognitions++
      return postMessage.call(this, message, ...args)
    }
    // Supply a genuine browser MediaStream; the application still reads the
    // video pixels, crops the guide, checks sharpness and runs real WASM OCR.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 800
      const ctx = canvas.getContext('2d')
      const draw = () => {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = '#000000'
        ctx.font = `bold ${fontSize}px Arial, sans-serif`
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(value, 640, 410)
      }
      draw()
      const stream = canvas.captureStream(10)
      const timer = setInterval(draw, 100)
      window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
      return stream
    } })
  }, { value, fontSize })
  await page.goto('/capture')
  await expect(page.getByRole('heading', { name: 'Camera thông minh' })).toBeVisible()
  await expectUnifiedIdentifierScan(page)
  await expect(page.getByRole('button', { name: 'Chụp ngay', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Mở camera', exact: true }).click()
  await expect(page.getByLabel('Hình camera trực tiếp')).toBeVisible()
  const outcome = await Promise.race([
    page.waitForURL(new RegExp(`/vehicles/${vehicleId}$`), { timeout: 200_000 }).then(() => 'matched'),
    page.getByText('Bộ đọc trên máy chưa tải được. Có thể bật AI để đọc ảnh.', { exact: true }).waitFor({ timeout: 200_000 }).then(() => 'unavailable'),
  ])
  if (outcome === 'unavailable') {
    expect(calls.languageFailures.length, 'worker unavailable without a language-data network failure').toBeGreaterThan(0)
    test.skip(true, `Tesseract language data unavailable in this environment: ${calls.languageFailures.join(', ')}`)
  }
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  await expect(page.locator('.vehicle-id-frame .vehicle-id-value')).toHaveText(known.frame_number)
  expect(calls.lookups).toContain(value)
  // Each observation uses two OCR regions. Four reads prove that the live
  // path repeated the observation and reached its stable-frame vote.
  expect(await page.evaluate(() => window.__smartcamRuntimeRecognitions)).toBeGreaterThanOrEqual(4)
  expect(calls.assist).toEqual([])
  expect(calls.tesseract.some(entry => entry.path.startsWith('/tesseract/core/'))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath(`${target}-live-ocr-vehicle.png`), fullPage: true })
})
}

for (const [target, value, fontSize] of [['plate', known.license_plate, 200], ['frame', known.frame_number, 155]]) {
test(`smart camera runtime: real WASM ${target} OCR opens the matching vehicle with AI off`, async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const calls = await setup(page)
  await page.goto('/capture')
  await expect(page.getByRole('heading', { name: 'Camera thông minh' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /Dùng AI để nhận diện ảnh/ })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Chụp ngay', exact: true })).toHaveCount(0)
  await expectUnifiedIdentifierScan(page)

  // Render a large clean plate image in the browser and feed it as a file —
  // the same pixels a phone camera would deliver, minus the blur.
  const dataUrl = await page.evaluate(({ value, fontSize }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1400
    canvas.height = 400
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    ctx.font = `bold ${fontSize}px Arial, sans-serif`
    ctx.textBaseline = 'middle'
    ctx.fillText(value, 60, 210)
    return canvas.toDataURL('image/png')
  }, { value, fontSize })
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64')
  await page.getByLabel('Chọn ảnh xe từ thư viện').setInputFiles({ name: `${target}.png`, mimeType: 'image/png', buffer })

  // Real recognition over the real engine — or an honest environment skip.
  const outcome = await Promise.race([
    page.waitForURL(new RegExp(`/vehicles/${vehicleId}$`), { timeout: 200_000 }).then(() => 'matched'),
    page.getByText('Bộ đọc trên máy chưa tải được. Có thể bật AI để đọc ảnh.', { exact: true }).waitFor({ timeout: 200_000 }).then(() => 'unavailable'),
    page.getByText('Chưa đọc được thông tin. Chọn ảnh rõ hơn hoặc bật AI để thử tiếp.', { exact: true }).waitFor({ timeout: 200_000 }).then(() => 'unreadable'),
  ])
  if (outcome === 'unavailable' || (outcome === 'unreadable' && calls.languageFailures.length)) {
    // Only skip with evidence that the external language download failed.
    expect(calls.languageFailures.length, 'worker unavailable without a language-data network failure').toBeGreaterThan(0)
    test.skip(true, `Tesseract language data unavailable in this environment: ${calls.languageFailures.join(', ')}`)
  }
  if (outcome !== 'matched') {
    const diagnostics = await page.evaluate(async dataUrl => {
      const { createWorker, PSM } = (await import('/node_modules/tesseract.js/dist/tesseract.esm.min.js')).default
      const { captureFromFile, dataUrlToCanvas } = await import('/src/lib/smartcam/capture.ts')
      const { bandCanvas, preprocessedFull } = await import('/src/lib/smartcam/local/frames.ts')
      const { parsePlateCandidates, parseFrameCandidates } = await import('/src/lib/smartcam/local/candidates.ts')
      const photo = await captureFromFile(new File([await (await fetch(dataUrl)).blob()], 'fixture.png', { type: 'image/png' }))
      const canvas = await dataUrlToCanvas(photo.dataUrl)
      const worker = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/core' })
      const observations = []
      try {
        for (const [region, source, mode] of [['band', bandCanvas(canvas), PSM.SINGLE_LINE], ['full', preprocessedFull(canvas, 1080), PSM.SPARSE_TEXT]]) {
          await worker.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.- ' })
          const { data } = await worker.recognize(source, {}, { text: true, blocks: true })
          observations.push({ region, text: data.text, confidence: data.confidence,
            plates: parsePlateCandidates(data.text, data.confidence), frames: parseFrameCandidates(data.text, data.confidence),
            glyphs: (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words.flatMap(word => word.symbols.map(symbol => ({ text: symbol.text, confidence: symbol.confidence, bbox: symbol.bbox })))))) })
        }
      } finally { await worker.terminate() }
      return observations
    }, dataUrl)
    await testInfo.attach('local-ocr-observations', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' })
    console.log(`OCR diagnostics ${target}: ${JSON.stringify(diagnostics)}`)
  }
  expect(outcome, `real local OCR failed to resolve a clean rendered ${target}`).toBe('matched')
  await expect(page).toHaveURL(new RegExp(`/vehicles/${vehicleId}$`))
  await expect(page.locator('.vehicle-id-plate .vehicle-id-value')).toHaveText(known.license_plate)
  await expect(page.locator('.vehicle-id-frame .vehicle-id-value')).toHaveText(known.frame_number)
  expect(calls.tesseract.filter(entry => entry.path.endsWith('worker.min.js'))).toHaveLength(1)
  // The LSTM core is served from our own /tesseract/core/ (worker.min.js and
  // the core loader arrive as *.wasm.js — the binary comes with them).
  expect(calls.tesseract.some(entry => entry.path.startsWith('/tesseract/core/')), JSON.stringify(calls.tesseract)).toBe(true)
  expect(calls.tesseract.every(entry => entry.status === 200)).toBe(true)
  // A browser cache may satisfy the language model after the first test.
  // Runtime worker/core requests still prove that OCR actually executed.
  expect(calls.lookups).toContain(target === 'plate' ? known.license_plate : known.frame_number)
  // Hard cost proof: the paid provider was never contacted for this scan.
  expect(calls.assist).toEqual([])
  await page.screenshot({ path: testInfo.outputPath(`${target}-real-ocr-vehicle.png`), fullPage: true })
})
}
