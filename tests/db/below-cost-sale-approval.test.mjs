/**
 * Database Below-Cost Sale Approval Test Suite
 * Covers migration 20261010000300:
 *  1. sale_price >= purchase_price completes immediately for every role (no approval).
 *  2. sale_price < purchase_price is an OWNER decision: STAFF/MANAGER get
 *     SALE_BELOW_COST_APPROVAL_REQUIRED from sell_vehicle (server-side, not UI),
 *     OWNER sells directly without filing anything.
 *  3. request_sale_below_cost files ONE row in the existing public.approval_requests
 *     queue, creates no sale, leaves the vehicle IN_STOCK with zero revenue, and
 *     follows the receipt protocol (CLIENT_UPGRADE_REQUIRED / OPERATION_REQUEST_CONFLICT).
 *  4. A pending request blocks every other transaction on that vehicle (other staff,
 *     OWNER direct sale, delete request, direct delete).
 *  5. list_pending_approvals denormalizes the full decision set (plate, frame, cost,
 *     proposed price, shortfall, requester, time) and stays OWNER-only.
 *  6. resolve_sale_approval APPROVE completes exactly the proposal in one transaction
 *     (sold_by = requester, snapshots, payment, revenue), is idempotent per request_id
 *     and refuses stale data (APPROVAL_STALE_DATA) once cost or expenses moved.
 *  7. REJECT leaves the vehicle unsold and notifies the requester; the requester (or
 *     OWNER) can cancel a pending request so a corrected one can be re-filed.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runBelowCostSaleApprovalTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Below-Cost Sale Approval Test Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'manager', 'staff', 'staff2'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const rows = async (sql, args = []) => (await db.query(sql, args)).rows
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const pos = (user, name, sig, args) => run(user, (client) => rpc(client, name, sig, args))
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `belowcost-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2',
        [name === 'staff2' ? 'STAFF' : name.toUpperCase(), id])
    }

    const COST = 50_000_000
    const BELOW = 40_000_000
    const vehicleData = (overrides = {}) => ({
      request_id: randomUUID(), vehicle_type: 'Xe tay ga',
      license_plate: `BC-${randomUUID().slice(0, 6).toUpperCase()}`,
      frame_number: `BCFRAME${randomUUID().slice(0, 8)}`,
      purchase_date: day, purchase_price: COST, ...overrides,
    })
    const newVehicle = (user, overrides) => call(user, 'save_vehicle', vehicleData(overrides))
    const saleData = (id, overrides = {}) => ({
      request_id: randomUUID(), vehicle_id: id, customer_name: 'Khách Below-Cost',
      customer_phone: '0900000000', sale_price: COST + 5_000_000, initial_payment: 0,
      payment_method: 'CASH', sale_date: day, ...overrides,
    })
    const proposal = (id, overrides = {}) => ({ ...saleData(id), sale_price: BELOW, initial_payment: 5_000_000, ...overrides })
    const requestApproval = (user, data) => call(user, 'request_sale_below_cost', data)
    const resolveApproval = (user, approvalId, action, note, requestId) =>
      pos(user, 'resolve_sale_approval', '$1::uuid,$2::text,$3::text,$4::uuid', [approvalId, action, note ?? null, requestId ?? randomUUID()])
    const cancelApproval = (user, approvalId, reason) => pos(user, 'cancel_sale_approval', '$1::uuid,$2::text', [approvalId, reason ?? null])
    const getVehicle = (user, id) => pos(user, 'get_vehicle', '$1::uuid', [id])
    const getSale = (user, id) => pos(user, 'get_sale', '$1::uuid', [id])
    const dashboard = (user) => run(user, (client) => rpc(client, 'dashboard'))
    const statusOf = async (id) => (await getVehicle('owner', id)).status
    const plateOf = async (id) => (await getVehicle('owner', id)).license_plate
    const saleRows = (id) => count('SELECT count(*) AS count FROM public.sales WHERE vehicle_id=$1', [id])
    const approvalRow = (id) => row('SELECT * FROM public.approval_requests WHERE id=$1', [id])

    // 1. Enough revenue needs no boss: equal and above cost complete for STAFF/MANAGER.
    const okVehicle = await newVehicle('staff')
    const okSale = await call('staff', 'sell_vehicle', saleData(okVehicle, { sale_price: COST }))
    assert.equal(await statusOf(okVehicle), 'SOLD')
    assert.equal((await getSale('owner', okSale)).gross_profit, 0)
    const aboveVehicle = await newVehicle('manager')
    await call('manager', 'sell_vehicle', saleData(aboveVehicle, { sale_price: COST + 1_000_000 }))
    assert.equal(await statusOf(aboveVehicle), 'SOLD')
    assert.equal(await count("SELECT count(*) AS count FROM public.approval_requests WHERE kind='SALE_BELOW_COST'"), 0)
    pass('Bán bằng hoặc cao hơn giá thu hoàn tất ngay, không tạo yêu cầu duyệt cho STAFF/MANAGER')

    // 2. Below cost is refused by the server, not by the UI.
    const gatedVehicle = await newVehicle('staff')
    const gatedPlate = await plateOf(gatedVehicle)
    await deny(() => call('staff', 'sell_vehicle', saleData(gatedVehicle, { sale_price: BELOW })), /SALE_BELOW_COST_APPROVAL_REQUIRED/)
    await deny(() => call('manager', 'sell_vehicle', saleData(gatedVehicle, { sale_price: COST - 1 })), /SALE_BELOW_COST_APPROVAL_REQUIRED/)
    assert.equal(await saleRows(gatedVehicle), 0)
    assert.equal(await statusOf(gatedVehicle), 'IN_STOCK')
    pass('Bán dưới giá thu bị server chặn với STAFF/MANAGER, xe còn nguyên trong kho')

    // 3. Filing a request: receipt protocol + exactly one queue row + no money moved.
    const reqKey = randomUUID()
    const filed = proposal(gatedVehicle, { request_id: reqKey })
    await deny(() => requestApproval('staff', { ...filed, request_id: undefined }), /CLIENT_UPGRADE_REQUIRED/)
    const beforeRevenue = (await dashboard('owner')).month_revenue
    const approvalId = await requestApproval('staff', filed)
    const queued = await approvalRow(approvalId)
    assert.equal(queued.kind, 'SALE_BELOW_COST')
    assert.equal(queued.status, 'PENDING')
    assert.equal(queued.requested_by, users.staff)
    assert.equal(Number(queued.payload.sale_price), BELOW)
    assert.equal(Number(queued.payload.snapshot_purchase_price), COST)
    assert.equal(Number(queued.payload.shortfall), COST - BELOW)
    assert.equal(queued.payload.vehicle_id, gatedVehicle)
    assert.equal(await saleRows(gatedVehicle), 0)
    assert.equal(await statusOf(gatedVehicle), 'IN_STOCK')
    assert.equal((await dashboard('owner')).month_revenue, beforeRevenue)
    assert.match(queued.reason, /Bán dưới giá thu/)
    assert.match(queued.reason, new RegExp(gatedPlate))
    const requestedNotices = await rows('SELECT * FROM public.notifications WHERE action=$1', ['REQUEST_SALE_BELOW_COST'])
    assert.ok(requestedNotices.some((n) => n.user_id === users.owner && n.deep_link === '/approvals'))
    assert.ok(requestedNotices.some((n) => n.user_id === users.staff))
    pass('Gửi yêu cầu duyệt ghi đúng 1 đơn chờ, không bán, không doanh thu, báo chủ cửa hàng')

    // 4. Same request_id is replayable; changed payload under that key is a conflict.
    assert.equal(await requestApproval('staff', filed), approvalId)
    await assert.rejects(
      () => requestApproval('staff', { ...filed, customer_name: 'Khách khác' }),
      /OPERATION_REQUEST_CONFLICT/,
    )
    assert.equal(await count("SELECT count(*) AS count FROM public.approval_requests WHERE kind='SALE_BELOW_COST'"), 1)
    pass('Gửi lại cùng request_id trả đúng đơn cũ; đổi nội dung dưới khóa đó là OPERATION_REQUEST_CONFLICT')

    // 5. A pending request blocks every other transaction on the same vehicle.
    await assert.rejects(() => requestApproval('staff2', proposal(gatedVehicle)), /ALREADY_PENDING/)
    await deny(() => call('staff2', 'sell_vehicle', saleData(gatedVehicle, { sale_price: COST + 1 })), /SALE_APPROVAL_PENDING/)
    await deny(() => call('owner', 'sell_vehicle', saleData(gatedVehicle, { sale_price: COST - 5_000_000 })), /SALE_APPROVAL_PENDING/)
    await deny(() => pos('staff', 'request_delete_vehicle', '$1::uuid,$2::text', [gatedVehicle, 'Xóa trùng hồ sơ']), /SALE_APPROVAL_PENDING/)
    await deny(() => pos('owner', 'delete_vehicle', '$1::uuid,$2::text', [gatedVehicle, 'Xóa thủ công']), /SALE_APPROVAL_PENDING/)
    assert.equal(await count("SELECT count(*) AS count FROM public.approval_requests WHERE kind='VEHICLE_DELETION'"), 0)
    assert.equal(await statusOf(gatedVehicle), 'IN_STOCK')
    pass('Xe đang chờ duyệt không bị bán trùng, không bị xóa bởi bất kỳ giao dịch nào khác')

    // 6. The OWNER approvals page carries the whole decision set and nothing leaks to staff.
    const listed = await pos('owner', 'list_pending_approvals', '$1::jsonb', ['{}'])
    const item = listed.items.find((entry) => entry.id === approvalId)
    assert.ok(item, 'pending request must be listed for the OWNER')
    assert.equal(listed.total, 1)
    assert.equal(item.kind, 'SALE_BELOW_COST')
    assert.equal(item.license_plate, gatedPlate)
    assert.ok(item.frame_number?.startsWith('BCFRAME'))
    assert.equal(item.requester_name, 'staff')
    assert.equal(item.payload.snapshot_purchase_price, COST)
    assert.equal(item.payload.sale_price, BELOW)
    assert.equal(item.payload.shortfall, COST - BELOW)
    assert.equal(item.payload.customer_name, 'Khách Below-Cost')
    assert.ok(item.created_at)
    assert.ok(item.vehicle_title.includes(gatedPlate))
    assert.equal((await pos('owner', 'list_pending_approvals', '$1::jsonb', ['{"status":"APPROVED","kind":"SALE_BELOW_COST"}'])).total, 0)
    for (const user of ['staff', 'manager']) await deny(() => pos(user, 'list_pending_approvals', '$1::jsonb', ['{}']))
    pass('Hàng đợi Chờ duyệt hiển thị xe · biển số · khung · giá thu · giá bán · chênh lệch · người gửi · thời gian, chỉ OWNER đọc được')

    // 7. Approving completes exactly the proposal, in one transaction.
    const decideKey = randomUUID()
    const approved = await resolveApproval('owner', approvalId, 'APPROVE', 'Chủ đồng ý bán lỗ', decideKey)
    assert.equal(approved.approval_id, approvalId)
    const saleId = approved.sale_id
    const sale = await getSale('owner', saleId)
    assert.equal(sale.sale_price, BELOW)
    assert.equal(sale.sold_by, users.staff)
    assert.equal(sale.purchase_cost_snapshot, COST)
    assert.equal(sale.total_cost_snapshot, COST)
    assert.equal(sale.gross_profit, BELOW - COST)
    assert.equal(sale.paid_amount, 5_000_000)
    assert.equal(sale.remaining_amount, BELOW - 5_000_000)
    assert.equal(await statusOf(gatedVehicle), 'SOLD')
    assert.equal(await saleRows(gatedVehicle), 1)
    const decided = await approvalRow(approvalId)
    assert.equal(decided.status, 'APPROVED')
    assert.equal(decided.resolved_by, users.owner)
    assert.equal(decided.resolution_note, 'Chủ đồng ý bán lỗ')
    assert.equal((await dashboard('owner')).month_revenue, beforeRevenue + BELOW)
    assert.deepEqual(await resolveApproval('owner', approvalId, 'APPROVE', 'Chủ đồng ý bán lỗ', decideKey), approved)
    assert.equal(await saleRows(gatedVehicle), 1, 'a lost response retry must not create a second sale')
    await assert.rejects(() => resolveApproval('owner', approvalId, 'REJECT', 'Bị muộn'), /ALREADY_RESOLVED/)
    const decidedNotices = await rows('SELECT * FROM public.notifications WHERE action=$1', ['APPROVE_SALE_BELOW_COST'])
    assert.ok(decidedNotices.some((n) => n.user_id === users.staff && /đã duyệt/.test(n.body)))
    pass('OWNER phê duyệt hoàn tất đúng bản đề xuất: doanh thu, công nợ, người bán, biên lai chống lưu hai lần')

    // 8. Rejecting keeps the vehicle in stock and tells the requester why.
    const rejectVehicle = await newVehicle('staff')
    const rejectId = await requestApproval('staff', proposal(rejectVehicle))
    await resolveApproval('owner', rejectId, 'REJECT', 'Giá này lỗ quá, giữ xe')
    assert.equal((await approvalRow(rejectId)).status, 'REJECTED')
    assert.equal(await saleRows(rejectVehicle), 0)
    assert.equal(await statusOf(rejectVehicle), 'IN_STOCK')
    const rejectedNotices = await rows('SELECT * FROM public.notifications WHERE action=$1', ['REJECT_SALE_BELOW_COST'])
    assert.ok(rejectedNotices.some((n) => n.user_id === users.staff && /lỗ quá/.test(n.body)))
    await deny(() => resolveApproval('manager', rejectId, 'APPROVE'), /ACCESS_DENIED/)
    await deny(() => resolveApproval('staff', rejectId, 'APPROVE'), /ACCESS_DENIED/)
    await deny(() => pos('owner', 'resolve_vehicle_deletion', '$1::uuid,$2::text,$3::text', [rejectId, 'APPROVE', null]), /APPROVAL_NOT_FOUND/)
    pass('OWNER từ chối: xe không bị bán, đơn chốt REJECTED, nhân viên nhận thông báo; MANAGER/STAFF không quyết được')

    // 9. Stale data cannot be approved; a withdrawn request can be re-filed with new numbers.
    const staleVehicle = await newVehicle('staff')
    const staleId = await requestApproval('staff', proposal(staleVehicle, { request_id: randomUUID() }))
    await pos('owner', 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify({ purchase_price: 45_000_000 }), staleVehicle])
    await assert.rejects(() => resolveApproval('owner', staleId, 'APPROVE', 'Duyệt bản cũ'), /APPROVAL_STALE_DATA/)
    assert.equal(await saleRows(staleVehicle), 0)
    assert.equal((await approvalRow(staleId)).status, 'PENDING')
    await deny(() => cancelApproval('staff2', staleId, 'Rút hộ'), /ACCESS_DENIED/)
    await cancelApproval('staff', staleId, 'Giá thu đã đổi, gửi lại bản mới')
    assert.equal((await approvalRow(staleId)).status, 'REJECTED')
    assert.equal(await statusOf(staleVehicle), 'IN_STOCK')
    const freshId = await requestApproval('staff', proposal(staleVehicle, { sale_price: 44_000_000 }))
    await assert.rejects(() => requestApproval('staff', proposal(staleVehicle, { sale_price: 44_000_000 })), /ALREADY_PENDING/)
    const freshSale = (await resolveApproval('owner', freshId, 'APPROVE', 'Duyệt bản mới')).sale_id
    assert.equal((await getSale('owner', freshSale)).sale_price, 44_000_000)
    assert.equal((await getSale('owner', freshSale)).purchase_cost_snapshot, 45_000_000)
    await deny(() => resolveApproval('owner', staleId, 'APPROVE', 'Bản đã rút'), /ALREADY_RESOLVED/)
    pass('Duyệt kiểm lại số liệu: giá thu đổi là APPROVAL_STALE_DATA, phải rút đơn và gửi lại bản mới')

    // 10. An added expense is stale data too, and OWNER below-cost sales need no request.
    const expenseVehicle = await newVehicle('staff')
    const expenseId = await requestApproval('staff', proposal(expenseVehicle))
    await pos('staff', 'save_expense', "$1::text,$2::jsonb", ['vehicle', JSON.stringify({
      vehicle_id: expenseVehicle, expense_type: 'REPAIR', description: 'Sửa xe kiểm thử', amount: 1_000_000, expense_date: day,
    })])
    await assert.rejects(() => resolveApproval('owner', expenseId, 'APPROVE'), /APPROVAL_STALE_DATA/)
    await cancelApproval('owner', expenseId, 'Chủ rút để nhân viên gửi lại')
    assert.equal((await approvalRow(expenseId)).status, 'REJECTED')
    const ownerVehicle = await newVehicle('owner')
    const ownerSale = await call('owner', 'sell_vehicle', saleData(ownerVehicle, { sale_price: BELOW }))
    assert.equal(await statusOf(ownerVehicle), 'SOLD')
    assert.equal((await getSale('owner', ownerSale)).gross_profit, BELOW - COST)
    assert.equal(await count('SELECT count(*) AS count FROM public.approval_requests WHERE subject_id=$1', [ownerVehicle]), 0)
    pass('Chi phí phát sinh cũng chặn duyệt; OWNER bán dưới giá thu tự quyết tại quầy, không gửi đơn cho chính mình')

    // 11. Two staff racing the same bike still leaves exactly one open request.
    if (db.connection) {
      const raceVehicle = await newVehicle('staff')
      const [a, b] = await Promise.all([db.connection(), db.connection()])
      try {
        const results = await Promise.all([
          asUser(a, users.staff, (client) => rpc(client, 'request_sale_below_cost', '$1::jsonb', [JSON.stringify(proposal(raceVehicle))])).then((value) => ({ value }), (error) => ({ error })),
          asUser(b, users.staff2, (client) => rpc(client, 'request_sale_below_cost', '$1::jsonb', [JSON.stringify(proposal(raceVehicle, { customer_name: 'Khách của nhân viên B' }))])).then((value) => ({ value }), (error) => ({ error })),
        ])
        const errors = results.filter((entry) => entry.error).map((entry) => entry.error.message)
        assert.equal(results.filter((entry) => !entry.error).length, 1, `expected exactly one filed request, got ${JSON.stringify(errors)}`)
        assert.ok(errors.join(' ').includes('ALREADY_PENDING'), `loser must be told the request already exists: ${errors.join(' ')}`)
        assert.equal(await count("SELECT count(*) AS count FROM public.approval_requests WHERE subject_id=$1 AND status='PENDING'", [raceVehicle]), 1)
        pass('Hai nhân viên cùng gửi duyệt một xe lúc giao nhau: chỉ một đơn mở, đơn kia nhận ALREADY_PENDING')
      } finally {
        await Promise.all([a.close(), b.close()])
      }
    } else {
      console.log('SKIP race check: PGlite is single-session.')
    }

    console.log(`\n${passed} below-cost sale approval checks passed on ${engine}.`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBelowCostSaleApprovalTests({ engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
    .then(() => process.exit(0))
    .catch((error) => { console.error(error); process.exit(1) })
}
