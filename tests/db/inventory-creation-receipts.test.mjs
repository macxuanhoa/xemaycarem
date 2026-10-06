import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runInventoryCreationReceiptTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const owner = randomUUID(), other = randomUUID()
  const save = (connection, actor, data, id = null) => asUser(connection, actor, c => rpc(c, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify(data), id]))
  const lookup = (actor, id) => asUser(db, actor, c => rpc(c, 'get_operation_result', '$1::text,$2::uuid', ['create_vehicle', id]))
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  const counts = async () => row('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.vehicle_financials) AS financials,(SELECT count(*) FROM public.acquisitions) AS acquisitions,(SELECT count(*) FROM public.payments) AS payments,(SELECT count(*) FROM public.audit_logs) AS audits,(SELECT count(*) FROM private.operation_receipts) AS receipts')
  let passed = 0
  const check = async (name, action) => { await action(); console.log(`PASS inventory-receipts ${++passed}. ${name}`) }
  try {
    for (const id of [owner, other]) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${id}@example.test`, '{"full_name":"Synthetic inventory receipt"}'])
      await db.query("UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false,can_view_financials=true WHERE id=$2", [id === owner ? 'OWNER' : 'MANAGER', id])
    }
    const day = (await row('SELECT private.today()::text AS day')).day
    const data = { model: 'Synthetic inventory protocol', frame_number: '', purchase_price: 100, asking_price: 1000, purchase_date: day }
    let vehicleId
    await check('old keyless inventory creates fail before inventory/cost/financial history writes', async () => {
      const before = await counts()
      for (const request of [data, { ...data, request_id: null }, { ...data, request_id: '' }]) {
        await assert.rejects(() => save(db, owner, request), /CLIENT_UPGRADE_REQUIRED/)
      }
      assert.deepEqual(await counts(), before)
    })
    await check('same UUID after unreceived commit recovers one inventory record and one cost row', async () => {
      assert.ok(db.connection, 'native independent PostgreSQL sessions are required')
      const payload = { ...data, request_id: randomUUID() }
      const clients = await Promise.all([db.connection(), db.connection()])
      let retry
      try {
        await clients[0].exec('BEGIN')
        const ignored = await save(clients[0], owner, payload)
        retry = save(clients[1], owner, payload).then(value => ({ value }), error => ({ error }))
        let waiting = false
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          waiting = Boolean((await row("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%save_vehicle%') AS waiting")).waiting)
          if (waiting) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.ok(waiting, 'second real connection waits for the operation receipt transaction')
        await clients[0].exec('COMMIT')
        const result = await retry
        assert.equal(result.error, undefined)
        assert.equal(result.value, ignored)
        vehicleId = result.value
        const beforeReplay = await counts()
        assert.equal(await save(db, owner, payload), vehicleId)
        assert.deepEqual(await counts(), beforeReplay)
        assert.deepEqual(await lookup(owner, payload.request_id), { confirmed: true, result: vehicleId })
        assert.equal((await lookup(other, payload.request_id)).confirmed, false)
        const proof = await row('SELECT (SELECT count(*) FROM public.vehicle_financials WHERE vehicle_id=$1) AS financials,(SELECT count(*) FROM public.acquisitions WHERE vehicle_id=$1) AS acquisitions,(SELECT count(*) FROM public.sales WHERE vehicle_id=$1) AS sales,(SELECT count(*) FROM public.audit_logs WHERE entity_id=$1 AND action=$2) AS audits', [vehicleId, 'CREATE_VEHICLE'])
        assert.deepEqual(Object.values(proof).map(Number), [1, 0, 0, 1])
        await assert.rejects(() => save(db, owner, { ...payload, purchase_price: 101 }), /OPERATION_REQUEST_CONFLICT/)
        assert.deepEqual(await counts(), beforeReplay)
      } finally {
        await clients[0].exec('ROLLBACK')
        if (retry) await retry
        await Promise.all(clients.map(c => c.close()))
      }
    })
    await check('failed creation rolls back the receipt and same UUID can be corrected safely', async () => {
      const payload = { ...data, request_id: randomUUID(), asking_price: -1 }
      const before = await counts()
      await assert.rejects(() => save(db, owner, payload), /INVALID_MONEY/)
      assert.deepEqual(await counts(), before)
      assert.ok(await save(db, owner, { ...payload, asking_price: 1000 }))
    })
    await check('the existing inventory edit and cost accounting semantics remain available', async () => {
      const current = await asUser(db, owner, c => rpc(c, 'get_vehicle', '$1::uuid', [vehicleId]))
      const before = await row('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=$1', [vehicleId])
      assert.equal(await save(db, owner, { color: 'Blue', purchase_price: 150, expected_updated_at: current.updated_at }, vehicleId), vehicleId)
      const edited = await asUser(db, owner, c => rpc(c, 'get_vehicle', '$1::uuid', [vehicleId]))
      assert.equal(edited.color, 'Blue')
      assert.equal(Number(edited.purchase_price), 150)
      assert.deepEqual(await row('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=$1', [vehicleId]), before)
      await assert.rejects(() => save(db, owner, { color: 'Red', expected_updated_at: current.updated_at }, vehicleId), /VEHICLE_EDIT_CONFLICT/)
    })
    await check('private implementation and receipt table remain inaccessible to authenticated clients', async () => {
      await assert.rejects(() => asUser(db, owner, c => c.query('SELECT private.save_vehicle_impl($1::jsonb,NULL)', [JSON.stringify(data)])), /permission denied/)
      await assert.rejects(() => asUser(db, owner, c => c.query('SELECT * FROM private.operation_receipts')), /permission denied/)
    })
    console.log(`Inventory creation receipt checks passed: ${passed}`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/inventory-creation-receipts.test.mjs')) {
  let failed = false
  try { await runInventoryCreationReceiptTests() }
  catch (error) { failed = true; console.error(error.stack) }
  process.exit(failed ? 1 : 0)
}
