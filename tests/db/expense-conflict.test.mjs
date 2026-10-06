import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Actual locks and accounting on disposable PostgreSQL, never hosted data.
export async function runExpenseConflictTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = { owner: randomUUID(), manager: randomUUID(), staff: randomUUID() }
  const save = (connection, actor, kind, data, id) => asUser(connection, users[actor], c => rpc(c, 'save_expense', '$1::text,$2::jsonb,$3::uuid', [kind, JSON.stringify(data), id ?? null]))
  const table = kind => kind === 'vehicle' ? 'vehicle_expenses' : 'business_expenses'
  const record = async (kind, id) => (await db.query(`SELECT to_jsonb(e) AS data FROM public.${table(kind)} e WHERE id=$1`, [id])).rows[0].data
  const audits = async id => Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_EXPENSE'", [id])).rows[0].n)
  let passed = 0
  const check = async (name, operation) => { await operation(); passed++; console.log(`PASS expense-conflict ${passed}. ${name}`) }
  try {
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `expense-${id}@example.test`, JSON.stringify({ full_name: `Synthetic ${name}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name.toUpperCase(), id])
    }
    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const vehicleId = await asUser(db, users.owner, c => rpc(c, 'save_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), brand: 'Honda', model: 'Synthetic expense conflict', purchase_date: day, purchase_price: 100, asking_price: 1000 })]))
    for (const kind of ['vehicle', 'business']) {
      const data = { description: `Synthetic ${kind} expense`, amount: 100, expense_date: day, ...(kind === 'vehicle' ? { vehicle_id: vehicleId, expense_type: 'OTHER' } : { category: 'OTHER' }) }
      const id = await save(db, 'owner', kind, data)
      await check(`${kind}: creation works, legacy edit is rejected and a current revision succeeds`, async () => {
        assert.equal((await record(kind, id)).amount, 100)
        await assert.rejects(() => save(db, 'owner', kind, { ...data, amount: 110 }, id), /CLIENT_UPGRADE_REQUIRED/)
        assert.equal((await record(kind, id)).amount, 100)
        assert.equal(await audits(id), 0)
        const current = await record(kind, id)
        assert.equal(await save(db, 'owner', kind, { ...data, amount: 110, expected_updated_at: current.updated_at }, id), id)
        assert.equal((await record(kind, id)).amount, 110)
      })
      if (db.connection) {
        await check(`${kind}: two versioned financial edits produce one save and one conflict`, async () => {
          const baseline = await record(kind, id)
          const clients = await Promise.all([db.connection(), db.connection()])
          let result
          try {
            result = await Promise.allSettled([save(clients[0], 'owner', kind, { ...data, amount: 120, expected_updated_at: baseline.updated_at }, id), save(clients[1], 'manager', kind, { ...data, amount: 140, expected_updated_at: baseline.updated_at }, id)])
          } finally { await Promise.all(clients.map(c => c.close())) }
          assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
          assert.match(result.find(r => r.status === 'rejected').reason.message, /EXPENSE_EDIT_CONFLICT/)
          const current = await record(kind, id)
          assert.equal(current.amount, result[0].status === 'fulfilled' ? 120 : 140)
          assert.notEqual(current.updated_at, baseline.updated_at)
          assert.equal(await audits(id), 2)
        })
      } else console.log(`NOT VERIFIED ${kind} expense real concurrency: PGlite has one connection`)
      await check(`${kind}: stale or null revisions cannot change money or append audit`, async () => {
        const old = await record(kind, id)
        await save(db, 'owner', kind, { ...data, amount: 160, expected_updated_at: old.updated_at }, id)
        const before = await audits(id)
        await assert.rejects(() => save(db, 'manager', kind, { ...data, amount: 200, expected_updated_at: old.updated_at }, id), /EXPENSE_EDIT_CONFLICT/)
        await assert.rejects(() => save(db, 'manager', kind, { ...data, amount: 200, expected_updated_at: null }, id), /CLIENT_UPGRADE_REQUIRED/)
        assert.equal((await record(kind, id)).amount, 160)
        assert.equal(await audits(id), before)
      })
      if (db.connection) {
        await check(`${kind}: role revocation during a real lock wait rejects a versioned edit`, async () => {
          const baseline = await record(kind, id)
          const clients = await Promise.all([db.connection(), db.connection()])
          let pending
          try {
            await clients[0].exec('BEGIN')
            await clients[0].query(`SELECT id FROM public.${table(kind)} WHERE id=$1 FOR UPDATE`, [id])
            pending = save(clients[1], 'manager', kind, { ...data, amount: 300, expected_updated_at: baseline.updated_at }, id).then(value => ({ value }), error => ({ error }))
            const deadline = Date.now() + 5000
            let waiting = false
            while (Date.now() < deadline) {
              waiting = Boolean((await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%save_expense%') AS waiting")).rows[0].waiting)
              if (waiting) break
              await new Promise(resolve => setTimeout(resolve, 20))
            }
            assert.ok(waiting, 'expense RPC must really wait for its row lock')
            await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.manager])
            await clients[0].exec('COMMIT')
            assert.match((await pending).error?.message ?? '', /ACCESS_DENIED/)
            assert.equal((await record(kind, id)).amount, baseline.amount)
          } finally {
            await clients[0].exec('ROLLBACK')
            if (pending) await pending
            await Promise.all(clients.map(c => c.close()))
            await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.manager])
          }
        })
      }
      await check(`${kind}: staff writes and cancelled expense edits remain denied`, async () => {
        const current = await record(kind, id)
        await assert.rejects(() => save(db, 'staff', kind, { ...data, expected_updated_at: current.updated_at }, id), /ACCESS_DENIED/)
        await asUser(db, users.owner, c => rpc(c, 'cancel_expense', '$1::text,$2::uuid,$3::text', [kind, id, 'Synthetic regression cancellation']))
        await assert.rejects(() => save(db, 'owner', kind, { ...data, expected_updated_at: current.updated_at }, id), /EXPENSE_CANCELLED/)
        assert.equal((await record(kind, id)).status, 'CANCELLED')
      })
    }
    const saleId = await asUser(db, users.owner, c => rpc(c, 'sell_vehicle', '$1::jsonb', [JSON.stringify({ vehicle_id: vehicleId, customer_name: 'Synthetic cost snapshot', sale_price: 1000, initial_payment: 0, sale_date: day })]))
    const snapshotBefore = (await db.query('SELECT * FROM public.sale_financials WHERE sale_id=$1', [saleId])).rows[0]
    await check('sold vehicle expense lock and immutable sale snapshots remain intact', async () => {
      await assert.rejects(() => save(db, 'owner', 'vehicle', { vehicle_id: vehicleId, expense_type: 'OTHER', description: 'Forbidden after sale', amount: 200, expense_date: day }), /VEHICLE_EXPENSE_LOCKED/)
      assert.deepEqual((await db.query('SELECT * FROM public.sale_financials WHERE sale_id=$1', [saleId])).rows[0], snapshotBefore)
      assert.equal(Number(snapshotBefore.expense_cost_snapshot), 0)
    })
    console.log(`Expense conflict checks passed: ${passed}`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/expense-conflict.test.mjs')) {
  let failed = false
  try { await runExpenseConflictTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' }) }
  catch (error) { console.error(error.message); failed = true }
  process.exit(failed ? 1 : 0)
}
