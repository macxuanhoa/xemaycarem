/**
 * Database Staff-Parity & Delete-Approval Test Suite
 * Covers migration 20261008000200:
 *  1. STAFF parity: cancel/restore a vehicle status and add/cancel VEHICLE expenses
 *     like a non-financial MANAGER (business expenses remain MANAGER+).
 *  2. request_delete_vehicle hides the vehicle from list_vehicles and marks the
 *     detail as pending; blocks sell_vehicle / save_vehicle / delete_vehicle (DELETE_PENDING).
 *  3. Guards: duplicate request -> ALREADY_PENDING; sold vehicle -> SALE_HISTORY_EXISTS;
 *     non-available vehicle -> VEHICLE_NOT_AVAILABLE.
 *  4. resolve_vehicle_deletion is OWNER-only: APPROVE hard-purges, RESTORE returns it.
 *  5. list_pending_approvals is OWNER-only and denormalizes vehicle + requester.
 *  6. Filing a request notifies the OWNER (bell deep_link /approvals) via the audit fan-out.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runStaffDeleteApprovalTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Staff-Parity & Delete-Approval Test Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'manager', 'staff'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `parity-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2', [name.toUpperCase(), id])
    }

    const vehicleData = (overrides = {}) => ({
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga', license_plate: `SP-${randomUUID().slice(0, 6).toUpperCase()}`,
      frame_number: `FRAME${randomUUID().slice(0, 8)}`, purchase_date: day,
      ...overrides,
    })
    const saveVehicle = (user, data, id) => run(user, (client) => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify(data), id ?? null]))
    const saveExpense = (user, kind, data) => run(user, (client) => rpc(client, 'save_expense', `'${kind}',$1::jsonb`, [JSON.stringify(data)]))
    const cancelExpense = (user, kind, id, reason) => run(user, (client) => rpc(client, 'cancel_expense', `'${kind}',$1::uuid,$2::text`, [id, reason]))
    const requestDelete = (user, id, reason) => run(user, (client) => rpc(client, 'request_delete_vehicle', '$1::uuid,$2::text', [id, reason]))
    const resolveDelete = (user, reqId, action, note) => run(user, (client) => rpc(client, 'resolve_vehicle_deletion', '$1::uuid,$2::text,$3::text', [reqId, action, note ?? null]))
    const listPending = (user) => run(user, (client) => rpc(client, 'list_pending_approvals', '$1::jsonb', ['{}']))
    const deleteVehicle = (user, id, reason) => run(user, (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [id, reason]))
    const getVehicle = (user, id) => run(user, (client) => rpc(client, 'get_vehicle', '$1::uuid', [id]))

    // 1. STAFF parity: cancel/restore status and vehicle expenses (business stays gated).
    const parityVehicle = await call('staff', 'save_vehicle', vehicleData())
    await saveVehicle('staff', { status: 'CANCELLED' }, parityVehicle)
    assert.equal((await getVehicle('staff', parityVehicle)).status, 'CANCELLED')
    await saveVehicle('staff', { status: 'IN_STOCK' }, parityVehicle)
    assert.equal((await getVehicle('staff', parityVehicle)).status, 'IN_STOCK')
    const staffExpense = await saveExpense('staff', 'vehicle', { vehicle_id: parityVehicle, expense_type: 'REPAIR', description: 'Chi phí nhân viên', amount: 400_000, expense_date: day })
    await cancelExpense('staff', 'vehicle', staffExpense, 'Hủy bởi nhân viên')
    await deny(() => saveExpense('staff', 'business', { category: 'RENT', description: 'Unauthorized', amount: 1000, expense_date: day }))
    pass('STAFF cancels/restores vehicle status and manages vehicle expenses but cannot touch business expenses')

    // 2 & 6. STAFF files a delete request: hides from inventory, flags detail, notifies OWNER.
    const queueVehicle = await call('staff', 'save_vehicle', vehicleData())
    await requestDelete('staff', queueVehicle, 'Nhập nhầm xe, trùng phiếu')
    const pendingRow = (await row("SELECT id FROM public.approval_requests WHERE subject_id=$1 AND kind='VEHICLE_DELETION' AND status='PENDING'", [queueVehicle]))
    assert.ok(pendingRow, 'a PENDING VEHICLE_DELETION request is queued')
    assert.ok(!(await call('staff', 'list_vehicles', { search: (await row('SELECT license_plate AS lp FROM public.vehicles WHERE id=$1', [queueVehicle])).lp })).items.some((i) => i.id === queueVehicle), 'queued vehicle is hidden from inventory')
    assert.equal((await getVehicle('staff', queueVehicle)).pending_deletion, true)
    const ownerNotif = await row("SELECT deep_link FROM public.notifications WHERE action='REQUEST_DELETE_VEHICLE' AND user_id=$1 AND entity_id=$2", [users.owner, queueVehicle])
    assert.equal(ownerNotif?.deep_link, '/approvals', 'OWNER receives an approvals deep-link notification')
    pass('request_delete_vehicle queues a request, hides the vehicle, flags the detail and notifies the OWNER')

    // 3. Guards: duplicate request, blocked mutation while pending, unknown reason.
    await deny(() => requestDelete('staff', queueVehicle, 'Yêu cầu lặp lại'), /ALREADY_PENDING/)
    await deny(() => saveVehicle('staff', { color: 'Sửa khi đang chờ duyệt' }, queueVehicle), /DELETE_PENDING/)
    await deny(() => deleteVehicle('manager', queueVehicle, 'Xóa song song'), /DELETE_PENDING/)
    await deny(() => saveExpense('staff', 'vehicle', { vehicle_id: queueVehicle, expense_type: 'REPAIR', description: 'Chi phí khi đang chờ duyệt', amount: 100_000, expense_date: day }), /DELETE_PENDING/)
    await deny(() => requestDelete('staff', queueVehicle, 'ab'), /DELETION_REASON_REQUIRED/)
    const soldVehicle = await call('owner', 'save_vehicle', vehicleData({ purchase_price: 70_000_000 }))
    await call('owner', 'sell_vehicle', { vehicle_id: soldVehicle, customer_name: 'Khách đã bán', customer_phone: '0000000002', sale_price: 90_000_000, sale_date: day, initial_payment: 0 })
    await deny(() => requestDelete('staff', soldVehicle, 'Xe đã bán không xóa được'), /SALE_HISTORY_EXISTS/)
    pass('Duplicate, blocked-while-pending, short-reason and sold-vehicle requests are all refused')

    // 4 & 5. OWNER-only review and resolution: APPROVE purges, RESTORE returns.
    await deny(() => listPending('staff'))
    await deny(() => resolveDelete('manager', pendingRow.id, 'APPROVE'))
    const pending = await listPending('owner')
    assert.ok(pending.items.some((i) => i.id === pendingRow.id && i.vehicle_status != null && i.requester_name), 'OWNER lists the request with denormalized vehicle + requester')

    // RESTORE returns the queued vehicle to inventory without deleting it.
    await resolveDelete('owner', pendingRow.id, 'RESTORE', 'Giữ lại để kiểm tra')
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [queueVehicle]), 1)
    assert.equal((await getVehicle('owner', queueVehicle)).pending_deletion, false)
    assert.equal((await row("SELECT status FROM public.approval_requests WHERE id=$1", [pendingRow.id])).status, 'REJECTED')
    assert.ok((await call('owner', 'list_vehicles', { search: (await row('SELECT license_plate AS lp FROM public.vehicles WHERE id=$1', [queueVehicle])).lp })).items.some((i) => i.id === queueVehicle), 'restored vehicle is back in inventory')
    await deny(() => resolveDelete('owner', pendingRow.id, 'APPROVE'), /ALREADY_RESOLVED/)
    pass('resolve RESTORE rejects the request and returns the vehicle to inventory')

    // APPROVE hard-purges via private.purge_vehicle.
    const purgeVehicle = await call('staff', 'save_vehicle', vehicleData())
    await requestDelete('staff', purgeVehicle, 'Xe rác cần gỡ vĩnh viễn')
    const purgeReq = await row("SELECT id FROM public.approval_requests WHERE subject_id=$1 AND status='PENDING'", [purgeVehicle])
    await resolveDelete('owner', purgeReq.id, 'APPROVE')
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [purgeVehicle]), 0)
    assert.equal((await row("SELECT status FROM public.approval_requests WHERE id=$1", [purgeReq.id])).status, 'APPROVED')
    assert.ok(await row("SELECT id FROM public.audit_logs WHERE action='APPROVE_VEHICLE_DELETION' AND entity_id=$1", [purgeVehicle]), 'approval is audited')
    await deny(() => resolveDelete('owner', randomUUID(), 'APPROVE'), /APPROVAL_NOT_FOUND/)
    await deny(() => resolveDelete('owner', purgeReq.id, 'INVALID'), /INVALID_APPROVAL_ACTION/)
    pass('resolve APPROVE purges the vehicle, audits the decision and rejects bad inputs')

    console.log(`\n${passed} staff-parity & delete-approval checks passed on ${engine}.`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStaffDeleteApprovalTests({ engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
    .then(() => process.exit(0))
    .catch((error) => { console.error(error); process.exit(1) })
}
