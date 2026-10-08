import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Isolated native PostgreSQL diagnostics. Unsafe outcomes remain failed release gates.
// Test identities and data are synthetic; no hosted endpoint is used.
const db = await createDatabase({ engine: 'postgres' })
const users = { owner: randomUUID(), a: randomUUID(), b: randomUUID() }
let day, passed = 0, failed = 0
const failures = []
const call = (connection, actor, name, payload, id) => asUser(connection, users[actor], client =>
  rpc(client, name, id ? '$1::jsonb,$2::uuid' : '$1::jsonb', id ? [JSON.stringify(payload), id] : [JSON.stringify(payload)]))
const vehicle = (extra = {}) => ({ request_id: randomUUID(), vehicle_type: 'Xe tay ga', frame_number: `EXT-${randomUUID()}`, purchase_date: day, purchase_price: 100, ...extra })
const create = extra => call(db, 'owner', 'save_vehicle', vehicle(extra))
const sale = (id, extra = {}) => ({ request_id: randomUUID(), vehicle_id: id, customer_name: 'Synthetic customer', customer_phone: '', sale_price: 1000, initial_payment: 0, payment_method: 'CASH', sale_date: day, ...extra })
const reason = 'Synthetic audit only'
const check = async (name, run) => {
  try { await run(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; failures.push(name); console.log(`FAIL ${name}: ${error.message}`) }
}
const both = async operations => {
  const clients = await Promise.all(operations.map(() => db.connection()))
  try { return await Promise.allSettled(operations.map((operation, index) => operation(clients[index]))) }
  finally { await Promise.all(clients.map(client => client.close())) }
}
async function waitForLocks(count) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const row = (await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0]
    if (Number(row.n) >= count) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`did not observe ${count} genuinely blocked PostgreSQL sessions`)
}
async function behindLock(sql, values, operations) {
  const lock = await db.connection()
  let pending
  try {
    await lock.exec('BEGIN')
    await lock.query(sql, values)
    pending = both(operations)
    await waitForLocks(operations.length)
    await lock.exec('COMMIT')
    return await pending
  } finally {
    await lock.exec('ROLLBACK').catch(() => {})
    if (pending) await pending
    await lock.close()
  }
}
async function behindOrderedLock(sql, values, operations) {
  const lock = await db.connection()
  const clients = await Promise.all(operations.map(() => db.connection()))
  const pending = []
  try {
    await lock.exec('BEGIN')
    await lock.query(sql, values)
    for (let index = 0; index < operations.length; index++) {
      pending.push(operations[index](clients[index]).then(
        value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }),
      ))
      await waitForLocks(index + 1)
    }
    await lock.exec('COMMIT')
    return await Promise.all(pending)
  } finally {
    await lock.exec('ROLLBACK').catch(() => {})
    await Promise.all(pending)
    await lock.close()
    await Promise.all(clients.map(client => client.close()))
  }
}
const saleRows = id => db.query('SELECT status FROM public.sales WHERE vehicle_id=$1', [id])

try {
  day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
  for (const [name, id] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `extended-${name}-${randomUUID()}@example.test`, JSON.stringify({ full_name: `Synthetic ${name}` })])
    await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name === 'owner' ? 'OWNER' : 'STAFF', id])
  }
  await check('same normalized chassis cannot be duplicated by case variants', async () => {
    const frame = `EXTCASE-${randomUUID()}`
    const result = await behindLock('LOCK TABLE public.vehicles IN ACCESS EXCLUSIVE MODE', [], [
      c => call(c, 'owner', 'acquire_vehicle', { ...vehicle({ frame_number: frame.toUpperCase() }), acquisition_date: day }),
      c => call(c, 'owner', 'acquire_vehicle', { ...vehicle({ frame_number: frame.toLowerCase() }), acquisition_date: day }),
    ])
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1, 'case variants created two intake records for one chassis')
  })
  await check('two versioned reservation edits reject one stale form', async () => {
    const id = await create()
    const revision = (await db.query('SELECT updated_at::text AS revision FROM public.vehicles WHERE id=$1', [id])).rows[0].revision
    const result = await behindLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id], ['a', 'b'].map(actor =>
      c => call(c, actor, 'save_vehicle', { status: 'RESERVED', expected_updated_at: revision }, id)))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.ok(result.some(r => r.status === 'rejected' && /VEHICLE_EDIT_CONFLICT/.test(r.reason.message)))
  })
  await check('reservation racing sale preserves SOLD and exactly one completed sale', async () => {
    const id = await create()
    const result = await behindLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id], [
      c => call(c, 'a', 'save_vehicle', { status: 'RESERVED' }, id),
      c => call(c, 'b', 'sell_vehicle', sale(id)),
    ])
    assert.equal(result[1].status, 'fulfilled')
    assert.equal((await db.query('SELECT status FROM public.vehicles WHERE id=$1', [id])).rows[0].status, 'SOLD')
    assert.equal((await saleRows(id)).rows.filter(row => row.status === 'COMPLETED').length, 1)
  })
  await check('financial edit racing sale preserves authoritative cost snapshot', async () => {
    const id = await create()
    const result = await behindLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id], [
      c => call(c, 'owner', 'save_vehicle', { purchase_price: 150 }, id),
      c => call(c, 'a', 'sell_vehicle', sale(id)),
    ])
    assert.equal(result[1].status, 'fulfilled')
    const row = (await db.query('SELECT f.purchase_price,s.purchase_cost_snapshot FROM public.vehicle_financials f JOIN public.sales v ON v.vehicle_id=f.vehicle_id JOIN public.sale_financials s ON s.sale_id=v.id WHERE f.vehicle_id=$1', [id])).rows[0]
    assert.equal(row.purchase_price, row.purchase_cost_snapshot)
  })
  await check('independent overlapping debt payments preserve exact aggregate', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const receipts = []
    for (const actor of ['a', 'b']) receipts.push(await call(db, actor, 'prepare_payment_receipt', {
      sale_id: id, amount: 200, payment_method: 'CASH', payment_date: day, request_id: randomUUID(),
      evidence_kind: 'CASH_VOUCHER', evidence_scope: 'SYNTHETIC_EXT_CASH', evidence_reference: `VALID-SEPARATE-${randomUUID()}`,
    }))
    const result = await behindLock('SELECT v.id FROM public.vehicles v JOIN public.sales s ON s.vehicle_id=v.id WHERE s.id=$1 FOR UPDATE OF v', [id], receipts.map(receipt =>
      c => call(c, 'owner', 'add_payment', { receipt_id: receipt.id, request_id: randomUUID(), verification_reference: 'Synthetic separate vouchers verified' })))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 2)
    assert.equal(Number((await db.query("SELECT sum(amount) AS n FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [id])).rows[0].n), 400)
  })
  await check('overlapping sale cancellations commit once and keep void history', async () => {
    const vehicleId = await create()
    const id = await call(db, 'a', 'sell_vehicle', sale(vehicleId, { initial_payment: 100 }))
    const result = await behindLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [vehicleId], [0, 1].map(() =>
      c => asUser(c, users.owner, client => rpc(client, 'cancel_sale', '$1::uuid,$2::text', [id, reason]))))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal((await db.query('SELECT status FROM public.payments WHERE sale_id=$1', [id])).rows[0].status, 'VOIDED')
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action='CANCEL_SALE' AND entity_id=$1", [id])).rows[0].n), 1)
  })
  await check('delete racing sale cannot leave orphan sale or inconsistent inventory', async () => {
    const id = await create()
    const result = await behindLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id], [
      c => asUser(c, users.owner, client => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [id, reason])),
      c => call(c, 'a', 'sell_vehicle', sale(id)),
    ])
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    const row = (await db.query("SELECT count(*) AS n FROM public.sales s LEFT JOIN public.vehicles v ON v.id=s.vehicle_id WHERE s.vehicle_id=$1 AND (v.id IS NULL OR (s.status='COMPLETED' AND v.status<>'SOLD'))", [id])).rows[0]
    assert.equal(Number(row.n), 0)
  })
  await check('CSV import racing manual intake creates one actual chassis', async () => {
    const payload = vehicle()
    const result = await behindLock('LOCK TABLE public.vehicles IN ACCESS EXCLUSIVE MODE', [], [
      c => asUser(c, users.owner, client => rpc(client, 'import_vehicles', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), rows: [payload] })])),
      c => call(c, 'owner', 'acquire_vehicle', { ...payload, acquisition_date: day }),
    ])
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.vehicles WHERE upper(btrim(frame_number))=upper($1)', [payload.frame_number])).rows[0].n), 1)
  })
  await check('overlapping bulk imports produce no duplicate actual chassis', async () => {
    const shared = vehicle(), first = vehicle(), second = vehicle()
    const result = await behindLock('LOCK TABLE public.vehicles IN ACCESS EXCLUSIVE MODE', [], [[shared, first], [shared, second]].map(rows =>
      c => asUser(c, users.owner, client => rpc(client, 'import_vehicles', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), rows })]))))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.vehicles WHERE upper(btrim(frame_number))=ANY($1::text[])', [[shared.frame_number, first.frame_number, second.frame_number].map(frame => frame.toUpperCase())])).rows[0].n), 2)
  })
  await check('injected error after first bulk row rolls back rows and audits', async () => {
    const first = vehicle(), second = vehicle({ license_plate: 'EXT-ROLLBACK-SECOND' })
    await db.exec("CREATE FUNCTION private.extended_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.license_plate='EXT-ROLLBACK-SECOND' THEN RAISE EXCEPTION USING errcode='P0001',message='SYNTHETIC_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER extended_reject_insert BEFORE INSERT ON public.vehicles FOR EACH ROW EXECUTE FUNCTION private.extended_reject_insert();")
    const before = Number((await db.query('SELECT count(*) AS n FROM public.audit_logs')).rows[0].n)
    try {
      await assert.rejects(() => asUser(db, users.owner, c => rpc(c, 'import_vehicles', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), rows: [first, second] })])), /SYNTHETIC_FAILURE/)
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.vehicles WHERE upper(btrim(frame_number))=ANY($1::text[])', [[first.frame_number, second.frame_number].map(frame => frame.toUpperCase())])).rows[0].n), 0)
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.audit_logs')).rows[0].n), before)
    } finally { await db.exec('DROP TRIGGER extended_reject_insert ON public.vehicles; DROP FUNCTION private.extended_reject_insert();') }
  })
  await check('reversal racing resale preserves one completed sale and immutable snapshots', async () => {
    const vehicleId = await create()
    const old = await call(db, 'a', 'sell_vehicle', sale(vehicleId))
    await behindLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [vehicleId], [
      c => asUser(c, users.owner, client => rpc(client, 'cancel_sale', '$1::uuid,$2::text', [old, reason])),
      c => call(c, 'b', 'sell_vehicle', sale(vehicleId)),
    ])
    const rows = (await saleRows(vehicleId)).rows
    assert.ok(rows.filter(row => row.status === 'COMPLETED').length <= 1)
    assert.equal(rows.find(row => row.status === 'CANCELLED')?.status, 'CANCELLED')
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.sale_financials f JOIN public.sales s ON s.id=f.sale_id WHERE s.vehicle_id=$1', [vehicleId])).rows[0].n), rows.length)
  })
  await check('legacy unversioned stale expense edits still must reject financial overwrite', async () => {
    const data = { category: 'OTHER', description: 'Synthetic expense', amount: 100, expense_date: day }
    const id = await asUser(db, users.owner, c => rpc(c, 'save_expense', '$1::text,$2::jsonb', ['business', JSON.stringify(data)]))
    const before = (await db.query('SELECT amount,updated_at FROM public.business_expenses WHERE id=$1', [id])).rows[0]
    const beforeAudits = Number((await db.query('SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1', [id])).rows[0].n)
    const result = await both([120, 140].map(amount =>
      c => asUser(c, users.owner, client => rpc(client, 'save_expense', '$1::text,$2::jsonb,$3::uuid', ['business', JSON.stringify({ ...data, amount }), id]))))
    assert.ok(result.every(r => r.status === 'rejected' && /CLIENT_UPGRADE_REQUIRED/.test(r.reason.message)), 'unversioned clients must upgrade before editing financial records')
    assert.deepEqual((await db.query('SELECT amount,updated_at FROM public.business_expenses WHERE id=$1', [id])).rows[0], before)
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1', [id])).rows[0].n), beforeAudits)
  })
  await check('versioned overlapping expense edits reject one stale financial form', async () => {
    const data = { category: 'OTHER', description: 'Synthetic versioned expense', amount: 100, expense_date: day }
    const id = await asUser(db, users.owner, c => rpc(c, 'save_expense', '$1::text,$2::jsonb', ['business', JSON.stringify(data)]))
    const expected = (await db.query('SELECT updated_at::text AS revision FROM public.business_expenses WHERE id=$1', [id])).rows[0].revision
    const result = await behindLock('SELECT id FROM public.business_expenses WHERE id=$1 FOR UPDATE', [id], [120, 140].map(amount =>
      c => asUser(c, users.owner, client => rpc(client, 'save_expense', '$1::text,$2::jsonb,$3::uuid', ['business', JSON.stringify({ ...data, amount, expected_updated_at: expected }), id]))))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
    assert.ok(result.some(r => r.status === 'rejected' && /EXPENSE_EDIT_CONFLICT/.test(r.reason.message)))
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_EXPENSE'", [id])).rows[0].n), 1)
    assert.equal(Number((await db.query('SELECT amount FROM public.business_expenses WHERE id=$1', [id])).rows[0].amount), result[0].status === 'fulfilled' ? 120 : 140)
  })
  await check('manager revoked during expense lock wait cannot commit money edit', async () => {
    const data = { category: 'OTHER', description: 'Synthetic revoked expense', amount: 100, expense_date: day }
    const id = await asUser(db, users.owner, c => rpc(c, 'save_expense', '$1::text,$2::jsonb', ['business', JSON.stringify(data)]))
    const revision = (await db.query('SELECT updated_at::text AS revision FROM public.business_expenses WHERE id=$1', [id])).rows[0].revision
    await db.query("UPDATE public.profiles SET role='MANAGER',can_view_financials=true,active=true WHERE id=$1", [users.b])
    const lock = await db.connection(), waiting = await db.connection()
    let pending
    try {
      await lock.exec('BEGIN')
      await lock.query('SELECT id FROM public.business_expenses WHERE id=$1 FOR UPDATE', [id])
      pending = asUser(waiting, users.b, c => rpc(c, 'save_expense', '$1::text,$2::jsonb,$3::uuid', ['business', JSON.stringify({ ...data, amount: 200, expected_updated_at: revision }), id]))
        .then(value => ({ value }), error => ({ error }))
      await waitForLocks(1)
      await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.b])
      await lock.exec('COMMIT')
      const result = await pending
      assert.ok(result.error, 'manager disabled during wait still edited a financial record')
      assert.equal(Number((await db.query('SELECT amount FROM public.business_expenses WHERE id=$1', [id])).rows[0].amount), 100)
    } finally {
      await lock.exec('ROLLBACK').catch(() => {})
      if (pending) await pending
      await db.query("UPDATE public.profiles SET role='STAFF',can_view_financials=false,active=true WHERE id=$1", [users.b])
      await lock.close(); await waiting.close()
    }
  })
  await check('crashed PROCESSING communication job has a reclaim path', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const job = (await db.query("UPDATE public.message_outbox SET status='QUEUED',next_attempt_at=now() WHERE sale_id=$1 RETURNING id", [id])).rows[0]
    const first = await asUser(db, users.a, c => rpc(c, 'claim_message', '$1::uuid,$2::text', [job.id, 'MOCK']))
    await db.query("UPDATE public.message_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
    const recovered = await asUser(db, users.b, c => rpc(c, 'claim_message', '$1::uuid,$2::text', [job.id, 'MOCK']))
    assert.equal(recovered.id, job.id, 'aged PROCESSING job is stuck indefinitely after worker crash')
    assert.notEqual(recovered.lease_token, first.lease_token)
    await assert.rejects(() => asUser(db, users.a, c => rpc(c, 'finish_mock_message', '$1::uuid,$2::text,$3::uuid', [job.id, `mock_${job.id}`, first.lease_token])), /MESSAGE_LEASE_CONFLICT/)
    await asUser(db, users.b, c => rpc(c, 'finish_mock_message', '$1::uuid,$2::text,$3::uuid', [job.id, `mock_${job.id}`, recovered.lease_token]))
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='MESSAGE_SENT'", [job.id])).rows[0].n), 1)
  })
  await check('cancelled sale cannot deliver queued sale thank-you job', async () => {
    const id = await call(db, 'a', 'sell_vehicle', sale(await create()))
    const job = (await db.query("UPDATE public.message_outbox SET status='QUEUED',next_attempt_at=now() WHERE sale_id=$1 RETURNING id", [id])).rows[0]
    await asUser(db, users.owner, c => rpc(c, 'cancel_sale', '$1::uuid,$2::text', [id, reason]))
    const claimed = await asUser(db, users.a, c => rpc(c, 'claim_message', '$1::uuid,$2::text', [job.id, 'MOCK']))
    assert.ok(!claimed.id, 'job is still claimable after the sale is cancelled')
  })
  await check('outbox insert failure preserves sale and records diagnostic incident', async () => {
    await db.exec("CREATE FUNCTION private.extended_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING errcode='P0001',message='SYNTHETIC_OUTBOX_FAILURE'; END $$; CREATE TRIGGER extended_reject_outbox BEFORE INSERT ON public.message_outbox FOR EACH ROW EXECUTE FUNCTION private.extended_reject_outbox();")
    let id
    try { id = await call(db, 'a', 'sell_vehicle', sale(await create())) }
    finally { await db.exec('DROP TRIGGER extended_reject_outbox ON public.message_outbox; DROP FUNCTION private.extended_reject_outbox();') }
    assert.equal((await db.query('SELECT status FROM public.sales WHERE id=$1', [id])).rows[0].status, 'COMPLETED')
    assert.ok(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action IN ('MESSAGE_FAILED','AUTO_MESSAGE_QUEUE_FAILED') AND entity_id=$1", [id])).rows[0].n) > 0, 'secondary task failed with no incident trace')
  })
  await check('acquisition deletion/cancellation and vehicle deletion avoid lock inversion', async () => {
    const id = await call(db, 'owner', 'acquire_vehicle', { ...vehicle(), acquisition_date: day })
    const acquisition = (await db.query('SELECT id FROM public.acquisitions WHERE vehicle_id=$1', [id])).rows[0].id
    // Both real RPCs start with no pre-acquired business rows. A separate gate
    // controls timing; first request waits before the second starts. Old code's
    // acquisition-first path then creates the actual lock cycle on release.
    const result = await behindOrderedLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id], [
      c => asUser(c, users.owner, client => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [id, reason])),
      c => asUser(c, users.owner, client => rpc(client, 'cancel_acquisition', '$1::uuid,$2::text', [acquisition, reason])),
    ])
    assert.ok(!result.some(r => r.status === 'rejected' && r.reason.code === '40P01'), 'actual PostgreSQL deadlock from acquisition↔vehicle lock inversion')
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  })
  await check('acquisition delete racing vehicle delete follows one lock order', async () => {
    const id = await call(db, 'owner', 'acquire_vehicle', { ...vehicle(), acquisition_date: day })
    const acquisition = (await db.query('SELECT id FROM public.acquisitions WHERE vehicle_id=$1', [id])).rows[0].id
    const result = await behindOrderedLock('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id], [
      c => asUser(c, users.owner, client => rpc(client, 'delete_vehicle', '$1::uuid,$2::text', [id, reason])),
      c => asUser(c, users.owner, client => rpc(client, 'delete_acquisition', '$1::uuid,$2::text', [acquisition, reason])),
    ])
    assert.ok(!result.some(r => r.status === 'rejected' && r.reason.code === '40P01'))
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  })
  for (const operation of ['cancel_acquisition', 'delete_acquisition', 'delete_vehicle']) {
    await check(`revoked manager cannot ${operation} after vehicle lock wait`, async () => {
      const id = await call(db, 'owner', 'acquire_vehicle', { ...vehicle(), acquisition_date: day })
      const acquisition = (await db.query('SELECT id FROM public.acquisitions WHERE vehicle_id=$1', [id])).rows[0].id
      await db.query("UPDATE public.profiles SET role='MANAGER',active=true WHERE id=$1", [users.b])
      const lock = await db.connection(), waiting = await db.connection()
      let pending
      try {
        await lock.exec('BEGIN')
        await lock.query('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [id])
        pending = asUser(waiting, users.b, c => rpc(c, operation, '$1::uuid,$2::text', [operation === 'delete_vehicle' ? id : acquisition, reason]))
          .then(value => ({ value }), error => ({ error }))
        await waitForLocks(1)
        await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.b])
        await lock.exec('COMMIT')
        const result = await pending
        assert.equal(result.error?.code, '42501', 'revoked manager still committed cancellation/deletion')
        assert.equal((await db.query('SELECT status FROM public.vehicles WHERE id=$1', [id])).rows[0]?.status, 'IN_STOCK')
        assert.equal((await db.query('SELECT status FROM public.acquisitions WHERE id=$1', [acquisition])).rows[0]?.status, 'COMPLETED')
      } finally {
        await lock.exec('ROLLBACK').catch(() => {})
        if (pending) await pending
        await db.query("UPDATE public.profiles SET role='STAFF',active=true WHERE id=$1", [users.b])
        await lock.close(); await waiting.close()
      }
    })
  }
  console.log(`Extended audit gate: ${passed} PASS, ${failed} FAIL. ${failures.join('; ')}`)
} finally { await db.close() }
process.exit(failed ? 1 : 0)
