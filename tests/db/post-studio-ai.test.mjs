/**
 * Database tests for the Cà Rem AI Sales Assistant migration
 * (20261010000600_ai_sales_assistant.sql):
 * 1. get_post_studio_context exposes ONLY the Tier-A safe projection — never
 *    purchase price, expenses, supplier/customer identity or notes.
 * 2. RESERVED/CANCELLED vehicles are unavailable; IN_STOCK and SOLD are not.
 * 3. anon and disabled callers cannot reach any new RPC.
 * 4. Draft lifecycle: staff saves and edits own drafts, cannot approve;
 *    OWNER approves, approved drafts lock, stale stock blocks approval.
 * 5. Version history appends on caption change and is immutable.
 * 6. Brand memory: non-OWNER entries land PENDING, RULEs are OWNER-only,
 *    staff only ever read APPROVED, approving an article can seed the library.
 * 7. find_matching_vehicles returns IN_STOCK Tier-A rows only.
 * 8. AI usage metering writes for staff, aggregates for OWNER only.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runPostStudioAiTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database AI Sales Assistant Suite (Post Studio / Brand Memory) ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, argsSql = '', values = []) =>
      run(user, (client) => rpc(client, name, argsSql, values))
    const json = (user, name, data) => call(user, name, '$1::jsonb', [JSON.stringify(data)])
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security|INVALID/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query(
        'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `poststudio-${name}@example.test`, JSON.stringify({ full_name: name })]
      )
      const role = name === 'disabled' ? 'STAFF' : name.toUpperCase()
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2 WHERE id=$3',
        [role, name !== 'disabled', id])
    }

    let seq = 0
    const seedVehicle = async (overrides = {}) => call('owner', 'save_vehicle', '$1::jsonb', [JSON.stringify({
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga',
      license_plate: `PS-${(++seq).toString().padStart(3, '0')}`,
      color: 'Đen',
      year: 2023,
      purchase_date: day,
      purchase_price: 30_000_000,
      notes: 'Ghi chú nội bộ có thông tin nhạy cảm 0914999999',
      ...overrides,
    })])

    // ---- 1. Tier-A projection ----
    const inStock = await seedVehicle({ license_plate: '43D1-111.22' })
    const context = await call('staff', 'get_post_studio_context', '$1::uuid', [inStock])
    await test1(context)
    async function test1(ctx) {
      assert.equal(ctx.license_plate, '43D1-111.22')
      assert.equal(ctx.vehicle_type, 'Xe tay ga')
      assert.equal(ctx.year, 2023)
      assert.equal(ctx.status, 'IN_STOCK')
      assert.ok(Array.isArray(ctx.images))
      for (const banned of ['purchase_price', 'total_cost', 'expense_total', 'notes',
        'supplier_name', 'supplier_phone', 'seller_name', 'seller_phone', 'asking_price', 'odometer'])
        assert.equal(Object.hasOwn(ctx, banned), false, `context leaks ${banned}`)
      pass('get_post_studio_context returns only the Tier-A safe projection')
    }

    // ---- 2. Status gate ----
    const reserved = await seedVehicle()
    await db.query("UPDATE public.vehicles SET status='RESERVED' WHERE id=$1", [reserved])
    await deny(() => call('staff', 'get_post_studio_context', '$1::uuid', [reserved]), /POST_STUDIO_VEHICLE_UNAVAILABLE/)
    const soldId = await seedVehicle()
    await call('owner', 'sell_vehicle', '$1::jsonb', [JSON.stringify({
      vehicle_id: soldId, customer_name: 'Khách Kiểm Thử', customer_phone: '0912345678',
      sale_price: 35_000_000, sale_date: day, initial_payment: 0, payment_method: 'CASH', request_id: randomUUID(),
    })])
    const soldContext = await call('staff', 'get_post_studio_context', '$1::uuid', [soldId])
    assert.equal(soldContext.status, 'SOLD')
    pass('SOLD vehicles remain available for "xe đã bán" posts; RESERVED are hidden')

    // ---- 3. anon/disabled are locked out ----
    await deny(() => asUser(db, null, (client) => rpc(client, 'get_post_studio_context', '$1::uuid', [inStock]), 'anon'))
    await deny(() => asUser(db, null, (client) => rpc(client, 'list_brand_memory', ''), 'anon'))
    await deny(() => call('disabled', 'save_post_draft', '$1::jsonb', [JSON.stringify({ post_kind: 'NEW_STOCK', channel: 'FACEBOOK', caption: 'x' })]))
    await deny(() => call('disabled', 'get_post_ai_usage', ''))
    pass('Anonymous and disabled roles cannot reach any Post Studio RPC')

    // ---- 4. Draft lifecycle ----
    const draftId = await call('staff', 'save_post_draft', '$1::jsonb', [JSON.stringify({
      vehicle_id: inStock, post_kind: 'NEW_STOCK', channel: 'FACEBOOK', tone: 'Nhung nhu',
      caption: 'Vision 2023 đen nhám vừa về tại Cà Rem.', ai_generated: true,
    })])
    await deny(() => call('manager', 'set_post_draft_status', '$1::uuid,$2::text', [draftId, 'APPROVED']), /ACCESS_DENIED/)
    await deny(() => call('staff', 'set_post_draft_status', '$1::uuid,$2::text', [draftId, 'APPROVED']), /ACCESS_DENIED/)
    const otherDraft = await call('manager', 'save_post_draft', '$1::jsonb', [JSON.stringify({
      post_kind: 'BUYBACK', channel: 'ZALO', caption: 'Cà Rem thu mua xe giá tốt.',
    })])
    await deny(() => call('staff', 'save_post_draft', '$1::jsonb', [JSON.stringify({
      id: otherDraft, post_kind: 'BUYBACK', channel: 'ZALO', caption: 'Sửa trộm nháp người khác.',
    })]), /ACCESS_DENIED/)
    await call('staff', 'save_post_draft', '$1::jsonb', [JSON.stringify({
      id: draftId, vehicle_id: inStock, post_kind: 'NEW_STOCK', channel: 'FACEBOOK',
      caption: 'Vision 2023 đen nhám vừa về — inbox Cà Rem nhé!', ai_generated: false,
    })])
    const staffList = await json('staff', 'list_post_drafts', {})
    assert.equal(staffList.items.length, 1, 'staff sees only own drafts')
    const managerList = await json('manager', 'list_post_drafts', {})
    assert.ok(managerList.items.length >= 2, 'manager sees all drafts')
    await call('owner', 'set_post_draft_status', '$1::uuid,$2::text,$3::boolean', [draftId, 'APPROVED', true])
    await deny(() => call('owner', 'save_post_draft', '$1::jsonb', [JSON.stringify({
      id: draftId, post_kind: 'NEW_STOCK', channel: 'FACEBOOK', caption: 'sửa sau khi duyệt',
    })]), /POST_DRAFT_LOCKED/)
    pass('Drafts: author-only edits for staff, OWNER-only approval, approved rows lock')

    // Stale stock guard: selling the bike then trying to approve an in-stock ad.
    const aging = await call('staff', 'save_post_draft', '$1::jsonb', [JSON.stringify({
      vehicle_id: inStock, post_kind: 'NEW_STOCK', channel: 'ZALO', caption: 'Xe còn ở Cà Rem nha.',
    })])
    await db.query("UPDATE public.vehicles SET status='SOLD' WHERE id=$1", [inStock])
    await deny(() => call('owner', 'set_post_draft_status', '$1::uuid,$2::text', [aging, 'APPROVED']), /POST_STUDIO_STOCK_CHANGED/)
    await db.query("UPDATE public.vehicles SET status='IN_STOCK' WHERE id=$1", [inStock])
    pass('Approving an in-stock ad is blocked when the vehicle left IN_STOCK meanwhile')

    // ---- 5. Version history ----
    const versions = await call('staff', 'list_post_draft_versions', '$1::uuid', [draftId])
    assert.equal(versions.items.length, 2, 'create + edited caption each stored one version')
    assert.equal(versions.items[0].source, 'HUMAN')
    assert.equal(versions.items[1].source, 'AI')
    assert.equal(versions.status, 'APPROVED')
    await deny(() => db.query('UPDATE public.post_draft_edits SET caption=$1 WHERE draft_id=$2', ['tampered', draftId]), /IMMUTABLE_HISTORY/)
    pass('Caption versions append per change and are immutable')

    // ---- 6. Brand memory ----
    const pendingId = await call('manager', 'save_brand_memory', '$1::jsonb', [JSON.stringify({
      entry_type: 'EXAMPLE', channel: 'FACEBOOK', post_kind: 'NEW_STOCK', content: 'Bài mẫu của quản lý chờ chủ quán duyệt.',
    })])
    await deny(() => call('manager', 'save_brand_memory', '$1::jsonb', [JSON.stringify({
      entry_type: 'RULE', content: 'Quản lý không được đặt quy tắc.',
    })]), /ACCESS_DENIED/)
    const forced = await call('staff', 'save_brand_memory', '$1::jsonb', [JSON.stringify({
      entry_type: 'EXAMPLE', channel: 'ZALO', content: 'Nhân viên thử tự duyệt.', status: 'APPROVED',
    })])
    const staffView = await json('staff', 'list_brand_memory', {})
    assert.ok(staffView.items.every((item) => item.status === 'APPROVED'), 'staff never sees PENDING')
    assert.equal(staffView.items.find((item) => item.id === pendingId), undefined)
    const ownerView = await json('owner', 'list_brand_memory', { status: 'PENDING' })
    assert.ok(ownerView.items.some((item) => item.id === pendingId), 'OWNER reviews the pending queue')
    await call('owner', 'approve_brand_memory', '$1::uuid,$2::boolean', [pendingId, true])
    const afterApprove = await json('staff', 'list_brand_memory', {})
    assert.ok(afterApprove.items.some((item) => item.id === pendingId))
    await deny(() => call('staff', 'approve_brand_memory', '$1::uuid,$2::boolean', [pendingId, true]), /ACCESS_DENIED/)
    await deny(() => call('manager', 'approve_brand_memory', '$1::uuid,$2::boolean', [forced, true]), /ACCESS_DENIED/)
    const library = await json('owner', 'list_brand_memory', { status: 'APPROVED' })
    assert.ok(library.items.some((item) => item.source === 'EDITED' && item.content.startsWith('Vision 2023')),
      'approving a draft with p_add_to_library seeded the approved library')
    pass('Brand memory: PENDING queue, OWNER-only rules and approval, staff read APPROVED only')

    // ---- 7. Stock matching for reply assistant ----
    const matches = await call('staff', 'find_matching_vehicles', '$1::text', ['vision đen'])
    const plateMatch = await call('staff', 'find_matching_vehicles', '$1::text', ['43D1-111.22'])
    const soldSearch = await call('staff', 'find_matching_vehicles', '$1::text', [soldContext.license_plate ?? 'zzzz'])
    const items = matches.items.concat(plateMatch.items)
    assert.ok(plateMatch.items.some((item) => item.id === inStock), 'plate token matches the bike')
    for (const item of items) {
      assert.equal(item.status, 'IN_STOCK')
      for (const banned of ['purchase_price', 'notes', 'supplier_phone', 'sale_price'])
        assert.equal(Object.hasOwn(item, banned), false, `search leaks ${banned}`)
    }
    assert.equal(soldSearch.items.find((item) => item.id === soldId), undefined, 'SOLD bikes never match')
    await deny(() => asUser(db, null, (client) => rpc(client, 'find_matching_vehicles', '$1::text', ['vision']), 'anon'))
    pass('find_matching_vehicles searches IN_STOCK Tier-A text only, anon is denied')

    // ---- 8. AI usage metering ----
    await call('staff', 'log_post_ai_usage', '$1::text,$2::text,$3::bigint,$4::bigint,$5::text', ['captions', 'gemini-test', 800, 500, 'OK'])
    await call('staff', 'log_post_ai_usage', '$1::text,$2::text,$3::bigint,$4::bigint,$5::text', ['reply', 'gemini-test', 200, 120, 'QUOTA'])
    await deny(() => call('staff', 'log_post_ai_usage', '$1::text,$2::text', ['hacker', 'x'.repeat(200)]), /INVALID_INPUT/)
    const usage = await call('owner', 'get_post_ai_usage', '$1::integer', [7])
    assert.ok(usage.requests >= 2)
    assert.equal(usage.quota, 1)
    assert.ok(usage.input_tokens + usage.output_tokens >= 1620)
    await deny(() => call('staff', 'get_post_ai_usage', ''), /ACCESS_DENIED/)
    await deny(() => call('manager', 'get_post_ai_usage', ''), /ACCESS_DENIED/)
    await deny(() => db.query('UPDATE public.post_ai_usage SET outcome=$1', ['TAMPERED']), /IMMUTABLE_HISTORY/)
    pass('AI usage metering: staff log validated, OWNER-only aggregate, append-only')

    console.log(`Post Studio AI suite: ${passed} checks passed on ${engine}.\n`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await runPostStudioAiTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
