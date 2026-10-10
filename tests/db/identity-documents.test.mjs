import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Disposable database only. Proves CCCD (identity_documents) PII and its private
// Storage images are readable/writable by OWNER/MANAGER and invisible to STAFF,
// disabled and anonymous sessions.
export async function runIdentityDocumentTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map((n) => [n, randomUUID()]))
  const run = (name, operation) => asUser(db, users[name], operation)
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/) => assert.rejects(operation, expression)
  const save = (name, data) => run(name, (client) => rpc(client, 'save_identity_document', '$1::jsonb', [JSON.stringify(data)]))
  const get = (name, kind, id) => run(name, (client) => rpc(client, 'get_identity_document', '$1::text,$2::uuid', [kind, id]))
  const register = (name, kind, id, side, path) => run(name, (client) => rpc(client, 'register_identity_document_image', '$1::text,$2::uuid,$3::text,$4::text', [kind, id, side, path]))
  let passed = 0
  const test = async (name, operation) => { await operation(); passed++; console.log(`PASS identity ${passed}. ${name}`) }
  try {
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${name}-id-${randomUUID().slice(0, 8)}@example.test`, JSON.stringify({ full_name: `CCCD ${name}` })])
      const role = name === 'disabled' ? 'STAFF' : name.toUpperCase()
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2,can_view_financials=$3,must_change_password=false WHERE id=$4', [role, name !== 'disabled', name === 'owner', id])
    }
    const day = (await row('SELECT private.today()::text AS d')).d
    const tomorrow = (await row('SELECT (private.today()+1)::text AS d')).d

    const acquisitionVehicle = await run('owner', (client) => rpc(client, 'acquire_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), frame_number: `ID-FRAME-${randomUUID().slice(0, 8)}`, vehicle_type: 'Xe tay ga', purchase_price: 50_000_000, acquisition_date: day, seller_name: 'Người bán thử' })]))
    const acquisitionId = (await row('SELECT id FROM public.acquisitions WHERE vehicle_id=$1', [acquisitionVehicle])).id
    const vehicleId = await run('owner', (client) => rpc(client, 'save_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), frame_number: `ID-SALE-${randomUUID().slice(0, 8)}`, vehicle_type: 'Xe số', purchase_date: day, purchase_price: 30_000_000 })]))
    const saleId = await run('owner', (client) => rpc(client, 'sell_vehicle', '$1::jsonb', [JSON.stringify({ vehicle_id: vehicleId, customer_name: 'Khách mua thử', sale_price: 40_000_000, sale_date: day, initial_payment: 0 })]))

    await test('OWNER/MANAGER capture and read a CCCD for the seller and the buyer', async () => {
      const docId = await save('owner', { subject_type: 'acquisition', subject_id: acquisitionId, full_name: 'Nguyễn Văn A', id_number: '079 123.456.789', dob: '1990-05-15', issued_date: '2020-01-01', place_of_issue: 'Cục Cảnh sát', address: 'TP.HCM' })
      assert.ok(docId)
      const document = await get('owner', 'acquisition', acquisitionId)
      assert.equal(document.full_name, 'Nguyễn Văn A')
      assert.equal(document.id_number, '079123456789')
      await save('manager', { subject_type: 'sale', subject_id: saleId, full_name: 'Trần Thị B', id_number: '079000111222' })
      assert.equal((await get('manager', 'sale', saleId)).full_name, 'Trần Thị B')
    })

    await test('STAFF and disabled accounts cannot read or write CCCD through RPC or table RLS', async () => {
      await deny(() => save('staff', { subject_type: 'sale', subject_id: saleId, full_name: 'Không có quyền' }))
      await deny(() => get('staff', 'sale', saleId))
      await deny(() => get('disabled', 'acquisition', acquisitionId))
      assert.equal((await run('staff', (client) => client.query('SELECT * FROM public.identity_documents'))).rows.length, 0)
      assert.equal((await run('disabled', (client) => client.query('SELECT * FROM public.identity_documents'))).rows.length, 0)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.identity_documents')).n), 2)
    })

    await test('CCCD number is normalized to 12 digits and wrong lengths are rejected', async () => {
      await deny(() => save('owner', { subject_type: 'sale', subject_id: saleId, id_number: '12345' }), /INVALID_ID_NUMBER/)
      await deny(() => save('owner', { subject_type: 'sale', subject_id: saleId, id_number: '0791234567890' }), /INVALID_ID_NUMBER/)
      await save('owner', { subject_type: 'sale', subject_id: saleId, full_name: 'Bình thường', id_number: ' 079-222.333 444 ' })
      assert.equal((await get('owner', 'sale', saleId)).id_number, '079222333444')
    })

    await test('future issue date, future birthday and unknown subjects are rejected', async () => {
      await deny(() => save('owner', { subject_type: 'sale', subject_id: saleId, issued_date: tomorrow }), /FUTURE_DATE/)
      await deny(() => save('owner', { subject_type: 'sale', subject_id: saleId, dob: tomorrow }), /INVALID_DOB/)
      await deny(() => save('owner', { subject_type: 'sale', subject_id: randomUUID() }), /SALE_NOT_FOUND/)
      await deny(() => save('owner', { subject_type: 'ghost', subject_id: saleId }), /INVALID_SUBJECT/)
    })

    await test('saving twice updates the same document (exactly one per subject)', async () => {
      await save('owner', { subject_type: 'sale', subject_id: saleId, full_name: 'Cập nhật tên', id_number: '079000111222' })
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.identity_documents WHERE sale_id=$1', [saleId])).n), 1)
      assert.equal((await get('owner', 'sale', saleId)).full_name, 'Cập nhật tên')
    })

    await test('the acquisition behind a vehicle resolves for OWNER/MANAGER only', async () => {
      assert.equal(await run('owner', (client) => rpc(client, 'get_acquisition_for_vehicle', '$1::uuid', [acquisitionVehicle])), acquisitionId)
      await deny(() => run('staff', (client) => rpc(client, 'get_acquisition_for_vehicle', '$1::uuid', [acquisitionVehicle])))
    })

    await test('private CCCD image upload/read enforces role, path, document existence and registration', async () => {
      const path = `${saleId}/${randomUUID()}.jpg`
      const upload = (name, objectPath) => run(name, (client) => client.query("INSERT INTO storage.objects(bucket_id,name) VALUES('identity-documents',$1)", [objectPath]))
      await deny(() => upload('staff', path))
      await deny(() => upload('disabled', path))
      await deny(() => asUser(db, null, (client) => client.query("INSERT INTO storage.objects(bucket_id,name) VALUES('identity-documents',$1)", [path]), 'anon'))
      await upload('owner', path)
      // The object is invisible until it is referenced by a registered document.
      assert.equal((await run('owner', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 0)
      await register('owner', 'sale', saleId, 'front', path)
      assert.equal((await run('owner', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 1)
      assert.equal((await run('staff', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 0)
      assert.equal((await get('owner', 'sale', saleId)).front_image_path, path)
      await deny(() => register('owner', 'sale', saleId, 'front', `${randomUUID()}/${randomUUID()}.jpg`), /INVALID_IMAGE_PATH/)
      await deny(() => register('owner', 'sale', saleId, 'back', `${saleId}/${randomUUID()}.jpg`), /IMAGE_UPLOAD_REQUIRED/)
    })

    await test('removing a CCCD photo detaches the path but retains the stored object', async () => {
      await run('owner', (client) => rpc(client, 'remove_identity_document_image', '$1::text,$2::uuid,$3::text', ['sale', saleId, 'front']))
      assert.equal((await get('owner', 'sale', saleId)).front_image_path, null)
    })

    const lookup = (name, number) => run(name, (client) => rpc(client, 'lookup_identity_document_vehicles', '$1::text', [number]))

    await test('camera CCCD lookup is exact, read-only and emits vehicle identity without document PII', async () => {
      const before = await row('SELECT (SELECT count(*) FROM public.audit_logs) AS audits, (SELECT count(*) FROM public.identity_documents) AS documents, (SELECT count(*) FROM public.vehicles) AS vehicles')
      const matches = await lookup('owner', '079 123.456.789')
      assert.equal(matches.length, 1)
      assert.equal(matches[0].id, acquisitionVehicle)
      assert.equal(matches[0].status, 'IN_STOCK')
      assert.equal(matches[0].vehicle_type, 'Xe tay ga')
      assert.deepEqual(Object.keys(matches[0]).sort(), ['frame_number', 'id', 'internal_code', 'license_plate', 'status', 'vehicle_type'])
      assert.deepEqual(await lookup('manager', '079123456780'), [])
      assert.deepEqual(await lookup('owner', '079000111222'), [], 'sold vehicles are outside inventory')
      assert.deepEqual(await row('SELECT (SELECT count(*) FROM public.audit_logs) AS audits, (SELECT count(*) FROM public.identity_documents) AS documents, (SELECT count(*) FROM public.vehicles) AS vehicles'), before)
    })

    await test('camera CCCD lookup rejects partial numbers and OCR letter substitutions', async () => {
      for (const number of ['', '07912345678', '0791234567890', 'O79123456789', 'CCCD079123456789', null]) {
        await deny(() => lookup('owner', number), /INVALID_ID_NUMBER/)
      }
    })

    await test('camera CCCD lookup preserves the document role and anonymous restrictions', async () => {
      await deny(() => lookup('staff', '079123456789'))
      await deny(() => lookup('disabled', '079123456789'))
      await deny(() => asUser(db, null, (client) => rpc(client, 'lookup_identity_document_vehicles', '$1::text', ['079123456789']), 'anon'))
    })

    await test('camera CCCD lookup returns every at-store link once, including returned and reserved vehicles', async () => {
      await run('owner', (client) => rpc(client, 'cancel_sale', '$1::uuid,$2::text', [saleId, 'Khách trả xe thử']))
      await db.query("UPDATE public.vehicles SET status='RESERVED' WHERE id=$1", [vehicleId])
      await save('owner', { subject_type: 'sale', subject_id: saleId, id_number: '079123456789' })
      const extraAcquisition = await db.query('INSERT INTO public.acquisitions(vehicle_id,acquisition_date,purchase_price,seller_name,created_by) VALUES($1,$2,30000000,$3,$4) RETURNING id', [vehicleId, day, 'Người bán thử', users.owner])
      await save('owner', { subject_type: 'acquisition', subject_id: extraAcquisition.rows[0].id, id_number: '079123456789' })
      const matches = await lookup('manager', '079123456789')
      assert.equal(matches.length, 2, 'the same vehicle linked through sale and acquisition is deduplicated')
      assert.deepEqual(matches.map((match) => match.id).sort(), [acquisitionVehicle, vehicleId].sort())
      assert.equal(matches.find((match) => match.id === vehicleId).status, 'RESERVED')
    })

    await test('camera CCCD lookup excludes cancelled acquisitions, cancelled vehicles and pending deletion', async () => {
      await db.query("UPDATE public.acquisitions SET status='CANCELLED' WHERE id=$1", [acquisitionId])
      assert.deepEqual((await lookup('owner', '079123456789')).map((match) => match.id), [vehicleId])
      await db.query("UPDATE public.vehicles SET status='CANCELLED' WHERE id=$1", [vehicleId])
      assert.deepEqual(await lookup('owner', '079123456789'), [])
      await db.query("UPDATE public.acquisitions SET status='COMPLETED' WHERE id=$1", [acquisitionId])
      assert.deepEqual((await lookup('owner', '079123456789')).map((match) => match.id), [acquisitionVehicle])
      await run('staff', (client) => rpc(client, 'request_delete_vehicle', '$1::uuid,$2::text', [acquisitionVehicle, 'Xe nhập nhầm thử']))
      assert.deepEqual(await lookup('owner', '079123456789'), [])
    })

    console.log(`CCCD identity-document checks passed: ${passed}`)
    return passed
  } finally {
    if (!externalDb) await db.close()
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/identity-documents.test.mjs')) {
  try { await runIdentityDocumentTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' }) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
