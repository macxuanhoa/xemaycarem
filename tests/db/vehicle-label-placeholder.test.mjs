/**
 * Database Placeholder-Frame Label Suite
 * `save_vehicle`/`acquire_vehicle` still store a `GEN-<uuid>` placeholder when the
 * chassis number is unknown (it preserves the UNIQUE identity contract), but the
 * display layer must NEVER surface that hash. Migration
 * 20261011000200_hide_gen_frame_in_label.sql teaches private.vehicle_label_text
 * to treat `GEN-%` exactly like an empty frame:
 * 1. pure label function: GEN frame + plate → "plate · chưa có khung"
 * 2. GEN frame without plate falls back to the readable internal code
 * 3. real frames keep the old "Biển · Khung" output byte-for-byte
 * 4. end-to-end: save_vehicle with an empty frame stores GEN-… yet every RPC
 *    projection (get_vehicle / list_vehicles vehicle_title) shows "chưa có khung"
 * 5. editing the vehicle while leaving the frame empty keeps the SAME placeholder
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runVehicleLabelPlaceholderTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Placeholder-Frame Label Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const owner = randomUUID()
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [owner, 'label-owner@example.test', JSON.stringify({ full_name: 'owner' })])
    await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2', ['OWNER', owner])
    const run = (fn) => asUser(db, owner, fn)
    const call = (name, data, id) => run((client) => rpc(client, name, id ? '$1::jsonb,$2::uuid' : '$1::jsonb', id ? [JSON.stringify(data), id] : [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const label = async (plate, frame, code) => (await row('SELECT private.vehicle_label_text($1,$2,$3) AS l', [plate, frame, code])).l

    await pass('GEN placeholder frame with a plate reads "biển · chưa có khung"')
    assert.equal(await label('59A1-234.56', 'GEN-57410906-db6', 'XE-2026-000001'), '59A1-234.56 · chưa có khung')
    assert.equal(await label('59A1-234.56', 'GEN-a1b2c3d4-e5f', null), '59A1-234.56 · chưa có khung')

    await pass('GEN placeholder without a plate falls back to the internal code, never the hash')
    assert.equal(await label('', 'GEN-57410906-db6', 'XE-2026-000002'), 'XE-2026-000002')
    assert.equal(await label(null, 'GEN-57410906-db6', null), 'xe không rõ danh tính')

    await pass('real frames keep the exact "Biển · Khung" output')
    assert.equal(await label('59A1-234.56', 'MH1JC1234567890', 'XE-2026-000003'), '59A1-234.56 · MH1JC1234567890')
    assert.equal(await label('', 'MH1JC1234567890', 'XE-2026-000003'), 'chưa có biển · MH1JC1234567890')
    // A frame merely CONTAINING "gen" is real data, not the placeholder prefix.
    assert.equal(await label('29B1-123.45', 'GEN5XU12345678901', 'XE-2026-000004'), '29B1-123.45 · GEN5XU12345678901')

    await pass('save_vehicle with an empty frame stores GEN-… but titles hide it')
    const day = (await row('SELECT private.today()::text AS day')).day
    const plate = `LBL-${randomUUID().slice(0, 5).toUpperCase()}`
    const id = await call('save_vehicle', {
      request_id: randomUUID(), vehicle_type: 'Xe số', license_plate: plate,
      frame_number: '', purchase_date: day, purchase_price: 10_000_000,
    })
    const stored = await row('SELECT frame_number FROM public.vehicles WHERE id=$1', [id])
    assert.match(stored.frame_number, /^GEN-/, 'the storage placeholder is unchanged')
    const detail = await run((client) => rpc(client, 'get_vehicle', '$1::uuid', [id]))
    assert.equal(detail.vehicle_title, `${plate} · chưa có khung`)
    assert.ok(!JSON.stringify(detail.vehicle_title).includes('GEN-'))
    const listed = await call('list_vehicles', { limit: 50 })
    const listedRow = listed.items.find((item) => item.id === id)
    assert.equal(listedRow.vehicle_title, `${plate} · chưa có khung`)

    await pass('editing with an empty frame keeps the same placeholder, still shows "chưa có khung"')
    await call('save_vehicle', { purchase_price: 10_000_000 }, id)
    const kept = await row('SELECT frame_number FROM public.vehicles WHERE id=$1', [id])
    assert.equal(kept.frame_number, stored.frame_number)
    assert.equal((await run((client) => rpc(client, 'get_vehicle', '$1::uuid', [id]))).vehicle_title, `${plate} · chưa có khung`)

    await pass('filling the real chassis later switches the title to plate · frame')
    await call('save_vehicle', { frame_number: 'MH1JC1234567890' }, id)
    assert.equal((await run((client) => rpc(client, 'get_vehicle', '$1::uuid', [id]))).vehicle_title, `${plate} · MH1JC1234567890`)

    console.log(`${passed} placeholder-frame label checks passed on ${engine}.`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runVehicleLabelPlaceholderTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
    .then(() => process.exit(0))
    .catch((error) => { console.error(error); process.exit(1) })
}
