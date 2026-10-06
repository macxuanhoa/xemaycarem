import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Diagnostic release gate: observed unsafe outcomes are FAIL, never accepted as PASS.
const db = await createDatabase({ engine: 'postgres' })
const users = { owner: randomUUID(), a: randomUUID(), b: randomUUID() }
let passed = 0, failed = 0
const failures = []
const call = (connection, actor, name, payload, id) => asUser(connection, users[actor], client =>
  rpc(client, name, id ? '$1::jsonb,$2::uuid' : '$1::jsonb', id ? [JSON.stringify(payload), id] : [JSON.stringify(payload)]))
const check = async (name, operation) => {
  try { await operation(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; failures.push(name); console.log(`FAIL ${name}: ${error.message}`) }
}
const both = async (operations) => {
  const clients = await Promise.all(operations.map(() => db.connection()))
  try { return await Promise.allSettled(operations.map((op, i) => op(clients[i]))) }
  finally { await Promise.all(clients.map(client => client.close())) }
}
let day
const vehicle = (extra = {}) => ({ request_id: randomUUID(), brand: 'Honda', model: 'Audit TEST ONLY', frame_number: `AUDIT-${randomUUID()}`, purchase_date: day, purchase_price: 100, asking_price: 1000, ...extra })
const create = (extra) => call(db, 'owner', 'save_vehicle', vehicle(extra))
const sale = (id, extra = {}) => ({ request_id: randomUUID(), vehicle_id: id, customer_name: 'Audit fake customer', customer_phone: '', sale_price: 1000, initial_payment: 0, payment_method: 'CASH', sale_date: day, ...extra })
const pay = (id, extra = {}) => ({ sale_id: id, amount: 100, payment_method: 'CASH', payment_date: day, request_id: randomUUID(), ...extra })
const prepare = async (id, extra = {}, actor = 'a') => {
  const data = pay(id, { evidence_kind: 'CASH_VOUCHER', evidence_scope: 'SYNTHETIC_AUDIT_CASH', evidence_reference: `VOUCHER-${randomUUID()}`, ...extra })
  const receipt = await call(db, actor, 'prepare_payment_receipt', data)
  return { ...data, request_id: randomUUID(), receipt_id: receipt.id, verification_reference: 'Synthetic voucher checked by audit OWNER' }
}
const count = async (table, column, id) => Number((await db.query(`SELECT count(*) AS n FROM public.${table} WHERE ${column}=$1`, [id])).rows[0].n)

try {
  day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
  for (const [name, id] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `audit-${name}-${randomUUID()}@example.test`, JSON.stringify({ full_name: `Audit ${name}` })])
    await db.query("UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2", [name === 'owner' ? 'OWNER' : 'STAFF', id])
  }
  await check('two employees selling with initial payments create only one sale/payment', async () => {
    const id = await create()
    const result = await both(['a', 'b'].map(actor => c => call(c, actor, 'sell_vehicle', sale(id, { initial_payment: 100 }))))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await count('sales', 'vehicle_id', id), 1)
    const saleId = result.find(r => r.status === 'fulfilled').value
    assert.equal(await count('payments', 'sale_id', saleId), 1)
  })
  await check('simultaneous acquisitions with identical chassis create one vehicle/acquisition', async () => {
    const frame = `AUDIT-DUP-${randomUUID()}`
    const payload = { ...vehicle({ frame_number: frame }), acquisition_date: day }
    const result = await both([c => call(c, 'owner', 'acquire_vehicle', payload), c => call(c, 'owner', 'acquire_vehicle', { ...payload, request_id: randomUUID() })])
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    const id = result.find(r => r.status === 'fulfilled').value
    assert.equal(await count('vehicles', 'frame_number', frame.toUpperCase()), 1)
    assert.equal(await count('acquisitions', 'vehicle_id', id), 1)
  })
  await check('two tabs same request key record one payment and one audit', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const payload = await prepare(id)
    const result = await both([c => call(c, 'owner', 'add_payment', payload), c => call(c, 'owner', 'add_payment', payload)])
    assert.ok(result.every(r => r.status === 'fulfilled' && r.value === payload.receipt_id))
    assert.equal(await count('payments', 'sale_id', id), 1)
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action='CREATE_PAYMENT' AND entity_id=$1", [payload.receipt_id])).rows[0].n), 1)
  })
  await check('acquisition retry after lost response without chassis returns the committed acquisition', async () => {
    const payload = { ...vehicle({ frame_number: '' }), acquisition_date: day, request_id: randomUUID() };
    const first = await call(db, 'owner', 'acquire_vehicle', payload);
    const second = await call(db, 'owner', 'acquire_vehicle', payload);
    const rows = await db.query('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=ANY($1::uuid[])', [[first, second]]);
    assert.equal(Number(rows.rows[0].n), 1, 'one acquisition saved twice after loss of its committed response');
  })
  await check('legacy unkeyed acquisition retry is also protected without chassis', async () => {
    const payload = { ...vehicle({ frame_number: '' }), acquisition_date: day };
    delete payload.request_id
    const before = (await db.query('SELECT (SELECT count(*) FROM public.acquisitions) AS acquisitions,(SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.audit_logs) AS audits')).rows[0]
    const result = await both([c => call(c, 'owner', 'acquire_vehicle', payload), c => call(c, 'owner', 'acquire_vehicle', payload)])
    assert.ok(result.every(r => r.status === 'rejected' && /CLIENT_UPGRADE_REQUIRED/.test(r.reason.message)), 'unsafe legacy callers must upgrade before creating a transaction')
    assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM public.acquisitions) AS acquisitions,(SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.audit_logs) AS audits')).rows[0], before)
  })
  await check('competing payments never exceed outstanding debt', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const payloads = [await prepare(id, { amount: 600 }, 'a'), await prepare(id, { amount: 600 }, 'b')]
    const result = await both(payloads.map(payload => c => call(c, 'owner', 'add_payment', payload)))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await count('payments', 'sale_id', id), 1)
    assert.equal(Number((await db.query("SELECT sum(amount) AS total FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [id])).rows[0].total), 600)
  })
  await check('distinct request keys for one real-world receipt cannot double collect', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const evidence = `SAME-REAL-RECEIPT-${randomUUID()}`
    const proposals = await both(['a', 'b'].map(actor => c => call(c, actor, 'prepare_payment_receipt', pay(id, { evidence_kind: 'CASH_VOUCHER', evidence_scope: 'SYNTHETIC_AUDIT_CASH', evidence_reference: evidence }))))
    assert.ok(proposals.every(r => r.status === 'fulfilled'))
    assert.equal(proposals[0].value.id, proposals[1].value.id, 'one physical voucher must resolve to one server receipt across employees')
    const payload = { receipt_id: proposals[0].value.id, verification_reference: 'Synthetic physical voucher verified' }
    const result = await both([c => call(c, 'owner', 'add_payment', { ...payload, request_id: randomUUID() }), c => call(c, 'owner', 'add_payment', { ...payload, request_id: randomUUID() })])
    assert.ok(result.every(r => r.status === 'fulfilled' && r.value === payload.receipt_id))
    assert.equal(await count('payments', 'sale_id', id), 1, 'same receipt was recorded twice with distinct keys')
    assert.equal(Number((await db.query("SELECT sum(amount) AS total FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [id])).rows[0].total), 100)
  })
  await check('stale vehicle edit is rejected instead of overwriting latest value', async () => {
    const id = await create()
    const snapshot = await asUser(db, users.owner, c => rpc(c, 'get_vehicle', '$1::uuid', [id]))
    await call(db, 'owner', 'save_vehicle', { color: 'New color' }, id)
    await assert.rejects(() => call(db, 'owner', 'save_vehicle', {
      color: snapshot.color, model: 'Unrelated edit', expected_updated_at: snapshot.updated_at,
    }, id), /VEHICLE_EDIT_CONFLICT/)
    const actual = await asUser(db, users.owner, c => rpc(c, 'get_vehicle', '$1::uuid', [id]))
    assert.equal(actual.color, 'New color', 'old form silently overwrote another edit')
  })
  await check('stale reservation form cannot revert a completed sale', async () => {
    const id = await create()
    await call(db, 'a', 'sell_vehicle', sale(id))
    await assert.rejects(() => call(db, 'owner', 'save_vehicle', { status: 'RESERVED' }, id), /SOLD_VEHICLE_LOCKED/)
  })
  await check('revoked employee waiting on vehicle lock cannot commit a sale', async () => {
    const id = await create()
    const lock = await db.connection(), waiting = await db.connection()
    let pending
    try {
      await lock.exec('BEGIN')
      await lock.query('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id])
      pending = call(waiting, 'b', 'sell_vehicle', sale(id)).then(value => ({ value }), error => ({ error }))
      let blocked = false
      for (let i = 0; i < 100; i++) {
        const result = await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")
        if (Number(result.rows[0].n)) { blocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(blocked, 'must observe an actual PostgreSQL lock wait')
      await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.b])
      await lock.exec('COMMIT')
      const result = await pending
      assert.ok(result.error, 'employee disabled during lock wait still committed')
      assert.equal(await count('sales', 'vehicle_id', id), 0)
    } finally {
      await lock.exec('ROLLBACK').catch(() => {})
      if (pending) await pending
      await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.b])
      await lock.close(); await waiting.close()
    }
  })
  await check('empty model/unknown acquisition price reaches actual backend safely', async () => {
    const payload = { ...vehicle({ model: '' }), acquisition_date: day }
    delete payload.purchase_price
    const id = await call(db, 'owner', 'acquire_vehicle', payload)
    await assert.rejects(() => call(db, 'a', 'sell_vehicle', sale(id)), /PURCHASE_COST_REQUIRED/)
    assert.equal(await count('acquisitions', 'vehicle_id', id), 1)
  })
  await check('lost sale response followed by retry creates no second sale/initial payment', async () => {
    const id = await create()
    const payload = sale(id, { initial_payment: 100 })
    const saved = await call(db, 'a', 'sell_vehicle', payload)
    assert.equal(await call(db, 'a', 'sell_vehicle', payload), saved, 'same committed operation must be recoverable')
    await assert.rejects(() => call(db, 'a', 'sell_vehicle', sale(id, { initial_payment: 100 })), /VEHICLE_NOT_AVAILABLE/)
    assert.equal(await count('sales', 'vehicle_id', id), 1)
    assert.equal(await count('payments', 'sale_id', saved), 1)
  })
  await check('payment racing sale cancellation leaves no active receipt on cancelled sale', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const payload = await prepare(id)
    const result = await both([
      c => call(c, 'owner', 'add_payment', payload),
      c => asUser(c, users.owner, client => rpc(client, 'cancel_sale', '$1::uuid,$2::text', [id, 'Audit cancellation TEST ONLY'])),
    ])
    assert.equal(result[1].status, 'fulfilled')
    const rows = await db.query("SELECT status FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [id])
    assert.equal(rows.rows.length, 0)
  })
  await check('background workers claim a queued message only once', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const row = (await db.query("UPDATE public.message_outbox SET status='QUEUED', next_attempt_at=now() WHERE sale_id=$1 RETURNING id", [id])).rows[0]
    assert.ok(row)
    const result = await both(['a', 'b'].map(actor => c => asUser(c, users[actor], client => rpc(client, 'claim_message', '$1::uuid,$2::text', [row.id, 'MOCK']))))
    assert.ok(result.every(r => r.status === 'fulfilled'))
    assert.equal(result.filter(r => r.value.id === row.id).length, 1)
  })
  await check('concurrent debt due-date edits surface a conflict', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const revision = (await db.query('SELECT updated_at::text AS revision FROM public.sales WHERE id=$1', [id])).rows[0].revision
    const result = await both(['a', 'b'].map((actor, index) => c => asUser(c, users[actor], client =>
      rpc(client, 'update_sale_due_date', '$1::uuid,($2::date + $3::integer),$4::timestamptz', [id, day, index + 1, revision]))))
    assert.equal(result.filter(r => r.status === 'rejected').length, 1, 'both competing due-date edits were accepted without conflict')
    assert.ok(result.some(r => r.status === 'rejected' && /SALE_DUE_DATE_CONFLICT/.test(r.reason.message)))
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_SALE_DUE_DATE'", [id])).rows[0].n), 1)
  })
  await check('legacy due-date callers also reject stale overlapping updates', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const before = (await db.query('SELECT due_date,updated_at FROM public.sales WHERE id=$1', [id])).rows[0]
    const beforeAudits = await count('audit_logs', 'entity_id', id)
    const result = await both(['a', 'b'].map((actor, index) => c => asUser(c, users[actor], client =>
      rpc(client, 'update_sale_due_date', '$1::uuid,($2::date + $3::integer)', [id, day, index + 1]))))
    assert.ok(result.every(r => r.status === 'rejected' && /CLIENT_UPGRADE_REQUIRED/.test(r.reason.message)), 'both legacy callers must upgrade instead of guessing a revision')
    assert.deepEqual((await db.query('SELECT due_date,updated_at FROM public.sales WHERE id=$1', [id])).rows[0], before)
    assert.equal(await count('audit_logs', 'entity_id', id), beforeAudits)
  })
  console.log(`Audit gate: ${passed} PASS, ${failed} FAIL. ${failures.join('; ')}`)
} finally { await db.close() }
process.exit(failed ? 1 : 0)
