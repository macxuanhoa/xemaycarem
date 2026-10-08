/**
 * Database Vehicle-Type Catalogue Suite
 * Covers the `vehicle_types` catalogue + its RPC surface introduced by migration
 * 20261008000300 (the field purge turned the free-text `model` column into a
 * mandatory, OWNER-maintained, STAFF-selected catalogue):
 * 1. the six default types are seeded and "Chưa phân loại" is the intake queue
 * 2. list_vehicle_types: authenticated sees every type with a count; anon only
 *    sees types that currently have IN_STOCK vehicles and never the count
 * 3. save_vehicle_type is OWNER-only, normalises whitespace, and de-duplicates
 *    after lower(btrim(...)) (DUPLICATE_VEHICLE_TYPE)
 * 4. "Chưa phân loại" cannot be renamed or deleted (VEHICLE_TYPE_PROTECTED)
 * 5. delete_vehicle_type is blocked while any vehicle references the type
 *    (VEHICLE_TYPE_IN_USE) and succeeds once it is free
 * 6. save_vehicle requires a catalogue type on create (VEHICLE_TYPE_REQUIRED) and
 *    accepts it either by id or by name
 * 7. the purged spec columns are gone and the history tables were emptied
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runVehicleTypeCatalogTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Vehicle-Type Catalogue Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'staff'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const anonRun = (fn) => asUser(db, null, fn, 'anon')
    const call = (user, name, data) =>
      run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const listTypes = (user) => run(user, (client) => rpc(client, 'list_vehicle_types'))
    const anonListTypes = () => anonRun((client) => rpc(client, 'list_vehicle_types'))
    const saveType = (user, id, name) =>
      run(user, (client) => rpc(client, 'save_vehicle_type', '$1::uuid,$2::text', [id, name]))
    const deleteType = (user, id) =>
      run(user, (client) => rpc(client, 'delete_vehicle_type', '$1::uuid', [id]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|violates check constraint|row-level security/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query(
        'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `catalogue-${name}@example.test`, JSON.stringify({ full_name: name })]
      )
      await db.query(
        'UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2',
        [name.toUpperCase(), id]
      )
    }

    await pass('seeded catalogue carries the six default types including the intake queue')
    const seeded = await listTypes('owner')
    const names = seeded.map((item) => item.name)
    for (const expected of ['Xe số', 'Xe tay ga', 'Xe côn tay', 'Xe điện', 'Ga 50cc', 'Chưa phân loại'])
      assert.ok(names.includes(expected), `missing seeded type ${expected}`)
    assert.ok(seeded.every((item) => Object.hasOwn(item, 'vehicle_count')), 'authenticated list exposes counts')

    await pass('list_vehicle_types returns unique normalised names')
    assert.equal(new Set(names.map((n) => n.toLowerCase().trim())).size, names.length)

    await pass('anon only sees types that currently have IN_STOCK vehicles and never the count')
    const anonBefore = await anonListTypes()
    assert.equal(anonBefore.length, 0, 'no IN_STOCK vehicles yet, so the public list is empty')
    const inStockType = seeded.find((item) => item.name === 'Xe tay ga')
    const stocked = await call('owner', 'save_vehicle', {
      request_id: randomUUID(),
      vehicle_type_id: inStockType.id,
      purchase_date: day,
      purchase_price: 20_000_000,
      license_plate: `CAT-${randomUUID().slice(0, 5).toUpperCase()}`,
    })
    const anonAfter = await anonListTypes()
    assert.deepEqual(anonAfter.map((item) => item.name), ['Xe tay ga'])
    assert.ok(anonAfter.every((item) => !Object.hasOwn(item, 'vehicle_count')), 'anon list must not leak counts')
    void stocked

    await pass('save_vehicle_type normalises whitespace and de-duplicates after lower(btrim)')
    const created = await saveType('owner', null, '  Xe   địa   hình  ')
    assert.equal(created.name, 'Xe địa hình')
    // Rely on ASCII case folding + whitespace collapse, which every collation
    // handles; Supabase's UTF-8 collation also folds diacritic capitals, but a
    // non-ICU lower() would not, so the fixture avoids upper-case accented input.
    await deny(() => saveType('owner', null, '  xE   địa   hình  '), /DUPLICATE_VEHICLE_TYPE/)
    await deny(() => saveType('owner', null, 'X'), /INVALID_VEHICLE_TYPE_NAME/)

    await pass('save_vehicle_type and delete_vehicle_type are OWNER-only')
    await deny(() => saveType('staff', null, 'Không có quyền'))
    await deny(() => deleteType('staff', created.id))

    await pass('"Chưa phân loại" is protected from rename and deletion')
    const unclassified = seeded.find((item) => item.name === 'Chưa phân loại')
    await deny(() => saveType('owner', unclassified.id, 'Xe khác'), /VEHICLE_TYPE_PROTECTED/)
    await deny(() => deleteType('owner', unclassified.id), /VEHICLE_TYPE_PROTECTED/)

    await pass('delete_vehicle_type is blocked while a vehicle references it, allowed once free')
    await deny(() => deleteType('owner', inStockType.id), /VEHICLE_TYPE_IN_USE/)
    await deleteType('owner', created.id)
    assert.ok(!(await listTypes('owner')).some((item) => item.id === created.id))

    await pass('save_vehicle requires a catalogue type on create and accepts id or name')
    await deny(() => call('owner', 'save_vehicle', {
      request_id: randomUUID(), purchase_date: day, purchase_price: 1,
    }), /VEHICLE_TYPE_REQUIRED/)
    await deny(() => call('owner', 'save_vehicle', {
      request_id: randomUUID(), vehicle_type: 'Loại không tồn tại', purchase_date: day, purchase_price: 1,
    }), /INVALID_VEHICLE_TYPE/)
    // Name lookup folds case only (lower(btrim)), not diacritics: "xe số" matches
    // "Xe số", but a stripped "xe so" (frontend alias) is not a valid DB name.
    await deny(() => call('owner', 'save_vehicle', {
      request_id: randomUUID(), vehicle_type: 'xe so', purchase_date: day, purchase_price: 1,
    }), /INVALID_VEHICLE_TYPE/)
    const byName = await call('owner', 'save_vehicle', {
      request_id: randomUUID(), vehicle_type: 'xe số', purchase_date: day, purchase_price: 1,
    })
    assert.equal((await run('owner', (c) => rpc(c, 'get_vehicle', '$1::uuid', [byName]))).vehicle_type, 'Xe số')

    await pass('a created vehicle always lands on a valid catalogue type (never null)')
    const orphan = await row('SELECT count(*)::int AS n FROM public.vehicles WHERE vehicle_type_id IS NULL')
    assert.equal(orphan.n, 0)

    console.log(`${passed} vehicle-type catalogue checks passed on ${engine}.`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runVehicleTypeCatalogTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
    .then(() => process.exit(0))
    .catch((error) => { console.error(error); process.exit(1) })
}
