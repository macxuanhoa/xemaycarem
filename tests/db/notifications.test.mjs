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
      brand: 'Honda', model: 'SH 160', license_plate: `NB-${randomUUID().slice(0, 6).toUpperCase()}`,
      frame_number: `NFRAME${randomUUID().slice(0, 8)}`, purchase_date: day,
      purchase_price: 80_000_000, asking_price: 90_000_000, ...overrides,
    })
    // STAFF cannot store prices, so the inventory entry starts cost-pending.
    const carA = await call('staff', 'save_vehicle', vehicleData({ purchase_price: undefined }))
    let created = await notifs('CREATE_VEHICLE', carA)
    assert.deepEqual(
      created.map((n) => n.user_id).sort(),
      [users.owner, users.manager, users.financialManager, users.staff].sort(),
    )
    assert.equal(created.every((n) => n.actor_id === users.staff), true)
    assert.match(created[0].title, /Honda SH 160/)
    assert.match(created.find((n) => n.user_id === users.owner).body, /đã thêm xe/)
    assert.equal(created.find((n) => n.user_id === users.staff).deep_link, `/vehicles/${carA}`)
    pass('CREATE_VEHICLE fans out to the acting STAFF and all active OWNER/MANAGER accounts')

    // 2. Money text helper is deterministic Vietnamese formatting.
    assert.equal((await row("SELECT private.money_text(12500000) AS t")).t, '12.500.000 đ')
    assert.equal((await row("SELECT private.money_text(900000000000) AS t")).t, '900.000.000.000 đ')
    assert.equal((await row('SELECT private.money_text(NULL) AS t')).t, null)
    pass('private.money_text groups digits with dots without locale drift')

    // 3. acquire_vehicle (STAFF flow, price unknown): one notice per recipient;
    //    the paired CREATE_VEHICLE is deduped. Then the financial MANAGER completes
    //    the cost, which reaches the acquiring STAFF as an UPDATE_VEHICLE notice.
    const acquired = await call('staff2', 'acquire_vehicle', {
      request_id: randomUUID(),
      ...vehicleData({ seller_name: 'Người bán A', purchase_price: undefined }), initial_payment: 0,
    })
    created = await notifs('CREATE_ACQUISITION', (await row(
      'SELECT id FROM public.acquisitions WHERE vehicle_id=$1', [acquired],
    )).id)
    assert.equal(created.length, 4) // owner + 2 managers + actor staff2
    assert.equal(await count("SELECT count(*) AS count FROM public.notifications WHERE action='CREATE_VEHICLE' AND entity_id=$1", [acquired]), 0)
    assert.equal(created.every((n) => !/giá vốn/.test(n.body)), true) // cost pending, no price to reveal
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
      [carA, JSON.stringify({ brand: 'Honda', model: 'SH 160', created_by: users.staff })],
    )
    created = await notifs('UPDATE_VEHICLE', carA)
    const fresh = created.filter((n) => n.actor_id === null)
    assert.equal(fresh.length, 4) // three active bosses plus the vehicle creator copy
    assert.ok(fresh.some((n) => /Hệ thống/.test(n.body)))
    assert.equal(await count('SELECT count(*) AS count FROM public.notifications WHERE action=$1', ['UPDATE_VEHICLE']), beforeBosses + fresh.length)
    pass('null-actor audits notify bosses and the entity owner with a Hệ thống attribution')

    console.log(`\n${passed} notification checks passed.`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (process.argv[1]?.endsWith('notifications.test.mjs')) {
  await runNotificationsTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
