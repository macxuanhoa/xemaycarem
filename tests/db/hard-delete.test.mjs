/**
 * Database Hard-Delete Test Suite (OWNER/MANAGER vehicle + acquisition purge)
 * Covers migration 20261002003700:
 * 1. delete_vehicle removes the xe kèm tài chính, chi phí, ảnh, hoạt động and writes an immutable audit row
 * 2. STAFF and anon are denied; MANAGER is allowed
 * 3. a reason of 3–1000 characters is mandatory
 * 4. any vehicle that was ever sold (even after cancellation) is blocked with SALE_HISTORY_EXISTS
 * 5. delete_acquisition removes the phiếu thu together with its xe (and unknown ids fail cleanly)
 * 6. public showroom leads survive with vehicle_id set to NULL
 * 7. the private purge helper is unreachable from client roles and the immutability
 *    exception is never active outside the guarded transaction path
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runHardDeleteTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Hard-Delete Test Suite ---')
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
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `hard-delete-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true WHERE id=$2', [name.toUpperCase(), id])
    }

    const vehicleData = (overrides = {}) => ({
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga', license_plate: `KD-${randomUUID().slice(0, 6).toUpperCase()}`,
      frame_number: `FRAME${randomUUID().slice(0, 8)}`, purchase_date: day,
      purchase_price: 80_000_000, ...overrides,
    })

    // 1. Full cascade purge with audit evidence for an ordinary inventory vehicle.
    const vehicleId = await call('owner', 'save_vehicle', vehicleData())
    await run('owner', (client) => rpc(client, 'save_expense', "'vehicle',$1::jsonb", [JSON.stringify({ vehicle_id: vehicleId, expense_type: 'REPAIR', description: 'Chi phí kiểm thử xóa', amount: 500_000, expense_date: day })]))
    const imagePath = `${vehicleId}/${randomUUID()}.jpg`
    await run('owner', (client) => client.query("INSERT INTO storage.objects(bucket_id,name) VALUES('vehicle-images',$1)", [imagePath]))
    await run('owner', (client) => rpc(client, 'register_vehicle_image', '$1::uuid,$2', [vehicleId, imagePath]))
    assert.ok((await count('SELECT count(*) AS count FROM public.vehicle_activity WHERE vehicle_id=$1', [vehicleId])) > 0)

    await run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [vehicleId, 'Nhập nhầm xe trùng bản ghi']))
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [vehicleId]), 0)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicle_financials WHERE vehicle_id=$1', [vehicleId]), 0)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicle_expenses WHERE vehicle_id=$1', [vehicleId]), 0)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicle_images WHERE vehicle_id=$1', [vehicleId]), 0)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicle_activity WHERE vehicle_id=$1', [vehicleId]), 0)
    const purgeAudit = (await db.query("SELECT * FROM public.audit_logs WHERE action='DELETE_VEHICLE' AND entity_id=$1", [vehicleId])).rows[0]
    assert.ok(purgeAudit, 'DELETE_VEHICLE must leave an immutable audit row')
    assert.equal(purgeAudit.user_id, users.owner)
    assert.equal(purgeAudit.old_data.license_plate.split('-')[0], 'KD')
    assert.equal(purgeAudit.new_data.reason, 'Nhập nhầm xe trùng bản ghi')
    assert.equal(await count('SELECT count(*) AS count FROM storage.objects WHERE name=$1', [imagePath]), 1, 'bucket objects stay for administrative retention')
    pass('delete_vehicle purges financials, expenses, images and activity while auditing the full snapshot')

    // 2. Role gating: MANAGER allowed, STAFF and anon denied.
    const staffVehicle = await call('staff', 'save_vehicle', vehicleData())
    await deny(() => run('staff', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [staffVehicle, 'Nhân viên không được xóa'])))
    await deny(() => asUser(db, null, (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [staffVehicle, 'khach la']), 'anon'))
    await run('manager', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [staffVehicle, 'Quản lý dọn dữ liệu nhập nhầm']))
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [staffVehicle]), 0)
    pass('OWNER and MANAGER may purge vehicles; STAFF and anon are denied')

    // 3. The mandatory reason contract mirrors cancel_acquisition (3–1000 chars).
    const tooShort = await call('owner', 'save_vehicle', vehicleData())
    await deny(() => run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [tooShort, 'ab'])), /DELETION_REASON_REQUIRED/)
    await deny(() => run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [tooShort, null])), /DELETION_REASON_REQUIRED/)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [tooShort]), 1)
    pass('Missing or short reasons are rejected before any deletion happens')

    // 4. A vehicle that was ever sold keeps its history even after the sale is cancelled.
    const soldVehicle = await call('owner', 'save_vehicle', vehicleData())
    const saleId = await run('staff', (client) => rpc(client, 'sell_vehicle', '$1::jsonb', [JSON.stringify({ vehicle_id: soldVehicle, customer_name: 'Khách xóa thử', customer_phone: '0000000001', sale_price: 90_000_000, sale_date: day, initial_payment: 10_000_000, payment_method: 'CASH' })]))
    await deny(() => run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [soldVehicle, 'Xe đã bán']) ), /SALE_HISTORY_EXISTS/)
    await run('manager', (client) => rpc(client, 'cancel_sale', '$1::uuid,$2::text', [saleId, 'Khách trả xe kiểm thử']))
    assert.equal((await run('owner', (client) => rpc(client, 'get_vehicle', '$1::uuid', [soldVehicle]))).status, 'IN_STOCK')
    await deny(() => run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [soldVehicle, 'Xe từng bán']) ), /SALE_HISTORY_EXISTS/)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [soldVehicle]), 1)
    assert.equal(await count('SELECT count(*) AS count FROM public.sale_financials WHERE sale_id=$1', [saleId]), 1)
    pass('Sold-then-cancelled vehicles are protected: SALE_HISTORY_EXISTS blocks the purge')

    // 5. delete_acquisition purges the phiếu thu together with its xe.
    const acquiredVehicle = await call('staff', 'acquire_vehicle', vehicleData({ request_id: randomUUID(), purchase_price: 60_000_000, seller_name: 'Người bán test' }))
    const acquisitionId = await run('owner', (client) => rpc(client, 'get_acquisition_for_vehicle', '$1::uuid', [acquiredVehicle]))
    assert.ok(acquisitionId)
    await deny(() => run('staff', (client) => rpc(client, 'delete_acquisition', '$1::uuid,$2::text', [acquisitionId, 'staff không quyền'])))
    await run('owner', (client) => rpc(client, 'delete_acquisition', '$1::uuid,$2::text', [acquisitionId, 'Thu xe nhầm người bán']))
    assert.equal(await count('SELECT count(*) AS count FROM public.acquisitions WHERE id=$1', [acquisitionId]), 0)
    assert.equal(await count('SELECT count(*) AS count FROM public.vehicles WHERE id=$1', [acquiredVehicle]), 0)
    const acqAudit = (await db.query("SELECT * FROM public.audit_logs WHERE action='DELETE_ACQUISITION' AND entity_id=$1", [acquisitionId])).rows[0]
    assert.ok(acqAudit && acqAudit.new_data.vehicle.id === acquiredVehicle)
    await deny(() => run('owner', (client) => rpc(client, 'delete_acquisition', '$1::uuid,$2::text', [randomUUID(), 'không tồn tại'])), /ACQUISITION_NOT_FOUND/)
    pass('delete_acquisition removes the acquisition and its vehicle, audits both, and rejects unknown ids')

    // 6. Public showroom leads keep existing when the xe they referenced disappears.
    const leadVehicle = await call('owner', 'save_vehicle', vehicleData())
    const leadId = await asUser(db, null, (client) => rpc(client, 'create_showroom_lead', '$1::jsonb', [JSON.stringify({ kind: 'VEHICLE_INQUIRY', customer_name: 'KháchSHOWROOM', phone: '0914929292', vehicle_id: leadVehicle })]), 'anon')
    await run('owner', (client) => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [leadVehicle, 'Dọn xe trước giờ đóng ca'] ))
    const leadRow = (await db.query('SELECT vehicle_id FROM public.showroom_leads WHERE id=$1', [leadId])).rows[0]
    assert.equal(leadRow.vehicle_id, null, 'leads survive with the FK relaxed to NULL')
    pass('showroom leads survive a vehicle purge with vehicle_id set to NULL')

    // 7. The purge helper is unreachable from client roles and the trigger exception
    //    never applies outside the guarded transaction path.
    await deny(() => run('owner', (client) => client.query('SELECT private.purge_vehicle($1::uuid)', [leadVehicle])), /permission denied/)
    await deny(() => run('staff', (client) => client.query("SELECT set_config('private.allow_record_purge','on',false), private.purge_vehicle($1::uuid)", [soldVehicle])), /permission denied/)
    const activityRow = (await db.query('SELECT id FROM public.vehicle_activity LIMIT 1')).rows[0]
    await deny(() => db.query('DELETE FROM public.vehicle_activity WHERE id=$1', [activityRow.id]), /IMMUTABLE_HISTORY/)
    pass('private.purge_vehicle is owner-only and immutability holds outside the guarded purge')

    console.log(`\n${passed} hard-delete checks passed on ${engine}.`)
  } finally {
    if (ownDb) await db.close()
  }
}
