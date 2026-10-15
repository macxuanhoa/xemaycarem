/**
 * Database "primary_image_path on list_vehicles" Test Suite
 * Covers migration 20261015000100_inventory_list_primary_image:
 *  1. A vehicle with no images projects primary_image_path = null.
 *  2. The primary is the non-deleted image with the lowest display_order
 *     (tie-broken by earliest created_at).
 *  3. Soft-deleted images are skipped; the next-lowest becomes the primary.
 *  4. The list projection exposes ONLY the relative path — never a full URL,
 *     never the whole images array (that stays on get_vehicle).
 *  5. Financial masking is untouched: STAFF still cannot read the private cost.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runInventoryPrimaryImageTests(externalDb, { engine = 'pglite' } = {}) {
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Inventory Primary Image Test Suite ---')
    let passed = 0
    const pass = (name) => console.log(`PASS ${++passed}. ${name}`)

    const users = Object.fromEntries(['owner', 'staff'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) =>
      rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `pimg-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2,can_view_financials=$3 WHERE id=$4', [
        name.toUpperCase(), true, name === 'owner', id,
      ])
    }

    let seq = 0
    const newVehicle = async () => call('staff', 'save_vehicle', {
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga',
      license_plate: `PIMG-${String(++seq).padStart(3, '0')}${randomUUID().slice(0, 4).toUpperCase()}`,
      frame_number: `FRAMEPIMG${randomUUID().slice(0, 8)}`,
      purchase_date: day,
      purchase_price: 40_000_000,
    })

    // Insert an image row directly (owner connection bypasses RLS), mirroring the
    // shape register_vehicle_image produces. created_at is pinned so the tie-break
    // is deterministic across engines.
    const addImage = (vehicleId, storagePath, displayOrder, createdAt, deletedAt = null) =>
      db.query(
        'INSERT INTO public.vehicle_images(vehicle_id,storage_path,display_order,created_by,created_at,deleted_at) VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)',
        [vehicleId, storagePath, displayOrder, users.staff, createdAt, deletedAt],
      )

    const primaryOf = async (vehicleId) => {
      // list_vehicles search never matches a UUID, so read the newest page and
      // locate by id — freshly saved vehicles sort first under the default 'newest'.
      const list = await call('staff', 'list_vehicles', { status: 'ALL', limit: 100 })
      const item = list.items.find((i) => i.id === vehicleId)
      assert.ok(item, 'the vehicle must appear in list_vehicles')
      return item
    }

    // 1. No images -> null.
    const bare = await newVehicle()
    assert.equal((await primaryOf(bare)).primary_image_path, null)
    pass('A vehicle without images projects primary_image_path = null')

    // 2. Lowest display_order wins; ties break by earliest created_at.
    const v2 = await newVehicle()
    await addImage(v2, `veh/${v2}/order5.jpg`, 5, '2026-01-05T00:00:00Z')
    await addImage(v2, `veh/${v2}/order1.jpg`, 1, '2026-01-06T00:00:00Z')
    await addImage(v2, `veh/${v2}/order1-early.jpg`, 1, '2026-01-01T00:00:00Z')
    assert.equal((await primaryOf(v2)).primary_image_path, `veh/${v2}/order1-early.jpg`)
    pass('The primary is the lowest display_order, tie-broken by earliest created_at')

    // 3. Soft-deleting the primary promotes the next candidate.
    await db.query('UPDATE public.vehicle_images SET deleted_at=now() WHERE storage_path=$1', [`veh/${v2}/order1-early.jpg`])
    assert.equal((await primaryOf(v2)).primary_image_path, `veh/${v2}/order1.jpg`)
    await db.query('UPDATE public.vehicle_images SET deleted_at=now() WHERE storage_path=$1', [`veh/${v2}/order1.jpg`])
    assert.equal((await primaryOf(v2)).primary_image_path, `veh/${v2}/order5.jpg`)
    pass('Soft-deleted images are skipped; the next-lowest becomes the primary')

    // 4. Only the relative path leaks into the list — never a URL or the array.
    const item = await primaryOf(v2)
    assert.ok(!('images' in item), 'list item must not carry the full images array')
    assert.ok(!/^https?:\/\//.test(item.primary_image_path), 'primary_image_path must be a relative storage path')
    const detail = await run('staff', (client) => rpc(client, 'get_vehicle', '$1::uuid', [v2]))
    assert.ok(Array.isArray(detail.images) && detail.images.length === 1, 'get_vehicle still returns the remaining image')
    pass('list_vehicles exposes only a relative path; the images array stays on get_vehicle')

    // 5. Financial masking untouched — a non-financial STAFF still sees no totals.
    assert.ok(!('total_cost' in item), 'STAFF without financial rights must not get total_cost')
    assert.ok(!('expense_total' in item), 'STAFF without financial rights must not get expense_total')
    const ownerList = await call('owner', 'list_vehicles', { status: 'ALL', limit: 100 })
    const ownerItem = ownerList.items.find((i) => i.id === v2)
    assert.ok(ownerItem && 'total_cost' in ownerItem, 'OWNER still receives total_cost')
    assert.equal(ownerItem.primary_image_path, item.primary_image_path, 'path is identical for every reader')
    pass('Adding primary_image_path did not disturb the financial read mask')

    console.log(`\n${passed} inventory primary-image checks passed on ${engine}.`)
  } finally {
    if (!externalDb) await db.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('inventory-list-primary-image.test.mjs')) {
  const engine = process.argv.includes('--postgres') ? 'postgres' : 'pglite'
  console.log(`Inventory primary-image suite: ${engine}`)
  runInventoryPrimaryImageTests(null, { engine }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
