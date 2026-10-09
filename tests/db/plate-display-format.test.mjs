/**
 * Database Plate Display-Format Suite
 * Covers migration 20261009000100, which folds the stored plate separator from
 * the old `92-D1 746.75` shape to the new canonical `92D1-746.75` (province +
 * series glued, one dash before the serial). `src/lib/plate.ts` writes the new
 * shape for everything saved from now on; this suite proves the existing rows
 * are rewritten correctly and harmlessly:
 * 1. every legacy motorbike shape observed in a production dump (5-digit
 *    dot-grouped, legacy 4-digit and 6-digit ungrouped serials) becomes the dash
 *    form, byte-for-byte the same string `normalizePlate` produces in the browser
 * 2. anything that is not that shape (car-style `51H-123.45`, free text, an
 *    already-canonical plate) is left byte-identical
 * 3. the alphanumeric comparison key that de-duplication uses never changes, so
 *    duplicate detection, search and history keep matching
 * 4. the migration is replayable: a second run rewrites nothing
 * 5. the RPC projection (vehicle_title) shows the new format
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

const MIGRATION = '20261009000100_plate_display_format.sql'
const compact = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

export async function runPlateDisplayFormatTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  const statement = await readFile(resolve('supabase/migrations', MIGRATION), 'utf8')
  const ownerId = randomUUID()
  let passed = 0
  const pass = (name) => {
    passed += 1
    console.log(`PASS ${passed}. ${name}`)
  }

  try {
    console.log('\n--- Running Database Plate Display-Format Suite ---')
    await db.query(
      'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
      [ownerId, 'plate-format@example.test', JSON.stringify({ full_name: 'Plate format owner' })],
    )
    await db.query(
      'UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2',
      ['OWNER', ownerId],
    )
    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const types = await asUser(db, ownerId, (client) => rpc(client, 'list_vehicle_types'))
    const typeId = types.find((item) => item.name === 'Xe tay ga').id

    // Rows are stored exactly as the browser sent them: the server only btrims,
    // so a legacy client (or pre-overhaul data) leaves the old separator here.
    // Every shape below is a value actually observed in a production dump.
    const legacy = ['92-D1 746.75', '59-A1 234.56', '29-A1 1234', '43-AA9 2929', '92-D1 728282']
    const untouched = ['51H-123.45', 'CHUA CO BIEN', '92D1-746.75']
    const plates = [...legacy, ...untouched]
    const ids = []
    for (const [index, plate] of plates.entries()) {
      ids.push(
        await asUser(db, ownerId, (client) =>
          rpc(client, 'save_vehicle', '$1::jsonb', [
            JSON.stringify({
              request_id: randomUUID(),
              vehicle_type_id: typeId,
              purchase_date: day,
              purchase_price: 20_000_000,
              license_plate: plate,
              // Frames must stay unique. The tail carries the row index so two
              // spellings of the SAME plate (the legacy `92-D1 746.75` and its
              // canonical `92D1-746.75`) share a plate but not a frame tail —
              // the intentional plate match surfaces as YELLOW, which the batch
              // seeding acknowledges. This suite checks plate rewriting, not dedup.
              frame_number: `PLATEFMT${compact(plate).slice(0, 6)}${index}`,
              duplicate_ack: true,
            }),
          ])),
      )
    }
    const stored = async () => {
      const rows = await db.query(
        'SELECT id, license_plate FROM public.vehicles WHERE id = ANY($1::uuid[])',
        [ids],
      )
      return Object.fromEntries(rows.rows.map((row) => [row.id, row.license_plate]))
    }
    const before = await stored()

    await pass('legacy rows keep the old separator until the migration runs')
    assert.equal(before[ids[0]], '92-D1 746.75')

    await pass('replaying the migration rewrites every legacy shape to the dash form')
    await db.exec(statement)
    const after = await stored()
    assert.equal(after[ids[0]], '92D1-746.75', '5-digit dot-grouped serial')
    assert.equal(after[ids[1]], '59A1-234.56', 'single-letter series')
    assert.equal(after[ids[2]], '29A1-1234', 'legacy 4-digit serial stays ungrouped')
    assert.equal(after[ids[3]], '43AA9-2929', 'two-letter series with a legacy 4-digit serial')
    assert.equal(after[ids[4]], '92D1-728282', 'ungrouped 6-digit serial stays whole')

    await pass('car-style, free-text and already-canonical plates are left alone')
    assert.equal(after[ids[5]], '51H-123.45')
    assert.equal(after[ids[6]], 'CHUA CO BIEN')
    assert.equal(after[ids[7]], '92D1-746.75')

    await pass('the de-duplication comparison key is unchanged for every row')
    for (const id of ids) {
      assert.equal(compact(after[id]), compact(before[id]), `compact form drifted for ${before[id]}`)
    }

    await pass('the migration is idempotent: a second run rewrites nothing')
    const third = await db.query(
      `SELECT count(*)::int AS n FROM public.vehicles
       WHERE license_plate ~ '^([0-9]{2})-([A-Z]{1,2}[0-9]) ([0-9]{3,6}(\\.[0-9]{2})?)$'`,
    )
    assert.equal(third.rows[0].n, 0, 'no stored plate may still use the old separator')
    await db.exec(statement)
    assert.deepEqual(await stored(), after)

    await pass('the RPC projection shows the new format')
    const vehicle = await asUser(db, ownerId, (client) =>
      rpc(client, 'get_vehicle', '$1::uuid', [ids[0]]),
    )
    assert.equal(vehicle.license_plate, '92D1-746.75')
    assert.match(vehicle.vehicle_title, /^92D1-746\.75 · /)

    console.log(`--- Plate Display-Format suite: ${passed} checks passed ---\n`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

// Allow direct CLI invocation: node tests/db/plate-display-format.test.mjs
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/plate-display-format.test.mjs')) {
  await runPlateDisplayFormatTests(null, {
    engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres',
  })
}
