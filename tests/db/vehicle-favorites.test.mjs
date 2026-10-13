/**
 * Database "Xe yêu thích" Test Suite
 * Covers migration 20261014000600_vehicle_favorites:
 *  1. Toggle contract: favorite on → off → on, server returns the authoritative flag.
 *  2. Per-user isolation: a star is visible to its owner only, never to other roles.
 *  3. Projections: get_vehicle and every list_vehicles item carry `is_favorite`.
 *  4. list_vehicles favorite filter: only my starred vehicles, composable with status.
 *  5. Validation: unknown vehicle → VEHICLE_NOT_FOUND; disabled/anon denied.
 *  6. Table privileges: clients get SELECT (own rows only) — direct writes are denied.
 *  7. Cascade: purging a vehicle removes its favorite rows and shrinks the filter.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runVehicleFavoriteTests(externalDb, { engine = 'pglite' } = {}) {
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Vehicle Favorites Test Suite ---')
    let passed = 0
    const pass = (name) => console.log(`PASS ${++passed}. ${name}`)

    const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) =>
      data === undefined ? rpc(client, name) : rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const deny = (operation, expression = /ACCESS_DENIED|VEHICLE_NOT_FOUND|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `fav-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2 WHERE id=$3', [
        name === 'disabled' ? 'STAFF' : name.toUpperCase(),
        name !== 'disabled',
        id,
      ])
    }

    let vehicleSeq = 0
    const newVehicle = (overrides = {}) => call('staff', 'save_vehicle', {
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga', license_plate: `YTH-${String(++vehicleSeq).padStart(3, '0')}${randomUUID().slice(0, 4).toUpperCase()}`,
      frame_number: `FRAMEFAV${randomUUID().slice(0, 8)}`, purchase_date: day,
      purchase_price: 40_000_000, ...overrides,
    })
    const toggle = (user, id) => run(user, (client) => rpc(client, 'toggle_vehicle_favorite', '$1::uuid', [id]))
    const getVehicle = (user, id) => run(user, (client) => rpc(client, 'get_vehicle', '$1::uuid', [id]))
    const vehicles = (user, filters = {}) => call(user, 'list_vehicles', filters)

    const first = await newVehicle()
    const second = await newVehicle()
    const third = await newVehicle()

    // 1. Toggle contract.
    const on = await toggle('staff', first)
    assert.deepEqual(on, { vehicle_id: first, favorite: true })
    const off = await toggle('staff', first)
    assert.deepEqual(off, { vehicle_id: first, favorite: false })
    const again = await toggle('staff', first)
    assert.equal(again.favorite, true)
    pass('toggle_vehicle_favorite flips the star and always returns the authoritative state')

    // 2. Per-user isolation.
    await toggle('staff', second)
    await toggle('owner', third)
    assert.equal((await getVehicle('staff', first)).is_favorite, true)
    assert.equal((await getVehicle('owner', first)).is_favorite, false)
    assert.equal((await getVehicle('manager', first)).is_favorite, false)
    assert.equal((await getVehicle('owner', third)).is_favorite, true)
    assert.equal((await getVehicle('staff', third)).is_favorite, false)
    pass('A star belongs to its owner: other roles never inherit it')

    // 3. List projection carries the per-user flag on every item.
    const all = await vehicles('staff', { status: 'ALL' })
    assert.equal(all.total, 3)
    const byStaff = Object.fromEntries(all.items.map((item) => [item.id, item.is_favorite]))
    assert.deepEqual(byStaff, { [first]: true, [second]: true, [third]: false })
    const forOwner = await vehicles('owner', { status: 'ALL' })
    assert.ok(forOwner.items.every((item) => item.is_favorite === (item.id === third)))
    pass('list_vehicles stamps is_favorite from the caller JWT on every row')

    // 4. Favorite filter (the "Yêu thích" pill).
    const mine = await vehicles('staff', { favorite: 'true' })
    assert.equal(mine.total, 2)
    assert.deepEqual(mine.items.map((item) => item.id).sort(), [first, second].sort())
    const theirs = await vehicles('owner', { favorite: 'true' })
    assert.deepEqual(theirs.items.map((item) => item.id), [third])
    // An empty/absent favorite key behaves exactly like the old contract.
    assert.equal((await vehicles('staff', { favorite: '' })).total, 3)
    assert.equal((await vehicles('staff', {})).total, 3)
    pass("p_filters.favorite=true returns only the caller's starred vehicles; other values are inert")

    // 5. Validation and access gates.
    await deny(() => toggle('staff', randomUUID()), /VEHICLE_NOT_FOUND/)
    await deny(() => toggle('disabled', first))
    await deny(() => asUser(db, null, (client) => rpc(client, 'toggle_vehicle_favorite', '$1::uuid', [first]), 'anon'), /permission denied|does not exist|ACCESS_DENIED/i)
    pass('Unknown vehicle, disabled accounts and anon cannot write the star list')

    // 6. Direct table access: read own rows only, no writes from the browser.
    const staffVisible = await run('staff', (client) => client.query('SELECT vehicle_id FROM public.vehicle_favorites'))
    assert.deepEqual(staffVisible.rows.map((r) => r.vehicle_id).sort(), [first, second].sort())
    await deny(() => run('staff', (client) => client.query('INSERT INTO public.vehicle_favorites(user_id, vehicle_id) VALUES($1,$2)', [users.staff, third])), /permission denied|row-level security/)
    await deny(() => run('staff', (client) => client.query('DELETE FROM public.vehicle_favorites WHERE user_id=$1', [users.staff])), /permission denied|row-level security/)
    // RLS does not error on reads; it simply hides other people's rows.
    const ownerVisible = await run('owner', (client) => client.query('SELECT * FROM public.vehicle_favorites WHERE user_id=$1', [users.staff]))
    assert.equal(ownerVisible.rows.length, 0)
    pass('vehicle_favorites is SELECT-own-rows only; every write path goes through the RPC')

    // 7. Cascade with the vehicle purge.
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicle_favorites WHERE vehicle_id=$1', [first]), 1)
    await run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [first, 'Dọn xe kiểm thử yêu thích']))
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicle_favorites WHERE vehicle_id=$1', [first]), 0)
    assert.equal((await vehicles('staff', { favorite: 'true' })).total, 1)
    pass('Purging a vehicle drops its favorite rows and the filter count follows')

    console.log(`\n${passed} vehicle favorite checks passed on ${engine}.`)
  } finally {
    if (!externalDb) await db.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('vehicle-favorites.test.mjs')) {
  const engine = process.argv.includes('--pglite') ? 'pglite' : 'postgres'
  console.log(`Vehicle favorites suite: ${engine}`)
  runVehicleFavoriteTests(null, { engine }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
