import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Disposable native PostgreSQL: real independent sessions and lock waits.
// Missing protocol fields are intentionally rejected; no compatibility bypass.
export async function runMandatoryWriteProtocolTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = { owner: randomUUID(), manager: randomUUID() }
  const call = (c, who, name, data) => asUser(c, users[who], client => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
  const expense = (c, who, kind, data, id = null) => asUser(c, users[who], client => rpc(client, 'save_expense', '$1::text,$2::jsonb,$3::uuid', [kind, JSON.stringify(data), id]))
  const due = (c, who, id, date, revision) => asUser(c, users[who], client => rpc(client, 'update_sale_due_date', '$1::uuid,$2::date,$3::timestamptz', [id, date, revision]))
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  const totals = async () => row('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.acquisitions) AS acquisitions,(SELECT count(*) FROM private.operation_receipts) AS receipts,(SELECT count(*) FROM public.audit_logs) AS audits')
  const audits = async (id, action) => Number((await row('SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action=$2', [id, action])).n)
  const parallel = async operations => {
    assert.ok(db.connection, 'native PostgreSQL is required for this regression suite')
    const clients = await Promise.all(operations.map(() => db.connection()))
    try { return await Promise.allSettled(operations.map((operation, index) => operation(clients[index]))) }
    finally { await Promise.all(clients.map(c => c.close())) }
  }
  let passed = 0
  const check = async (name, operation) => { await operation(); console.log(`PASS mandatory-protocol ${++passed}. ${name}`) }
  try {
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${id}@example.test`, JSON.stringify({ full_name: `Synthetic ${name}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name.toUpperCase(), id])
    }
    const { day, next, later } = await row('SELECT private.today()::text AS day,(private.today()+3)::text AS next,(private.today()+7)::text AS later')
    const intake = extra => ({ vehicle_type: 'Xe tay ga', frame_number: '', acquisition_date: day, purchase_price: 100, ...extra })
    let vehicleId
    await check('legacy acquisition requests, including overlapping retries, have no writes or audit', async () => {
      const before = await totals()
      const results = await parallel([c => call(c, 'owner', 'acquire_vehicle', intake()), c => call(c, 'owner', 'acquire_vehicle', intake())])
      assert.equal(results.filter(r => r.status === 'rejected').length, 2)
      for (const result of results) assert.match(result.reason.message, /CLIENT_UPGRADE_REQUIRED/)
      for (const request_id of [null, '', 'not-a-uuid']) {
        await assert.rejects(() => call(db, 'owner', 'acquire_vehicle', intake({ request_id })), /CLIENT_UPGRADE_REQUIRED|invalid input syntax for type uuid/)
      }
      assert.deepEqual(await totals(), before)
    })
    await check('commit with discarded response and a real blocked same-ID retry stores one acquisition', async () => {
      const data = intake({ request_id: randomUUID() })
      const clients = await Promise.all([db.connection(), db.connection()])
      let retry
      try {
        await clients[0].exec('BEGIN')
        const committedId = await call(clients[0], 'owner', 'acquire_vehicle', data)
        retry = call(clients[1], 'owner', 'acquire_vehicle', data).then(value => ({ value }), error => ({ error }))
        const deadline = Date.now() + 5000
        let waiting = false
        while (Date.now() < deadline) {
          waiting = Boolean((await row("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%acquire_vehicle%') AS waiting")).waiting)
          if (waiting) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.ok(waiting, 'the replay request must wait for the uncommitted operation receipt')
        await clients[0].exec('COMMIT')
        // The browser never receives the first result; recovery uses the same UUID.
        const result = await retry
        assert.equal(result.error, undefined)
        assert.equal(result.value, committedId)
        vehicleId = result.value
        assert.equal(Number((await row('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=$1', [vehicleId])).n), 1)
        assert.equal(await call(db, 'owner', 'acquire_vehicle', data), vehicleId)
        await assert.rejects(() => call(db, 'owner', 'acquire_vehicle', { ...data, purchase_price: 101 }), /OPERATION_REQUEST_CONFLICT/)
      } finally {
        await clients[0].exec('ROLLBACK')
        if (retry) await retry
        await Promise.all(clients.map(c => c.close()))
      }
    })
    await check('legacy batch arrays and envelopes without UUID fail before writes', async () => {
      const before = await totals()
      for (const payload of [[intake()], { rows: [intake()] }, { request_id: null, rows: [intake()] }]) {
        await assert.rejects(() => call(db, 'owner', 'import_vehicles', payload), /CLIENT_UPGRADE_REQUIRED/)
      }
      assert.deepEqual(await totals(), before)
    })
    await check('keyed batch replay creates one batch and internal row writes preserve canonical frames', async () => {
      const frame = `lower-${randomUUID()}`
      const payload = { request_id: randomUUID(), rows: [{ ...intake(), purchase_date: day, frame_number: frame }, { ...intake(), purchase_date: day }] }
      const results = await parallel([c => call(c, 'owner', 'import_vehicles', payload), c => call(c, 'owner', 'import_vehicles', payload)])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2)
      assert.deepEqual(results[0].value, results[1].value)
      assert.equal(results[0].value.imported_count, 2)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=ANY($1::uuid[])', [results[0].value.vehicle_ids])).n), 2)
      assert.equal((await row('SELECT frame_number FROM public.vehicles WHERE id=$1', [results[0].value.vehicle_ids[0]])).frame_number, frame.toUpperCase())
      assert.deepEqual(await call(db, 'owner', 'import_vehicles', payload), results[0].value)
    })
    await check('batch fault rolls back its receipt, all rows and audit; same UUID can safely retry', async () => {
      // Inject the fault via frame_number: import now enforces a canonical
      // license_plate, so a synthetic plate would be rejected before the
      // BEFORE INSERT trigger could fire. frame_number stays a free-text key.
      const faultFrame = `SYNTHETIC FAULT ${randomUUID()}`
      await db.exec(`CREATE FUNCTION private.protocol_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.frame_number LIKE 'SYNTHETIC FAULT %' THEN RAISE EXCEPTION 'SYNTHETIC_PROTOCOL_FAULT'; END IF; RETURN NEW; END $$; CREATE TRIGGER protocol_fault BEFORE INSERT ON public.vehicles FOR EACH ROW EXECUTE FUNCTION private.protocol_fault()`)
      const before = await totals()
      const payload = { request_id: randomUUID(), rows: [{ ...intake(), purchase_date: day }, { ...intake(), frame_number: faultFrame, purchase_date: day }] }
      try {
        await assert.rejects(() => call(db, 'owner', 'import_vehicles', payload), /SYNTHETIC_PROTOCOL_FAULT/)
        assert.deepEqual(await totals(), before)
      } finally { await db.exec('DROP TRIGGER protocol_fault ON public.vehicles; DROP FUNCTION private.protocol_fault()') }
      assert.equal((await call(db, 'owner', 'import_vehicles', payload)).imported_count, 2)
    })
    const saleId = await call(db, 'owner', 'sell_vehicle', { request_id: randomUUID(), vehicle_id: vehicleId, customer_name: 'Synthetic protocol sale', sale_price: 1000, initial_payment: 0, sale_date: day })
    const snapshotBefore = await row('SELECT * FROM public.sale_financials WHERE sale_id=$1', [saleId])
    const paymentsBefore = (await db.query('SELECT * FROM public.payments WHERE sale_id=$1', [saleId])).rows
    await check('two-argument due-date RPC stays discoverable but refuses stale-client writes', async () => {
      const before = await row('SELECT due_date,updated_at FROM public.sales WHERE id=$1', [saleId])
      const count = await audits(saleId, 'UPDATE_SALE_DUE_DATE')
      await assert.rejects(() => asUser(db, users.owner, c => rpc(c, 'update_sale_due_date', '$1::uuid,$2::date', [saleId, next])), /CLIENT_UPGRADE_REQUIRED/)
      assert.deepEqual(await row('SELECT due_date,updated_at FROM public.sales WHERE id=$1', [saleId]), before)
      assert.equal(await audits(saleId, 'UPDATE_SALE_DUE_DATE'), count)
    })
    await check('concurrent versioned debt changes allow one writer without changing the financial ledger', async () => {
      const before = await row('SELECT updated_at::text AS revision FROM public.sales WHERE id=$1', [saleId])
      const results = await parallel([c => due(c, 'owner', saleId, next, before.revision), c => due(c, 'manager', saleId, later, before.revision)])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.match(results.find(r => r.status === 'rejected').reason.message, /SALE_DUE_DATE_CONFLICT/)
      assert.equal(await audits(saleId, 'UPDATE_SALE_DUE_DATE'), 1)
      const current = await row('SELECT updated_at::text AS revision,due_date::text AS due_date FROM public.sales WHERE id=$1', [saleId])
      await assert.rejects(() => due(db, 'owner', saleId, null, before.revision), /SALE_DUE_DATE_CONFLICT/)
      assert.deepEqual(await row('SELECT * FROM public.sale_financials WHERE sale_id=$1', [saleId]), snapshotBefore)
      assert.deepEqual((await db.query('SELECT * FROM public.payments WHERE sale_id=$1', [saleId])).rows, paymentsBefore)
      assert.equal((await due(db, 'owner', saleId, null, current.revision)).due_date, null)
    })
    const expenseVehicle = await call(db, 'owner', 'acquire_vehicle', intake({ request_id: randomUUID() }))
    for (const kind of ['vehicle', 'business']) {
      const table = kind === 'vehicle' ? 'vehicle_expenses' : 'business_expenses'
      const data = { amount: 100, description: 'Synthetic protocol expense', expense_date: day, ...(kind === 'vehicle' ? { vehicle_id: expenseVehicle, expense_type: 'OTHER' } : { category: 'OTHER' }) }
      const id = await expense(db, 'owner', kind, data)
      await check(`${kind} expenses: create remains allowed but missing/null/empty revisions cannot edit`, async () => {
        const before = await row(`SELECT to_jsonb(e) AS data FROM public.${table} e WHERE id=$1`, [id])
        for (const payload of [{ amount: 200 }, { amount: 200, expected_updated_at: null }, { amount: 200, expected_updated_at: '' }]) {
          await assert.rejects(() => expense(db, 'owner', kind, payload, id), /CLIENT_UPGRADE_REQUIRED/)
        }
        assert.deepEqual(await row(`SELECT to_jsonb(e) AS data FROM public.${table} e WHERE id=$1`, [id]), before)
        assert.equal(await audits(id, 'UPDATE_EXPENSE'), 0)
      })
      await check(`${kind} expenses: real concurrent financial edits produce one update and one conflict`, async () => {
        const before = await row(`SELECT updated_at::text AS revision FROM public.${table} WHERE id=$1`, [id])
        const results = await parallel([c => expense(c, 'owner', kind, { amount: 200, expected_updated_at: before.revision }, id), c => expense(c, 'manager', kind, { amount: 300, expected_updated_at: before.revision }, id)])
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
        assert.match(results.find(r => r.status === 'rejected').reason.message, /EXPENSE_EDIT_CONFLICT/)
        const winner = results[0].status === 'fulfilled' ? 200 : 300
        assert.equal(Number((await row(`SELECT amount FROM public.${table} WHERE id=$1`, [id])).amount), winner)
        assert.equal(await audits(id, 'UPDATE_EXPENSE'), 1)
        if (kind === 'vehicle') {
          const current = await asUser(db, users.owner, c => rpc(c, 'get_vehicle', '$1::uuid', [expenseVehicle]))
          assert.equal(Number(current.total_cost), 100 + winner)
          const sale = await call(db, 'owner', 'sell_vehicle', { request_id: randomUUID(), vehicle_id: expenseVehicle, customer_name: 'Synthetic expense snapshot', sale_price: 1000, initial_payment: 0, sale_date: day })
          const snapshot = await row('SELECT * FROM public.sale_financials WHERE sale_id=$1', [sale])
          assert.equal(Number(snapshot.expense_cost_snapshot), winner)
          assert.equal(Number(snapshot.total_cost_snapshot), 100 + winner)
          await assert.rejects(() => expense(db, 'owner', kind, { amount: 400, expected_updated_at: before.revision }, id), /VEHICLE_EXPENSE_LOCKED/)
          assert.deepEqual(await row('SELECT * FROM public.sale_financials WHERE sale_id=$1', [sale]), snapshot)
        }
      })
    }
    await check('authenticated clients cannot bypass the protocol through private implementations or direct writes', async () => {
      await assert.rejects(() => asUser(db, users.owner, c => c.query('SELECT private.acquire_vehicle_impl($1::jsonb)', [JSON.stringify(intake())])), /permission denied/)
      await assert.rejects(() => asUser(db, users.owner, c => c.query('SELECT private.import_vehicles_impl($1::jsonb)', [JSON.stringify([intake()])])), /permission denied/)
      for (const table of ['business_expenses', 'vehicle_expenses', 'sales']) {
        await assert.rejects(() => asUser(db, users.owner, c => c.query(`UPDATE public.${table} SET updated_at=clock_timestamp()`)), /permission denied/)
      }
    })
    console.log(`Mandatory write protocol checks passed: ${passed}`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/mandatory-write-protocol.test.mjs')) {
  let failed = false
  try { await runMandatoryWriteProtocolTests() }
  catch (error) { console.error(error.stack); failed = true }
  process.exit(failed ? 1 : 0)
}
