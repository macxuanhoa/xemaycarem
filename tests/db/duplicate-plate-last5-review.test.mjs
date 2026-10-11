/*
 * Database Suite: role-gated "suspected duplicate" review (PLATE_AND_LAST5)
 * Covers migration 20261011000400. Proves the owner-chosen rule (11/10/2026):
 * 1. Two FULL frames matching EXACTLY (FULL_FRAME_MATCH) stay a HARD RED block
 *    for every role — not bypassable by override flags, reason, or reviewed id.
 * 2. PLATE_AND_LAST5 (same plate + same last-5, NOT exact-FULL) is only SUSPECTED:
 *    - STAFF cannot save it, even with a duplicate_override flag (role-gated), and
 *      no vehicle is created.
 *    - OWNER/MANAGER may save it as an audited EXCEPTION only with the full trio:
 *      override flag + reason (>=5) + reviewed_vehicle_id that is a real candidate.
 * 3. STAFF sends a verification REQUEST (no vehicle persisted, approval opened);
 *    a second open request for the same candidate is rejected ALREADY_PENDING.
 * 4. OWNER APPROVE performs the final insert themselves from the snapshot; REJECT
 *    creates nothing. Both are recorded in vehicle_duplicate_checks + audit.
 * 5. A stale request whose signal disappeared is refused APPROVAL_STALE_DATA.
 * 6. The review queue RPC is OWNER/MANAGER-only and never reads the raw table.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runDuplicatePlateLast5ReviewTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  const ownerId = randomUUID()
  const managerId = randomUUID()
  const staffId = randomUUID()
  let passed = 0
  const pass = (name) => {
    passed += 1
    console.log(`PASS ${passed}. ${name}`)
  }

  const call = (user, name, data) =>
    asUser(db, user, (c) => rpc(c, name, '$1::jsonb', [JSON.stringify(data)]))
  const save = (user, data, id) =>
    asUser(db, user, (c) =>
      id
        ? rpc(c, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify(data), id])
        : rpc(c, 'save_vehicle', '$1::jsonb', [JSON.stringify(data)]),
    )
  const requestReview = (user, data) => call(user, 'request_vehicle_duplicate_review', data)
  const resolveReview = (user, approvalId, action, reason) =>
    asUser(db, user, (c) =>
      rpc(c, 'resolve_vehicle_duplicate_review', '$1::uuid,$2::text,$3::text,$4::uuid', [
        approvalId,
        action,
        reason ?? null,
        randomUUID(),
      ]),
    )
  const listReviews = (user, filters = {}) => call(user, 'list_vehicle_duplicate_reviews', filters)
  const vehicleCount = async (last5, plate) =>
    Number(
      (
        await db.query(
          'SELECT count(*) AS n FROM public.vehicles WHERE frame_last5=$1 AND plate_compact=$2',
          [last5, plate],
        )
      ).rows[0].n,
    )
  const checks = async (context) =>
    (
      await db.query(
        'SELECT decision, reviewed_vehicle_id, override_reason, approval_id FROM public.vehicle_duplicate_checks WHERE context=$1',
        [context],
      )
    ).rows

  try {
    console.log('\n--- Running Database Duplicate PLATE_AND_LAST5 Review Suite ---')
    for (const [id, name] of [
      [ownerId, 'rev-owner'],
      [managerId, 'rev-manager'],
      [staffId, 'rev-staff'],
    ]) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [
        id,
        `${name}@example.test`,
        JSON.stringify({ full_name: name }),
      ])
    }
    await db.query("UPDATE public.profiles SET role='OWNER'::public.user_role,active=true WHERE id=$1", [ownerId])
    await db.query("UPDATE public.profiles SET role='MANAGER'::public.user_role,active=true WHERE id=$1", [managerId])
    await db.query("UPDATE public.profiles SET role='STAFF'::public.user_role,active=true WHERE id=$1", [staffId])

    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const types = await asUser(db, ownerId, (c) => rpc(c, 'list_vehicle_types'))
    const typeId = types.find((t) => t.name === 'Xe tay ga').id

    const bike = (overrides = {}) => ({
      request_id: randomUUID(),
      vehicle_type_id: typeId,
      purchase_date: day,
      purchase_price: 20_000_000,
      license_plate: '',
      ...overrides,
    })

    // A base PARTIAL bike with a distinctive tail + plate. A second bike that
    // shares the SAME plate AND the same final-five is a PLATE_AND_LAST5 SUSPECT.
    const plate = '63B1-700.70'
    const tail = '70070'
    const baseFull = 'KTBB70070ZZZ' // 12 alnum, tail 0070Z -> avoid accidental collision with base PARTIAL
    await save(ownerId, bike({ frame_number: 'AAAAA70070', license_plate: plate })) // PARTIAL tail 70070

    await pass('exact-FULL frame match stays a HARD RED block for every role (no override exists)')
    await save(ownerId, bike({ frame_number: baseFull, license_plate: '63B1-700.90' })) // seed a FULL bike
    for (const user of [ownerId, managerId, staffId]) {
      await assert.rejects(
        () =>
          save(user, {
            ...bike({ frame_number: 'ktbb 70070zzz', license_plate: '99XX-000.00' }), // re-spelled identical VIN
            duplicate_override: true,
            duplicate_override_reason: 'cố tình ghi đè để thử',
            duplicate_reviewed_vehicle_id: ownerId,
            duplicate_ack: true,
          }),
        /DUPLICATE_FRAME_NUMBER/,
        'exact-FULL collision cannot be talked past by any role or override flag',
      )
    }

    await pass('PLATE_AND_LAST5 is only SUSPECTED: STAFF save is blocked even with an override flag')
    const suspect = bike({ frame_number: 'ZZ9999070070', license_plate: '63b1 700.70' }) // FULL, same tail + plate
    await assert.rejects(() => save(staffId, suspect), /DUPLICATE_VEHICLE_SUSPECTED/)
    await assert.rejects(
      () => save(staffId, { ...suspect, duplicate_override: true, duplicate_override_reason: 'nhân viên tự vượt' }),
      /DUPLICATE_VEHICLE_SUSPECTED/,
      'role gate ignores an override the STAFF is not entitled to',
    )
    assert.equal(await vehicleCount(tail, '63B170070'), 1, 'no STAFF write persisted a suspected duplicate')

    await pass('STAFF sends a verification REQUEST without persisting any vehicle')
    const requestId = randomUUID()
    const approvalA = await requestReview(staffId, {
      request_id: requestId,
      _op: 'ACQUIRE',
      ...bike({ frame_number: 'ZZ9999070070', license_plate: plate }),
      staff_note: 'Xe khách mang tới, em nghi trùng với xe đang bán',
    })
    assert.ok(approvalA, 'a PENDING review request is opened')
    const reqChecks = await checks('ACQUIRE')
    assert.ok(
      reqChecks.some((r) => r.decision === 'REQUEST' && r.reviewed_vehicle_id === null && r.approval_id === approvalA),
      'the request records a REQUEST row (no exception, no reviewed id)',
    )
    assert.equal(await vehicleCount(tail, '63B170070'), 1, 'a REQUEST never creates a vehicle')

    await pass('a second open request for the same candidate is refused ALREADY_PENDING')
    await assert.rejects(
      () =>
        requestReview(staffId, {
          request_id: randomUUID(),
          _op: 'ACQUIRE',
          ...bike({ frame_number: 'QQ1239070070', license_plate: plate }),
        }),
      /ALREADY_PENDING/,
      'approval_open_unique keeps exactly one pending request per suspect candidate',
    )

    await pass('OWNER APPROVE performs the final insert themselves and marks the exception OVERRIDE')
    const beforeApprove = await vehicleCount(tail, '63B170070')
    const approved = await resolveReview(ownerId, approvalA, 'APPROVE', 'Đã mở hồ sơ xe 63B1-700.70, đúng là hai xe khác nhau')
    assert.ok(approved.vehicle_id, 'approve returns the newly created vehicle id')
    assert.equal(await vehicleCount(tail, '63B170070'), beforeApprove + 1, 'exactly one vehicle added on approval')
    const appChecks = await checks('ACQUIRE')
    assert.ok(
      appChecks.some(
        (r) =>
          r.decision === 'OVERRIDE' &&
          r.reviewed_vehicle_id !== null &&
          r.override_reason &&
          r.approval_id === approvalA,
      ),
      'the approved exception is audited with reviewed id + reason + link to the request',
    )
    // Một yêu cầu không bao giờ tạo hai xe: duyệt lại bị từ chối và số xe giữ nguyên.
    await assert.rejects(
      () => resolveReview(ownerId, approvalA, 'APPROVE', 'cố duyệt lần hai'),
      /ALREADY_RESOLVED/,
      'a second APPROVE on the same request is refused',
    )
    assert.equal(
      await vehicleCount(tail, '63B170070'),
      beforeApprove + 1,
      'the refused second approval did NOT add another vehicle',
    )

    await pass('OWNER REJECT creates nothing and closes the request')
    const rejPlate = '63E4-500.50'
    const rejTail = '50050'
    await save(ownerId, bike({ frame_number: 'MMMMM50050', license_plate: rejPlate })) // base PARTIAL tail 50050
    const rejBefore = await vehicleCount(rejTail, '63E450050')
    const approvalR = await requestReview(staffId, {
      request_id: randomUUID(),
      _op: 'ACQUIRE',
      ...bike({ frame_number: 'NN11150050', license_plate: '63e4 500.50', purchase_price: 18_000_000 }),
    })
    const rejected = await resolveReview(ownerId, approvalR, 'REJECT', 'Trùng thật, yêu cầu nhập lại đủ số khung')
    assert.equal(rejected.vehicle_id, null, 'reject does not create a vehicle')
    assert.equal(await vehicleCount(rejTail, '63E450050'), rejBefore, 'a rejected request leaves inventory untouched')
    const rRow = (
      await db.query('SELECT status FROM public.approval_requests WHERE id=$1', [approvalR])
    ).rows[0]
    assert.equal(rRow.status, 'REJECTED', 'the request is closed as REJECTED')
    await assert.rejects(
      () => resolveReview(ownerId, approvalR, 'APPROVE', 'duyệt lại đơn đã đóng'),
      /ALREADY_RESOLVED/,
      'a resolved request cannot be re-decided',
    )

    await pass('OWNER inline save of a SUSPECT needs the full trio (reason + real reviewed candidate)')
    const inlinePlate = '63C2-800.80'
    const inlineTail = '80080'
    const inlineBase = await save(ownerId, bike({ frame_number: 'BBBBB80080', license_plate: inlinePlate }))
    const inlineAttempt = bike({ frame_number: 'CC1110080080', license_plate: '63c2 800.80' })
    // Missing reason → still suspected.
    await assert.rejects(
      () => save(ownerId, { ...inlineAttempt, duplicate_override: true, duplicate_reviewed_vehicle_id: inlineBase }),
      /DUPLICATE_VEHICLE_SUSPECTED|DUPLICATE_OVERRIDE/,
    )
    // Missing reviewed candidate → still suspected.
    await assert.rejects(
      () => save(ownerId, { ...inlineAttempt, duplicate_override: true, duplicate_override_reason: 'hai xe khác nhau' }),
      /DUPLICATE_VEHICLE_SUSPECTED/,
    )
    // Full trio present → MANAGER may also save the exception.
    const inlineId = await save(managerId, {
      ...inlineAttempt,
      duplicate_override: true,
      duplicate_override_reason: 'Đã đối chiếu hồ sơ xe kia, chắc chắn là hai xe khác nhau',
      duplicate_reviewed_vehicle_id: inlineBase,
    })
    assert.ok(inlineId, 'privileged inline override save succeeds')
    assert.ok(
      (await checks('SAVE')).some((r) => r.decision === 'OVERRIDE' && String(r.reviewed_vehicle_id) === String(inlineBase)),
      'inline exception audited as SAVE/OVERRIDE with the reviewed candidate',
    )
    assert.equal(await vehicleCount(inlineTail, '63C280080'), 2, 'suspect pair now has both bikes stored')

    await pass('a stale request whose signal disappeared is refused APPROVAL_STALE_DATA')
    // Open a request, then remove the conflict so approval re-detects GREEN/no-RED.
    const stalePlate = '63D3-900.90'
    const staleBase = await save(ownerId, bike({ frame_number: 'DDDDD90090', license_plate: stalePlate }))
    const staleApproval = await requestReview(staffId, {
      request_id: randomUUID(),
      _op: 'ACQUIRE',
      ...bike({ frame_number: 'EE1110090090', license_plate: stalePlate }),
    })
    // Cancelling the only conflicting bike makes detect go GREEN (CANCELLED is ignored),
    // so a queued approval that no longer represents a real suspect must be refused.
    await db.query("UPDATE public.vehicles SET status='CANCELLED'::public.vehicle_status WHERE id=$1", [staleBase])
    await assert.rejects(
      () => resolveReview(ownerId, staleApproval, 'APPROVE', 'duyệt khi tín hiệu đã mất'),
      /APPROVAL_STALE_DATA/,
    )

    await pass('review queue is OWNER/MANAGER-only and never reads the raw history table')
    const queue = await listReviews(ownerId, { status: 'PENDING' })
    assert.ok(Array.isArray(queue.items), 'owner can list the review queue')
    await listReviews(managerId, { status: 'PENDING' })
    await assert.rejects(
      () => listReviews(staffId, { status: 'PENDING' }),
      /ACCESS_DENIED|permission denied|not authorized|row-level security/i,
      'STAFF cannot read the collective review queue',
    )
    for (const user of [ownerId, staffId]) {
      await assert.rejects(
        () => asUser(db, user, (c) => c.query('SELECT * FROM public.vehicle_duplicate_checks')),
        /permission denied|row-level security/i,
      )
    }

    await pass('review queue never leaks the candidate vehicle private purchase cost')
    // Chủ tạo xe nền với giá vốn riêng tư đặc trưng; nhân viên gửi nghi trùng dựa
    // trên xe đó. Hàng đợi của Chủ LẪN Quản lý (không có quyền tài chính) tuyệt
    // đối không được chứa con số giá vốn của xe đối chiếu trong payload/cột nào.
    const leakPlate = '63G7-300.30'
    const leakCost = 41_414_141
    await save(ownerId, bike({ frame_number: 'GGGGG30030', license_plate: leakPlate, purchase_price: leakCost }))
    await requestReview(staffId, {
      request_id: randomUUID(),
      _op: 'ACQUIRE',
      ...bike({ frame_number: 'HH2220030030', license_plate: '63g7 300.30', purchase_price: 15_000_000 }),
    })
    for (const user of [ownerId, managerId]) {
      const q = await listReviews(user, { status: 'PENDING' })
      const leakRow = JSON.stringify(q)
      assert.ok(
        !leakRow.includes(String(leakCost)),
        'queue output must not carry the candidate vehicle purchase cost',
      )
      const suspectRow = q.items.find((it) => it.license_plate === leakPlate || it.license_plate === '63G7-300.30')
      assert.ok(!suspectRow || suspectRow.payload?.snapshot_purchase_price == null, 'no sale-style cost snapshot leaks')
    }

    console.log(`--- Duplicate PLATE_AND_LAST5 Review suite: ${passed} checks passed ---\n`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

// Allow direct CLI invocation: node tests/db/duplicate-plate-last5-review.test.mjs
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/duplicate-plate-last5-review.test.mjs')) {
  await runDuplicatePlateLast5ReviewTests(null, {
    engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres',
  })
}
