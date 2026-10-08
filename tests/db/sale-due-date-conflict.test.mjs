import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Disposable PostgreSQL only. No cloud credentials or production mutations.
export async function runSaleDueDateConflictTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = { owner: randomUUID(), a: randomUUID(), b: randomUUID() }
  const read = (actor, name, args = '', values = []) => asUser(db, users[actor], c => rpc(c, name, args, values))
  const call = (actor, name, data) => read(actor, name, '$1::jsonb', [JSON.stringify(data)])
  const guarded = (connection, actor, id, date, revision) => asUser(connection, users[actor], c =>
    rpc(c, 'update_sale_due_date', '$1::uuid,$2::date,$3::timestamptz', [id, date, revision]))
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  const auditCount = async id => Number((await row("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_SALE_DUE_DATE'", [id])).n)
  let passed = 0
  const check = async (name, operation) => { await operation(); passed++; console.log(`PASS due-date ${passed}. ${name}`) }
  try {
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `due-${name}-${id}@example.test`, JSON.stringify({ full_name: `Due-date test ${name}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name === 'owner' ? 'OWNER' : 'STAFF', id])
    }
    const { day, next, later } = await row('SELECT private.today()::text AS day,(private.today()+3)::text AS next,(private.today()+7)::text AS later')
    const vehicleId = await call('owner', 'save_vehicle', { request_id: randomUUID(), vehicle_type: 'Xe tay ga', frame_number: `DUE-${randomUUID()}`, purchase_date: day, purchase_price: 80 })
    const saleId = await call('a', 'sell_vehicle', { vehicle_id: vehicleId, customer_name: 'Due-date synthetic customer', sale_price: 100, sale_date: day, initial_payment: 20 })
    const financialBefore = await row('SELECT * FROM public.sale_financials WHERE sale_id=$1', [saleId])
    const paymentBefore = (await db.query('SELECT * FROM public.payments WHERE sale_id=$1', [saleId])).rows

    await check('legacy two-argument writes fail closed; the current revision still allows editing', async () => {
      const current = await read('a', 'get_sale', '$1::uuid', [saleId])
      await assert.rejects(() => read('a', 'update_sale_due_date', '$1::uuid,$2::date', [saleId, day]), /CLIENT_UPGRADE_REQUIRED/)
      assert.equal((await read('a', 'get_sale', '$1::uuid', [saleId])).due_date, current.due_date)
      assert.equal(await auditCount(saleId), 0)
      const changed = await guarded(db, 'a', saleId, day, current.updated_at)
      assert.equal(changed.due_date, day)
      assert.equal(await auditCount(saleId), 1)
    })
    await check('the guarded overload requires an actual sale revision', async () => {
      await assert.rejects(() => guarded(db, 'a', saleId, next, null), /SALE_DUE_DATE_CONFLICT/)
      assert.equal(await auditCount(saleId), 1)
    })
    if (db.connection) {
      await check('two employees editing the same revision yield one save and one conflict', async () => {
        const original = await read('a', 'get_sale', '$1::uuid', [saleId])
        const clients = await Promise.all([db.connection(), db.connection()])
        let result
        try {
          result = await Promise.allSettled([guarded(clients[0], 'a', saleId, next, original.updated_at), guarded(clients[1], 'b', saleId, later, original.updated_at)])
        } finally { await Promise.all(clients.map(c => c.close())) }
        assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
        const rejected = result.find(r => r.status === 'rejected')
        assert.match(rejected.reason.message, /SALE_DUE_DATE_CONFLICT/)
        const current = await read('a', 'get_sale', '$1::uuid', [saleId])
        assert.equal(current.due_date, result.find(r => r.status === 'fulfilled').value.due_date)
        assert.notEqual(current.updated_at, original.updated_at)
        assert.equal(await auditCount(saleId), 2)
      })
    } else {
      console.log('NOT VERIFIED due-date real concurrency: PGlite provides one connection')
    }
    await check('stale removal cannot erase the newly saved date or create an audit', async () => {
      const stale = await read('a', 'get_sale', '$1::uuid', [saleId])
      await guarded(db, 'b', saleId, later, stale.updated_at)
      const before = await auditCount(saleId)
      await assert.rejects(() => guarded(db, 'a', saleId, null, stale.updated_at), /SALE_DUE_DATE_CONFLICT/)
      assert.equal((await read('a', 'get_sale', '$1::uuid', [saleId])).due_date, later)
      assert.equal(await auditCount(saleId), before)
    })
    await check('fresh explicit removal succeeds without changing money or cost snapshots', async () => {
      const current = await read('a', 'get_sale', '$1::uuid', [saleId])
      const changed = await guarded(db, 'a', saleId, null, current.updated_at)
      assert.equal(changed.due_date, null)
      assert.equal(changed.paid_amount, 20)
      assert.equal(changed.remaining_amount, 80)
      assert.deepEqual(await row('SELECT * FROM public.sale_financials WHERE sale_id=$1', [saleId]), financialBefore)
      assert.deepEqual((await db.query('SELECT * FROM public.payments WHERE sale_id=$1', [saleId])).rows, paymentBefore)
    })
    await check('same-transaction saves advance the revision and reject stale reuse', async () => {
      await asUser(db, users.a, async c => {
        await c.exec('BEGIN')
        try {
          const current = await rpc(c, 'get_sale', '$1::uuid', [saleId])
          const first = await rpc(c, 'update_sale_due_date', '$1::uuid,$2::date,$3::timestamptz', [saleId, next, current.updated_at])
          assert.notEqual(first.updated_at, current.updated_at)
          await c.exec('SAVEPOINT rejected_save')
          await assert.rejects(async () => {
            try { await rpc(c, 'update_sale_due_date', '$1::uuid,$2::date,$3::timestamptz', [saleId, later, current.updated_at]) }
            finally { await c.exec('ROLLBACK TO SAVEPOINT rejected_save') }
          }, /SALE_DUE_DATE_CONFLICT/)
          assert.equal((await rpc(c, 'get_sale', '$1::uuid', [saleId])).due_date, next)
          await c.exec('COMMIT')
        } catch (error) { await c.exec('ROLLBACK'); throw error }
      })
    })
    if (db.connection) {
      await check('an employee disabled while waiting for the sale lock cannot edit the due date', async () => {
        const current = await read('a', 'get_sale', '$1::uuid', [saleId])
        const clients = await Promise.all([db.connection(), db.connection()])
        try {
          await clients[0].exec('BEGIN')
          await clients[0].query('SELECT id FROM public.sales WHERE id=$1 FOR UPDATE', [saleId])
          const pending = guarded(clients[1], 'b', saleId, later, current.updated_at)
            .then(value => ({ value }), error => ({ error }))
          const deadline = Date.now() + 5000
          let waiting = false
          while (Date.now() < deadline) {
            waiting = Boolean((await row("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%update_sale_due_date%') AS waiting")).waiting)
            if (waiting) break
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          assert.ok(waiting, 'the due-date RPC must really wait on the row lock')
          await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.b])
          await clients[0].exec('COMMIT')
          const result = await pending
          assert.match(result.error?.message ?? '', /ACCESS_DENIED/)
          assert.equal((await read('a', 'get_sale', '$1::uuid', [saleId])).due_date, current.due_date)
        } finally {
          await clients[0].exec('ROLLBACK')
          await Promise.all(clients.map(c => c.close()))
          await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.b])
        }
      })
    }
    await check('anonymous/inactive/cancelled and invalid-date requests remain rejected', async () => {
      const current = await read('a', 'get_sale', '$1::uuid', [saleId])
      await assert.rejects(() => asUser(db, null, c => rpc(c, 'update_sale_due_date', '$1::uuid,$2::date,$3::timestamptz', [saleId, day, current.updated_at]), 'anon'), /permission denied/)
      await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.b])
      await assert.rejects(() => guarded(db, 'b', saleId, later, current.updated_at), /ACCESS_DENIED/)
      await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.b])
      await assert.rejects(() => guarded(db, 'a', saleId, '2000-01-01', current.updated_at), /INVALID_DUE_DATE/)
      await read('owner', 'cancel_sale', '$1::uuid,$2::text', [saleId, 'Synthetic cancellation regression'])
      await assert.rejects(() => guarded(db, 'a', saleId, later, current.updated_at), /SALE_NOT_ACTIVE/)
    })
    console.log(`Sale due-date conflict checks passed: ${passed}`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/sale-due-date-conflict.test.mjs')) {
  let failed = false
  try { await runSaleDueDateConflictTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' }) }
  catch (error) { console.error(error.message); failed = true }
  // The disposable engine shuts down before publishing the final exit status.
  process.exit(failed ? 1 : 0)
}
