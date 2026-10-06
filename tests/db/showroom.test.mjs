/**
 * Database Showroom Test Suite (A1 + A2)
 * Covers the public showroom inventory RPC and the lead persistence RPC:
 * 1. anon can list showroom vehicles but sees ONLY IN_STOCK rows
 * 2. the projection never leaks internal/financial columns
 * 3. anon can create BUYBACK and VEHICLE_INQUIRY leads through the RPC
 * 4. phone numbers are normalized and validated at the DB boundary
 * 5. spam throttle (one lead per phone / 10 minutes)
 * 6. inquiries against RESERVED/SOLD vehicles are rejected
 * 7. anon cannot list or triage leads; staff can, with an audit trail
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runShowroomTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Showroom Test Suite (A1/A2) ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'staff'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const anonCall = (name, argsSql = '', values = []) =>
      asUser(db, null, (client) => rpc(client, name, argsSql, values), 'anon')
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|violates check constraint/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query(
        "INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)",
        [id, `showroom-${name}@example.test`, JSON.stringify({ full_name: name })]
      )
      await db.query(
        'UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2',
        [name.toUpperCase(), id]
      )
    }

    const seedVehicle = async (overrides = {}) => {
      const id = await call('owner', 'save_vehicle', {
        request_id: randomUUID(),
        brand: 'Yamaha',
        model: 'Grande',
        license_plate: `SR-${randomUUID().slice(0, 6).toUpperCase()}`,
        purchase_date: day,
        purchase_price: 30_000_000,
        asking_price: 38_000_000,
        ...overrides,
      })
      return id
    }

    // 1. REAL INVENTORY: only IN_STOCK vehicles reach the public showroom.
    const inStockId = await seedVehicle({ color: 'Đỏ', odometer: 12_500 })
    const reservedId = await seedVehicle({ brand: 'Honda', model: 'Vision' })
    await db.query("UPDATE public.vehicles SET status='RESERVED' WHERE id=$1", [reservedId])
    const soldId = await seedVehicle({ brand: 'Piaggio', model: 'Liberty' })
    await db.query("UPDATE public.vehicles SET status='SOLD' WHERE id=$1", [soldId])

    const listing = await anonCall('list_showroom_vehicles', '$1::jsonb', ['{}'])
    const ids = listing.items.map((item) => item.id)
    assert.ok(ids.includes(inStockId), 'IN_STOCK vehicle must be publicly listed')
    assert.ok(!ids.includes(reservedId), 'RESERVED vehicles are excluded from the showroom')
    assert.ok(!ids.includes(soldId), 'SOLD vehicles are excluded from the showroom')
    assert.equal(listing.total, ids.length)
    pass('list_showroom_vehicles exposes only IN_STOCK vehicles to anonymous visitors')

    // 2. SAFE PROJECTION: no internal codes, chassis/engine numbers or costs.
    const listed = listing.items.find((item) => item.id === inStockId)
    for (const leaked of ['internal_code', 'purchase_price', 'frame_number', 'engine_number', 'supplier_name', 'supplier_phone', 'notes', 'total_cost']) {
      assert.equal(Object.hasOwn(listed, leaked), false, `${leaked} must never reach the public payload`)
    }
    assert.equal(listed.asking_price, 38_000_000)
    assert.equal(listed.odometer, 12_500)
    assert.ok(listed.license_plate, 'real license plate is preserved, not invented')
    await seedVehicle({ brand: 'Suzuki', model: 'Pro', odometer: 0 })
    const filtered = await anonCall('list_showroom_vehicles', '$1::jsonb', [JSON.stringify({ search: 'Suzuki Pro' })])
    assert.equal(filtered.items.length, 1)
    assert.equal(filtered.items[0].odometer, null, 'odometer 0 is nulled out, never rendered as fake mileage')
    pass('Public projection keeps real display fields and strips internal/financial data')

    // 3. anon is denied the privileged inventory RPC.
    await deny(() => anonCall('list_vehicles', '$1::jsonb', ['{}']), /permission denied/)
    pass('Anonymous visitors cannot call the staff-only list_vehicles RPC')

    // 4. LEAD PERSISTENCE: anon writes real rows through create_showroom_lead.
    const buybackId = await anonCall(
      'create_showroom_lead',
      '$1::jsonb',
      [JSON.stringify({
        kind: 'BUYBACK',
        customer_name: '  Lê Thị Basta ',
        phone: '+84 91 492 9292',
        vehicle_name: 'Honda Wave Alpha',
        vehicle_year: '2023',
        expected_price: '45000000',
        message: '  ',
      })]
    )
    assert.match(String(buybackId), /^[0-9a-f-]{36}$/)
    const buybackRow = (await db.query('SELECT * FROM public.showroom_leads WHERE id=$1', [buybackId])).rows[0]
    assert.equal(buybackRow.kind, 'BUYBACK')
    assert.equal(buybackRow.customer_name, 'Lê Thị Basta')
    assert.equal(buybackRow.phone, '0914929292', 'phone normalized to canonical 0-prefix')
    assert.equal(buybackRow.vehicle_year, '2023')
    assert.equal(Number(buybackRow.expected_price), 45_000_000)
    assert.equal(buybackRow.message, null, 'blank message collapses to NULL')
    assert.equal(buybackRow.status, 'NEW')
    assert.equal(buybackRow.source, 'SHOWROOM_WEB')
    pass('BUYBACK lead persists with normalized phone and trimmed fields')

    const inquiryId = await anonCall(
      'create_showroom_lead',
      '$1::jsonb',
      [JSON.stringify({
        kind: 'VEHICLE_INQUIRY',
        customer_name: 'Trần Hỏi Mua',
        phone: '84901234567',
        vehicle_id: inStockId,
      })]
    )
    const inquiryRow = (await db.query('SELECT * FROM public.showroom_leads WHERE id=$1', [inquiryId])).rows[0]
    assert.equal(inquiryRow.vehicle_id, inStockId)
    assert.equal(inquiryRow.phone, '0901234567')
    pass('VEHICLE_INQUIRY lead persists against a real IN_STOCK vehicle')

    // 5. VALIDATION at the DB boundary (never trust the browser).
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'BUYBACK', customer_name: 'Đủ Tên', phone: '12345', vehicle_name: 'Xe A' })]),
      /INVALID_PHONE/
    )
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'BUYBACK', customer_name: ' A ', phone: '0914929292', vehicle_name: 'Xe A' })]),
      /INVALID_NAME/
    )
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'BUYBACK', customer_name: 'Đủ Tên', phone: '0914929292', vehicle_name: 'Xe A', expected_price: '45 triệu' })]),
      /INVALID_PRICE/
    )
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'BUYBACK', customer_name: 'Đủ Tên', phone: '0977222333', vehicle_year: '2023' })]),
      /INVALID_VEHICLE_NAME/
    )
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'BOGUS', customer_name: 'Đủ Tên', phone: '0914929292' })]),
      /INVALID_KIND/
    )
    pass('Lead RPC rejects invalid phone, name, price, missing vehicle name and bogus kinds')

    // 6. Inquiries must target genuinely sellable stock.
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'VEHICLE_INQUIRY', customer_name: 'Khách Nhầm', phone: '0977111222', vehicle_id: reservedId })]),
      /VEHICLE_NOT_FOUND/
    )
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'VEHICLE_INQUIRY', customer_name: 'Khách Nhầm', phone: '0977111222', vehicle_id: soldId })]),
      /VEHICLE_NOT_FOUND/
    )
    pass('VEHICLE_INQUIRY is rejected for RESERVED and SOLD vehicles')

    // 7. Spam throttle: one lead per phone per 10 minutes.
    await deny(
      () => anonCall('create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'BUYBACK', customer_name: 'Khách Spam', phone: '0914929292', vehicle_name: 'Wave RSX' })]),
      /LEAD_TOO_FREQUENT/
    )
    pass('Duplicate submissions from the same phone within 10 minutes are throttled')

    // 8. anon cannot read or triage leads (read is staff-only).
    await deny(() => anonCall('list_showroom_leads', '$1::jsonb', ['{}']), /permission denied/)
    await deny(
      () => anonCall('update_showroom_lead_status', '$1::uuid,$2::text', [buybackId, 'SPAM']),
      /permission denied/
    )
    // Direct table access stays closed for browser roles.
    await deny(() => asUser(db, null, (client) => client.query('SELECT * FROM public.showroom_leads'), 'anon'), /permission denied|row-level security/)
    await deny(() => run('staff', (client) => client.query('SELECT * FROM public.showroom_leads')), /permission denied|row-level security/)
    pass('Lead table is unreachable directly; anon cannot list or triage leads')

    // 9. Staff triage flow with audit trail.
    const staffListing = await call('staff', 'list_showroom_leads', { status: 'NEW' })
    assert.equal(staffListing.total, 2)
    assert.deepEqual(staffListing.items.map((lead) => lead.id).sort(), [String(buybackId), String(inquiryId)].sort())
    await run('staff', (client) => rpc(client, 'update_showroom_lead_status', '$1::uuid,$2::text', [buybackId, 'CONTACTED']))
    assert.equal((await call('staff', 'list_showroom_leads', { status: 'NEW' })).total, 1)
    const audit = (await db.query("SELECT * FROM public.audit_logs WHERE action='UPDATE_SHOWROOM_LEAD_STATUS'")).rows
    assert.equal(audit.length, 1)
    assert.equal(audit[0].user_id, users.staff)
    assert.equal(audit[0].old_data.status, 'NEW')
    assert.equal(audit[0].new_data.status, 'CONTACTED')
    await deny(
      () => run('staff', (client) => rpc(client, 'update_showroom_lead_status', '$1::uuid,$2::text', [buybackId, 'BOGUS'])),
      /INVALID_STATUS/
    )
    await deny(
      () => run('staff', (client) => rpc(client, 'update_showroom_lead_status', '$1::uuid,$2::text', [randomUUID(), 'SPAM'])),
      /LEAD_NOT_FOUND/
    )
    const branded = await anonCall('list_showroom_vehicles', '$1::jsonb', [JSON.stringify({ brand: 'Yamaha' })])
    assert.equal(branded.total, 1, 'only the remaining IN_STOCK Yamaha is listed')
    assert.equal(branded.items[0].id, inStockId)
    assert.equal(Object.hasOwn(branded.items[0], 'status'), false, 'internal status enum is not part of the public projection')
    pass('Brand filters match real stock and the final listing count is deterministic')

    console.log(`--- All ${passed} Showroom database tests passed! ---\n`)
  } finally {
    if (ownDb) await db.close()
  }
}

// Allow direct CLI invocation: node tests/db/showroom.test.mjs
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/showroom.test.mjs')) {
  const engine = process.argv.includes('--pglite') ? 'pglite' : 'postgres'
  await runShowroomTests(null, { engine })
}
