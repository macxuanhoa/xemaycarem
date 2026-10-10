import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runVehicleIdentifierLookupTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled', 'deleted'].map((name) => [name, randomUUID()]))
  let passed = 0
  const test = async (name, check) => { await check(); console.log(`PASS ${++passed}. ${name}`) }
  const lookup = (name, plate = null, frame = null) => asUser(db, users[name], (client) => rpc(client, 'lookup_vehicle_identifiers', '$1::text,$2::text', [plate, frame]))
  let typeId
  const bike = async ({ plate = '', frame = '', kind = 'FULL', status = 'IN_STOCK', createdAt = '2026-01-01T00:00:00Z' } = {}) => {
    const id = randomUUID()
    await db.query('INSERT INTO public.vehicles(id,vehicle_type_id,license_plate,frame_number,frame_input_kind,status,created_by,created_at,notes,supplier_phone) VALUES($1,$2,$3,$4,$5,$6::public.vehicle_status,$7,$8,$9,$10)', [id, typeId, plate, frame, kind, status, users.owner, createdAt, 'PRIVATE-NOTES', 'PRIVATE-PHONE'])
    return id
  }
  const identities = (rows) => rows.map((row) => row.id).sort()
  const empty = { plate_matches: [], frame_matches: [] }
  try {
    console.log('\n--- Running whole-inventory exact camera lookup suite ---')
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `identifier-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2,deleted_at=$3 WHERE id=$4', [name === 'owner' ? 'OWNER' : name === 'manager' ? 'MANAGER' : 'STAFF', name !== 'disabled', name === 'deleted' ? '2026-01-01' : null, id])
    }
    typeId = (await db.query("SELECT id FROM public.vehicle_types WHERE name='Xe tay ga' LIMIT 1")).rows[0].id
    const exact = await bike({ plate: '59-A1 234.56', frame: 'RLH-12345678901234' })
    // Newer searchable text shadows this old exact bike on the old first page.
    for (let i = 0; i < 30; i++) {
      await bike({ plate: `30B1-${String(10000 + i)}`, frame: `OTHERFRAME${String(10000 + i)}`, createdAt: '2026-02-01T00:00:00Z' })
    }
    await db.query("UPDATE public.vehicles SET color='59A1-234.56 RLH12345678901234' WHERE id<>$1", [exact])
    await test('exact plate/full frame find an older vehicle beyond the substring first page', async () => {
      const page = await asUser(db, users.staff, (client) => rpc(client, 'list_vehicles', '$1::jsonb', [JSON.stringify({ search: '59A1-234.56', limit: 25 })]))
      assert.equal(page.items.length, 25)
      assert.ok(!page.items.some((row) => row.id === exact))
      const found = await lookup('staff', '59 a1 234.56', 'rlh 12345678901234')
      assert.deepEqual(identities(found.plate_matches), [exact])
      assert.deepEqual(identities(found.frame_matches), [exact])
    })
    await test('both identifier result sets expose identity fields only and do not mutate records', async () => {
      const before = (await db.query('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.audit_logs) AS audits')).rows[0]
      for (const name of ['owner', 'manager', 'staff']) {
        const found = await lookup(name, '59A123456', 'RLH12345678901234')
        for (const row of [...found.plate_matches, ...found.frame_matches]) {
          assert.deepEqual(Object.keys(row).sort(), ['frame_number', 'id', 'internal_code', 'license_plate', 'status', 'vehicle_type'])
          assert.equal(row.vehicle_type, 'Xe tay ga')
        }
      }
      assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.audit_logs) AS audits')).rows[0], before)
    })
    await test('all repeated plates are returned with no result cap, preserving ambiguity', async () => {
      const ids = []
      for (let i = 0; i < 31; i++) ids.push(await bike({ plate: '61B1-777.77', frame: `DUPPLATEFRAME${10000 + i}` }))
      assert.deepEqual(identities((await lookup('staff', '61b1 777.77')).plate_matches), ids.sort())
    })
    await test('contradicting plate and chassis stay in separate result sets for client conflict', async () => {
      const other = await bike({ plate: '30B2-555.55', frame: 'RLHOTHERFRAME555' })
      const found = await lookup('owner', '59A1-234.56', 'RLHOTHERFRAME555')
      assert.deepEqual(identities(found.plate_matches), [exact])
      assert.deepEqual(identities(found.frame_matches), [other])
    })
    await test('short fragments, ambiguous glyphs, serial-only plates and wildcards never assert identity', async () => {
      await bike({ frame: 'AB123456', kind: 'PARTIAL' })
      for (const [plate, frame] of [
        ['', 'AB123456'], ['', '78901234'], ['', 'RLH12345678901234%'], ['', 'RLH12345?78901234'],
        ['23456', ''], ['59A1-234.?6', ''], ['59A1-234.56%', ''], ['59A1-234.56/', ''],
        [null, 'GEN-12345678901234'], [null, null], ['%', '_'],
      ]) assert.deepEqual(await lookup('staff', plate, frame), empty)
    })
    await test('sold/cancelled records retain inventory visibility while pending deletion is excluded', async () => {
      const sold = await bike({ plate: '62C1-222.22', frame: 'RLHSOLDFRAME222', status: 'SOLD' })
      const cancelled = await bike({ plate: '63D1-333.33', frame: 'RLHCANCELFRAME333', status: 'CANCELLED' })
      assert.deepEqual(identities((await lookup('staff', null, 'RLHSOLDFRAME222')).frame_matches), [sold])
      assert.deepEqual(identities((await lookup('staff', null, 'RLHCANCELFRAME333')).frame_matches), [cancelled])
      await db.query("INSERT INTO public.approval_requests(kind,subject_id,requested_by,reason) VALUES('VEHICLE_DELETION',$1,$2,'Kiểm thử ẩn khỏi kho')", [exact, users.staff])
      for (const name of ['owner', 'manager', 'staff']) assert.deepEqual(await lookup(name, '59A1-234.56', 'RLH12345678901234'), empty)
    })
    await test('anonymous, disabled and deleted accounts cannot read exact inventory identity', async () => {
      for (const name of ['disabled', 'deleted']) await assert.rejects(() => lookup(name, '61B1-777.77'), /ACCESS_DENIED|ACCOUNT_DISABLED|ACCOUNT_DELETED|permission denied/i)
      await assert.rejects(() => asUser(db, null, (client) => rpc(client, 'lookup_vehicle_identifiers', '$1::text,$2::text', ['61B1-777.77', null]), 'anon'), /permission denied/i)
    })
    await test('a permanently purged vehicle disappears from both identifier reads', async () => {
      const id = await bike({ plate: '64E1-444.44', frame: 'RLHPURGEFRAME444' })
      assert.deepEqual(identities((await lookup('owner', '64E1-444.44')).plate_matches), [id])
      await asUser(db, users.owner, (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [id, 'Xe kiểm thử cần xóa vĩnh viễn']))
      assert.deepEqual(await lookup('owner', '64E1-444.44', 'RLHPURGEFRAME444'), empty)
    })
    await test('the RPC has a fixed search path and oversized inputs fail closed', async () => {
      const fn = (await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.lookup_vehicle_identifiers(text,text)'::regprocedure")).rows[0]
      assert.equal(fn.prosecdef, true)
      assert.ok(fn.proconfig.some((entry) => entry.startsWith('search_path=')))
      await assert.rejects(() => lookup('owner', 'A'.repeat(201)), /INVALID_VEHICLE_IDENTIFIER/)
    })
    console.log(`--- Vehicle identifier lookup: ${passed} checks passed ---`)
    return passed
  } finally {
    if (!externalDb) await db.close()
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/vehicle-identifier-lookup.test.mjs')) {
  try { await runVehicleIdentifierLookupTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' }) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
