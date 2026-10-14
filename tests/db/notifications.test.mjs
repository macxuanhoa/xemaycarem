/**
 * Database Notifications Test Suite (in-app business bell)
 * Covers migration 20261004003900:
 * 1. fan-out: the actor plus every active OWNER/MANAGER receive a row per core trade action
 * 2. STAFF outside the transaction receive nothing; entity owners (seller/creator) do
 * 3. money copy is gated: OWNER, financial MANAGERs and the actor see prices
 * 4. same-transaction dedup: acquisition CREATE_VEHICLE, sale CREATE_PAYMENT and the
 *    cancel_sale VOID_PAYMENT cascade never produce standalone notifications
 * 5. list/mark RPCs are scoped to auth.uid(); direct table access is denied
 * 6. a null actor (service-role audit) renders as "Hệ thống" and reaches bosses only
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'
import { verifiedPayment } from './payment-fixtures.mjs'

export async function runNotificationsTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Notifications Test Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(
      ['owner', 'manager', 'financialManager', 'staff', 'staff2'].map((role) => [role, randomUUID()]),
    )
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => name === 'add_payment' ? verifiedPayment(db,users[user],users[user],data) : run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const rows = async (sql, args = []) => (await db.query(sql, args)).rows
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query(
        'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `notif-${name}@example.test`, JSON.stringify({ full_name: name })],
      )
      const role = name === 'financialManager' || name === 'manager' ? 'MANAGER'
        : name === 'staff2' ? 'STAFF' : name.toUpperCase()
      await db.query(
        'UPDATE public.profiles SET role=$1::public.user_role,active=true,can_view_financials=$2 WHERE id=$3',
        [role, name === 'financialManager', id],
      )
    }
    const notifs = (action, entityId) => rows(
      'SELECT * FROM public.notifications WHERE action=$1 AND entity_id=$2', [action, entityId],
    )

    // 1. save_vehicle by staff notifies the actor plus bosses, not other staff.
    const vehicleData = (overrides = {}) => ({
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga', license_plate: `NB-${randomUUID().slice(0, 6).toUpperCase()}`,
      frame_number: `NFRAME${randomUUID().slice(0, 8)}`, purchase_date: day,
      purchase_price: 80_000_000, ...overrides,
    })
    // Nhân viên nhập giá thu khi thêm xe, nên hồ sơ không còn ở trạng thái chờ giá.
    const carA = await call('staff', 'save_vehicle', vehicleData())
    let created = await notifs('CREATE_VEHICLE', carA)
    assert.deepEqual(
      created.map((n) => n.user_id).sort(),
      [users.owner, users.manager, users.financialManager, users.staff].sort(),
    )
    assert.equal(created.every((n) => n.actor_id === users.staff), true)
    assert.match(created[0].title, /Thêm xe NB-/) // tiêu đề = biển · khung, không còn hãng/dòng
    assert.match(created.find((n) => n.user_id === users.owner).body, /đã thêm xe/)
    assert.equal(created.find((n) => n.user_id === users.staff).deep_link, `/vehicles/${carA}`)
    pass('CREATE_VEHICLE fans out to the acting STAFF and all active OWNER/MANAGER accounts')

    // 2. Money text helper is deterministic Vietnamese formatting.
    assert.equal((await row("SELECT private.money_text(12500000) AS t")).t, '12.500.000 đ')
    assert.equal((await row("SELECT private.money_text(900000000000) AS t")).t, '900.000.000.000 đ')
    assert.equal((await row('SELECT private.money_text(NULL) AS t')).t, null)
    pass('private.money_text groups digits with dots without locale drift')

    // 3. acquire_vehicle (STAFF nhập giá thu): một thông báo cho mỗi người nhận;
    //    CREATE_VEHICLE song sinh bị dedup. MANAGER không có quyền tiền nhận bản
    //    không con số, còn chủ cửa hàng và chính người thao tác nhận bản có giá.
    const acquired = await call('staff2', 'acquire_vehicle', {
      request_id: randomUUID(),
      ...vehicleData({ seller_name: 'Người bán A', purchase_price: 70_000_000 }), initial_payment: 0,
    })
    created = await notifs('CREATE_ACQUISITION', (await row(
      'SELECT id FROM public.acquisitions WHERE vehicle_id=$1', [acquired],
    )).id)
    assert.equal(created.length, 4) // owner + 2 managers + actor staff2
    assert.equal(await count("SELECT count(*) AS count FROM public.notifications WHERE action='CREATE_VEHICLE' AND entity_id=$1", [acquired]), 0)
    assert.match(created.find((n) => n.user_id === users.owner).body, /giá vốn 70\.000\.000 đ/)
    assert.match(created.find((n) => n.user_id === users.staff2).body, /giá vốn/)
    assert.equal(created.find((n) => n.user_id === users.manager).body.includes('giá vốn'), false)
    assert.match(created[0].body, /thu vào xe/)
    assert.equal(created[0].deep_link, '/acquisitions')
    await run('financialManager', (client) => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify({ purchase_price: 80_000_000 }), acquired]))
    created = await notifs('UPDATE_VEHICLE', acquired)
    assert.deepEqual(
      created.map((n) => n.user_id).sort(),
      [users.owner, users.manager, users.financialManager, users.staff2].sort(),
    )
    assert.match(created.find((n) => n.user_id === users.staff2).body, /đã cập nhật thông tin xe/)
    pass('CREATE_ACQUISITION fans out once per recipient, skips its CREATE_VEHICLE twin, and the cost completion reaches the acquirer')

    // 4. sell_vehicle: sale notice reaches actor, bosses and the vehicle creator; the
    //    initial payment inside the same transaction is cleaned up.
    const saleId = await call('staff', 'sell_vehicle', {
      vehicle_id: acquired, customer_name: 'Khách Chu', customer_phone: '0900000000',
      sale_price: 95_000_000, sale_date: day, initial_payment: 15_000_000, payment_method: 'CASH',
    })
    created = await notifs('CREATE_SALE', saleId)
    assert.deepEqual(
      created.map((n) => n.user_id).sort(),
      [users.owner, users.manager, users.financialManager, users.staff, users.staff2].sort(),
    )
    assert.match(created.find((n) => n.user_id === users.staff2).body, /đã bán xe/)
    assert.doesNotMatch(created.find((n) => n.user_id === users.staff2).body, /95\.000\.000/)
    assert.match(created.find((n) => n.user_id === users.owner).body, /giá bán 95\.000\.000 đ/)
    assert.match(created.find((n) => n.user_id === users.manager).body, /Khách Chu/)
    assert.doesNotMatch(created.find((n) => n.user_id === users.manager).body, /giá bán/)
    assert.equal(created[0].deep_link, `/sales/${saleId}`)
    assert.equal(await count("SELECT count(*) AS count FROM public.notifications WHERE action='CREATE_PAYMENT'"), 0)
    pass('CREATE_SALE reaches bosses, the selling actor and the acquiring staff; same-txn initial payment is deduped')

    // 5. add_payment by a manager on staff's sale: plain money copy for the seller.
    const payId = await call('manager', 'add_payment', {
      sale_id: saleId, amount: 5_000_000, payment_method: 'BANK_TRANSFER', payment_date: day,
    })
    created = await notifs('CREATE_PAYMENT', payId)
    assert.equal(created.length, 4) // owner + financialManager + actor manager + seller staff
    const sellerCopy = created.find((n) => n.user_id === users.staff)
    assert.match(sellerCopy.body, /ghi nhận một khoản thu/)
    assert.doesNotMatch(sellerCopy.body, /5\.000\.000/)
    assert.match(created.find((n) => n.user_id === users.financialManager).body, /5\.000\.000 đ/)
    assert.equal(sellerCopy.deep_link, `/sales/${saleId}`)
    pass('CREATE_PAYMENT notifies the sale owner with money-free copy while finance-visible roles see the amount')

    // 6. cancel_sale: one cancellation notice; the VOID_PAYMENT cascade is deduped.
    await run('owner', (client) => rpc(client, 'cancel_sale', "$1::uuid,'Nhập nhầm phiếu kiểm thử'", [saleId]))
    assert.equal(await count("SELECT count(*) AS count FROM public.notifications WHERE action='VOID_PAYMENT'"), 0)
    created = await notifs('CANCEL_SALE', saleId)
    assert.equal(created.length, 4) // owner is both actor and boss; manager, financialManager, seller staff
    assert.match(created.find((n) => n.user_id === users.staff).body, /Hủy|đã hủy giao dịch bán xe/)
    assert.match(created.find((n) => n.user_id === users.staff).body, /Lý do: Nhập nhầm/)
    pass('CANCEL_SALE notifies the seller and bosses once, absorbing the void-payment cascade')

    // 7. UPDATE_VEHICLE on a staff-owned vehicle by another staff reaches the creator.
    await run('staff2', (client) => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify({ notes: 'đổi biển kiểm thử' }), carA]))
    created = await notifs('UPDATE_VEHICLE', carA)
    assert.equal(created.length, 5) // bosses + actor staff2 + creator staff
    assert.ok(created.some((n) => n.user_id === users.staff && /đã cập nhật thông tin xe/.test(n.body)))
    pass('UPDATE_VEHICLE notifies the vehicle creator when someone else edits it')

    // 8. list_notifications is scoped, paginated and carries unread_count.
    const listed = await call('staff', 'list_notifications', { limit: 2 })
    assert.equal(listed.items.length, 2)
    assert.equal(listed.total, (await count('SELECT count(*) AS count FROM public.notifications WHERE user_id=$1', [users.staff])))
    assert.equal(listed.unread_count, listed.total)
    const actorIds = Object.values(users)
    for (const item of listed.items) assert.ok(actorIds.includes(item.actor_id))
    await deny(() => asUser(db, null, (client) => rpc(client, 'list_notifications'), 'anon'))
    pass('list_notifications returns only the caller rows with total and unread_count')

    // 9. Read-marking RPCs cannot touch other users rows.
    const staffOwn = (await call('staff', 'list_notifications', {})).items
    const foreign = (await call('owner', 'list_notifications', {})).items[0]
    assert.equal(await run('staff', (client) => rpc(client, 'mark_notifications_read', '$1::uuid[]', [[foreign.id]])), 0)
    assert.equal(await run('staff', (client) => rpc(client, 'mark_notifications_read', '$1::uuid[]', [[staffOwn[0].id, staffOwn[1].id]])), 2)
    assert.equal((await call('staff', 'list_notifications', {})).unread_count, listed.total - 2)
    const marked = await run('owner', (client) => rpc(client, 'mark_all_notifications_read'))
    assert.equal(marked, (await count('SELECT count(*) AS count FROM public.notifications WHERE user_id=$1', [users.owner])))
    assert.equal((await call('owner', 'list_notifications', {})).unread_count, 0)
    assert.notEqual((await call('staff', 'list_notifications', {})).unread_count, 0)
    pass('mark_notifications_read and mark_all_notifications_read only ever touch the caller rows')

    // 10. The browser roles cannot select or tamper with the table directly.
    for (const user of ['owner', 'staff']) {
      await deny(() => run(user, (client) => client.query('SELECT * FROM public.notifications')))
      await deny(() => run(user, (client) => client.query('DELETE FROM public.notifications')))
    }
    await deny(() => run('staff', (client) => client.query('UPDATE public.notifications SET read_at=now()')), /permission denied/)
    pass('direct table access to notifications is revoked for every browser role')

    // 11. A service-role audit row with no session actor renders "Hệ thống" for bosses only.
    const beforeBosses = await count('SELECT count(*) AS count FROM public.notifications WHERE action=$1', ['UPDATE_VEHICLE'])
    await db.query(
      "INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,new_data) VALUES(NULL,'UPDATE_VEHICLE','vehicles',$1::uuid,$2::jsonb)",
      [carA, JSON.stringify({ vehicle_type: 'Xe tay ga', created_by: users.staff })],
    )
    created = await notifs('UPDATE_VEHICLE', carA)
    const fresh = created.filter((n) => n.actor_id === null)
    assert.equal(fresh.length, 4) // three active bosses plus the vehicle creator copy
    assert.ok(fresh.some((n) => /Hệ thống/.test(n.body)))
    assert.equal(await count('SELECT count(*) AS count FROM public.notifications WHERE action=$1', ['UPDATE_VEHICLE']), beforeBosses + fresh.length)
    pass('null-actor audits notify bosses and the entity owner with a Hệ thống attribution')

    // 12. Phân trang thật bằng offset trên một hộp thư lớn hơn trần 100 dòng.
    //     `list_notifications` cắt `least(100, …)`, còn bản cũ của trang
    //     '/thong-bao' lại tăng `limit` (50 → 100 → 150…) rồi so với mốc 500.
    //     Hai kiểm tra dưới đây chốt tại sao chiến lược đó chết ngay ở dòng 100
    //     và vì sao `offset` là con đường duy nhất tới lịch sử cũ hơn.
    const paged = randomUUID()
    await db.query(
      'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
      [paged, 'notif-paged@example.test', JSON.stringify({ full_name: 'paged' })],
    )
    await db.query(
      'UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2',
      ['STAFF', paged],
    )
    const PAGED_ROWS = 130
    const PAGE_SIZE = 25 // đúng hằng số trang mà NotificationsPage đang dùng
    await db.query(
      `INSERT INTO public.notifications(user_id,action,title,created_at)
       SELECT $1::uuid,'TEST_PAGING','Tin phân trang '||i,
              now() - make_interval(mins => i)
       FROM generate_series(1, $2::int) AS i`,
      [paged, PAGED_ROWS],
    )
    const pagedCall = (filters) => asUser(db, paged, (client) => rpc(client, 'list_notifications', '$1::jsonb', [JSON.stringify(filters)]))

    const clamped = await pagedCall({ limit: 500 })
    assert.equal(clamped.items.length, 100)
    assert.equal(clamped.total, PAGED_ROWS)
    assert.equal(clamped.unread_count, PAGED_ROWS)
    // Trần 100 là tuyệt đối: xin thêm dòng không lấy được thêm dòng nào, nên
    // mỗi lần bấm "Tải thêm" của bản cũ là một request y hệt request trước.
    assert.deepEqual((await pagedCall({ limit: 100 })).items.map((n) => n.id), clamped.items.map((n) => n.id))
    pass('list_notifications clamps limit to 100, so growing the limit cannot reach older rows')

    const windows = []
    for (let offset = 0, guard = 0; guard <= PAGED_ROWS; offset += PAGE_SIZE, guard += 1) {
      const page = await pagedCall({ limit: PAGE_SIZE, offset })
      assert.equal(page.total, PAGED_ROWS, `offset=${offset} total`)
      assert.equal(page.unread_count, PAGED_ROWS, `offset=${offset} unread_count`)
      windows.push(...page.items.map((n) => n.id))
      if (page.items.length < PAGE_SIZE) break
    }
    assert.equal(windows.length, PAGED_ROWS)
    assert.equal(new Set(windows).size, PAGED_ROWS)
    // Không trùng, không sót, và đúng thứ tự `created_at DESC, id DESC`.
    const full = await pagedCall({ limit: 100, offset: 0 })
    const tail = await pagedCall({ limit: 100, offset: 100 })
    assert.deepEqual(windows, [...full.items.map((n) => n.id), ...tail.items.map((n) => n.id)])
    assert.deepEqual(
      (await db.query(
        'SELECT id FROM public.notifications WHERE user_id=$1 ORDER BY created_at DESC, id DESC', [paged],
      )).rows.map((r) => r.id),
      windows,
    )
    pass('offset paging walks every row exactly once, in the servers ordered sequence')

    // Vượt quá danh sách: trang rỗng nhưng vẫn mang counts đúng, để client dừng
    // đúng lúc thay vì lặp lại request vô hạn.
    const past = await pagedCall({ limit: PAGE_SIZE, offset: PAGED_ROWS })
    assert.deepEqual(past.items, [])
    assert.equal(past.total, PAGED_ROWS)
    // `greatest(0, …)`: offset âm không được ném lỗi cũng không được dịch cửa sổ.
    assert.deepEqual(
      (await pagedCall({ limit: PAGE_SIZE, offset: -50 })).items.map((n) => n.id),
      full.items.slice(0, PAGE_SIZE).map((n) => n.id),
    )
    pass('offset beyond the list returns an empty page with truthful counts and clamps negative offsets')

    console.log(`\n${passed} notification checks passed.`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (process.argv[1]?.endsWith('notifications.test.mjs')) {
  await runNotificationsTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
