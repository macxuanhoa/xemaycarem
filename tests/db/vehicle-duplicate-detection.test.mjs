/*
 * Database Smart Vehicle Duplicate-Detection Suite
 * Covers migration 20261009000200: the tri-state GREEN/YELLOW/RED engine that
 * runs inside save_vehicle_impl / acquire_vehicle_impl (and the
 * check_vehicle_duplicates preview RPC). Proves the plan's invariants:
 * 1. HARD identity stays with the FULL frame — a second FULL VIN collision is
 *    RED (DUPLICATE_FRAME_NUMBER), even though there is no longer a plain
 *    UNIQUE(frame_number) constraint.
 * 2. PLATE + last-5 together is RED regardless of frame kind (same plate AND
 *    same final five characters ⇒ treated as one bike).
 * 3. A stored PARTIAL fragment vs a newly-entered FULL VIN sharing the last-5
 *    is YELLOW (NEED_VERIFY_PARTIAL_FULL) — the two-way "same final five, other
 *    kind" signal is a hint to verify, never a hard block (migration
 *    20261011000300). Acknowledging it saves the bike and records history.
 * 4. A single matching signal (only last-5, same kind) is YELLOW: blocked until
 *    acknowledged, then allowed and recorded in vehicle_duplicate_checks.
 * 5. Lifecycle: SOLD still counts (re-acquire is RED); CANCELLED is ignored so
 *    a cancelled bike may be re-entered.
 * 6. Two staff saving the same PARTIAL signature in the same instant serialize
 *    on the advisory lock — the loser is rejected and exactly one row exists.
 *    (This clash is invisible to the FULL-only unique index, so it isolates
 *    the pg_advisory_xact_lock path specifically.)
 * 7. Normalization: 5-char tail keeps leading zeros as text; plate is compacted.
 * 8. No browser role may read the verification-history table directly.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runVehicleDuplicateDetectionTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  const ownerId = randomUUID()
  const staffId = randomUUID()
  let passed = 0
  const pass = (name) => {
    passed += 1
    console.log(`PASS ${passed}. ${name}`)
  }

  const call = (client, user, name, data) =>
    asUser(client, user, (c) => rpc(c, name, '$1::jsonb', [JSON.stringify(data)]))
  const save = (data) => call(db, ownerId, 'save_vehicle', data)
  const preview = (data) => call(db, ownerId, 'check_vehicle_duplicates', data)
  const frameCols = async (id) =>
    (
      await db.query(
        'SELECT frame_number, frame_compact, frame_last5, frame_input_kind, plate_compact, status FROM public.vehicles WHERE id=$1',
        [id],
      )
    ).rows[0]
  const checkRows = async (context) =>
    (
      await db.query(
        'SELECT context, level, reason, acknowledged FROM public.vehicle_duplicate_checks WHERE context=$1',
        [context],
      )
    ).rows

  try {
    console.log('\n--- Running Database Vehicle Duplicate-Detection Suite ---')
    for (const [id, name] of [
      [ownerId, 'dup-owner'],
      [staffId, 'dup-staff'],
    ]) {
      await db.query(
        'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `${name}@example.test`, JSON.stringify({ full_name: name })],
      )
    }
    await db.query(
      "UPDATE public.profiles SET role='OWNER'::public.user_role,active=true WHERE id=$1",
      [ownerId],
    )
    await db.query(
      "UPDATE public.profiles SET role='STAFF'::public.user_role,active=true WHERE id=$1",
      [staffId],
    )
    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const types = await asUser(db, ownerId, (c) => rpc(c, 'list_vehicle_types'))
    const typeId = types.find((t) => t.name === 'Xe tay ga').id

    // A distinct plate keeps the PLATE_AND_LAST5 rule from firing accidentally;
    // callers override it when the test needs the composite clash.
    const bike = (overrides = {}) => ({
      request_id: randomUUID(),
      vehicle_type_id: typeId,
      purchase_date: day,
      purchase_price: 20_000_000,
      license_plate: '',
      ...overrides,
    })

    await pass('normalization: 5-char tail keeps leading zeros as text, plate compacts')
    const normId = await save(bike({ frame_number: '  xy-00012 ', license_plate: '29A1 111.11' }))
    const norm = await frameCols(normId)
    assert.equal(norm.frame_compact, 'XY00012', 'compaction upper-cases and strips punctuation')
    assert.equal(norm.frame_last5, '00012', 'leading zeros inside the tail are preserved')
    assert.equal(norm.plate_compact, '29A111111', 'plate drops the separator to one alnum key')
    assert.equal(norm.frame_input_kind, 'PARTIAL', 'a 7-char frame is a fragment, not a VIN')

    await pass('server derives kind from the frame, ignores a client-sent frame_input_kind')
    const saveWithId = (data, id) =>
      asUser(db, ownerId, (c) => rpc(c, 'save_vehicle', '$1::jsonb, $2::uuid', [JSON.stringify(data), id]))
    // A client (old form / CSV / direct API) still tries to force FULL on a 7-char fragment.
    const spoofId = await save(
      bike({ frame_number: 'SHORT51', license_plate: '27K6-111.22', frame_input_kind: 'FULL' }),
    )
    assert.equal(
      (await frameCols(spoofId)).frame_input_kind,
      'PARTIAL',
      'a short frame can never be forced to FULL by payload — length is the only source',
    )
    // Editing an unrelated field on a legacy hand-flagged FULL row (frame untouched)
    // must preserve the stored classification so history / UNIQUE guards are not rewritten.
    await db.query("UPDATE public.vehicles SET frame_input_kind='FULL' WHERE id=$1", [spoofId])
    await saveWithId(bike({ license_plate: '27K6-111.22', color: 'Xanh' }), spoofId)
    assert.equal(
      (await frameCols(spoofId)).frame_input_kind,
      'FULL',
      'an edit that leaves the real frame unchanged keeps the historical classification',
    )

    await pass('FULL frame collision is RED (DUPLICATE_FRAME_NUMBER) without a plain UNIQUE')
    const fullVin = 'RLCE32P1234567' // 14 alnum ⇒ FULL
    await save(bike({ frame_number: fullVin, license_plate: '30B1-555.55' }))
    await assert.rejects(
      () => save(bike({ frame_number: '  rlce32 p1234567 ' })), // same VIN, other spelling
      /DUPLICATE_FRAME_NUMBER/,
      'a re-spelled identical VIN must collide on the compact FULL index',
    )

    await pass('same plate AND same last-5 is RED regardless of frame kind')
    await save(bike({ frame_number: 'KS77788888', license_plate: '51H1-999.99' })) // PARTIAL tail 88888
    await assert.rejects(
      () =>
        save(
          bike({
            frame_number: 'ZZ9999088888', // FULL, last-5 = 88888, same plate ⇒ RED2
            license_plate: '51h1 999.99',
          }),
        ),
      /DUPLICATE_VEHICLE_SUSPECTED/,
    )

    await pass('stored PARTIAL vs newly-entered FULL sharing the last-5 ⇒ YELLOW (NEED_VERIFY), not a hard block')
    await save(bike({ frame_number: 'AB012345', license_plate: '14B1-111.11' })) // PARTIAL tail 12345
    // Two-way cross-kind same tail is only a hint now: blocked until ack, then allowed.
    const crossAttempt = bike({
      frame_number: 'QQQQQQQQ12345', // FULL, same tail 12345, different plate ⇒ YELLOW1
      license_plate: '18C2-222.22',
    })
    await assert.rejects(() => save(crossAttempt), /DUPLICATE_VEHICLE_NEEDS_CONFIRM/)
    const crossPreview = await preview({
      frame_number: 'QQQQQQQQ12345',
      license_plate: '18C2-222.22',
    })
    assert.equal(crossPreview.level, 'YELLOW', 'preview agrees the cross-kind tail match is YELLOW')
    assert.equal(crossPreview.reason, 'NEED_VERIFY_PARTIAL_FULL')
    const crossAckedId = await save({ ...crossAttempt, duplicate_ack: true })
    assert.ok(crossAckedId, 'an acknowledged cross-kind YELLOW save succeeds')
    assert.ok(
      (await checkRows('SAVE')).some(
        (r) => r.level === 'YELLOW' && r.reason === 'NEED_VERIFY_PARTIAL_FULL' && r.acknowledged,
      ),
      'the acknowledged cross-kind save records a verification-history row',
    )

    await pass('only the last-5 matches (same kind) ⇒ YELLOW: blocked without ack, allowed with ack')
    await save(bike({ frame_number: 'MN100000', license_plate: '20E1-333.33' })) // PARTIAL tail 00000
    const yellowAttempt = bike({ frame_number: 'PQ200000', license_plate: '21F2-444.44' }) // same tail, PARTIAL
    await assert.rejects(() => save(yellowAttempt), /DUPLICATE_VEHICLE_NEEDS_CONFIRM/)
    const ackedId = await save({ ...yellowAttempt, duplicate_ack: true })
    assert.ok(ackedId, 'acknowledged YELLOW save succeeds')
    const yellowChecks = await checkRows('SAVE')
    assert.ok(
      yellowChecks.some((r) => r.level === 'YELLOW' && r.acknowledged),
      'an acknowledged YELLOW save records a verification-history row',
    )

    await pass('check_vehicle_duplicates preview mirrors the server verdict')
    const green = await preview({ frame_number: 'NOWHERE123', license_plate: '99Z9-888.88' })
    assert.equal(green.level, 'GREEN')
    const yellow = await preview({ frame_number: 'TT300000', license_plate: '' })
    assert.equal(yellow.level, 'YELLOW')
    assert.match(yellow.reason, /PARTIAL_MATCH/)
    const red = await preview({ frame_number: fullVin, license_plate: '' })
    assert.equal(red.level, 'RED')
    assert.equal(red.reason, 'FULL_FRAME_MATCH')
    assert.ok(red.candidates.length >= 1 && red.candidates[0].frame_input_kind === 'FULL')

    await pass('lifecycle: re-acquiring a SOLD frame is RED, a CANCELLED frame is allowed')
    const soldId = await save(bike({ frame_number: 'SOLDFRAME99', license_plate: '22G3-123.45' }))
    await call(db, ownerId, 'sell_vehicle', {
      request_id: randomUUID(),
      vehicle_id: soldId,
      customer_name: 'Khách bán',
      customer_phone: '',
      sale_price: 30_000_000,
      sale_date: day,
      initial_payment: 0,
      payment_method: 'CASH',
    })
    await assert.rejects(
      () => save(bike({ frame_number: 'SOLDFRAME99' })),
      /DUPLICATE_FRAME_NUMBER/,
      'a SOLD bike is still "managed" so its VIN cannot be re-created',
    )
    const cancelledId = await save(bike({ frame_number: 'CANCENFRAME77', license_plate: '23H4-543.21' }))
    await db.query("UPDATE public.vehicles SET status='CANCELLED'::public.vehicle_status WHERE id=$1", [cancelledId])
    const revivedId = await save(bike({ frame_number: 'CANCENFRAME77', license_plate: '23H4-543.21' }))
    assert.ok(revivedId && String(revivedId) !== String(cancelledId), 'a CANCELLED bike may be re-entered')

    await pass('no browser role may read the verification-history table directly')
    for (const user of [ownerId, staffId]) {
      await assert.rejects(
        () => asUser(db, user, (c) => c.query('SELECT * FROM public.vehicle_duplicate_checks')),
        /permission denied|row-level security/i,
      )
    }

    // PGlite is single-session: advisory-lock serialization cannot be exercised.
    if (db.connection) {
      await pass('two staff saving the same PARTIAL signature serialize to exactly one bike')
      const dup = {
        vehicle_type: 'Xe tay ga',
        acquisition_date: day,
        purchase_price: 100,
        frame_number: 'RR700077', // PARTIAL tail 00077
        license_plate: '24I5-678.90', // same plate + same tail ⇒ RED2 for the loser
      }
      const a = await db.connection()
      const b = await db.connection()
      try {
        const before = Number(
          (await db.query('SELECT count(*) AS n FROM public.vehicles WHERE frame_last5=$1', ['00077'])).rows[0].n,
        )
        const results = await Promise.all([
          call(a, ownerId, 'acquire_vehicle', { ...dup, request_id: randomUUID() }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
          call(b, ownerId, 'acquire_vehicle', { ...dup, request_id: randomUUID() }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
        ])
        const failures = results.filter((r) => r.error)
        assert.equal(failures.length, 1, 'exactly one concurrent save must be rejected')
        assert.match(failures[0].error.message, /DUPLICATE_VEHICLE_SUSPECTED/, 'loser hits the composite RED')
        const after = Number(
          (await db.query('SELECT count(*) AS n FROM public.vehicles WHERE frame_last5=$1', ['00077'])).rows[0].n,
        )
        assert.equal(after - before, 1, 'the advisory lock kept the PARTIAL row count at one')
      } finally {
        await a.close()
        await b.close()
      }
    } else {
      console.log('SKIP concurrency advisory-lock check: PGlite is single-session.')
    }

    console.log(`--- Vehicle Duplicate-Detection suite: ${passed} checks passed ---\n`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

// Allow direct CLI invocation: node tests/db/vehicle-duplicate-detection.test.mjs
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/vehicle-duplicate-detection.test.mjs')) {
  await runVehicleDuplicateDetectionTests(null, {
    engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres',
  })
}
