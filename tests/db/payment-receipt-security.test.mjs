import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Native transactions and synthetic evidence only: this cannot prove money was
// physically received, or that a manager's manually supplied evidence is true.
export async function runPaymentReceiptSecurityTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = { owner: randomUUID(), manager: randomUUID(), staff: randomUUID(), other: randomUUID() }
  const call = (c, actor, name, data) => asUser(c, users[actor], client => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  const proposal = (sale, day, extra = {}) => ({ request_id: randomUUID(), sale_id: sale, amount: 100, payment_date: day, payment_method: 'BANK_TRANSFER', evidence_kind: 'BANK_TRANSACTION', evidence_scope: 'SYNTHETIC ACCOUNT', evidence_reference: `SYNTHETIC-${randomUUID()}`, ...extra })
  const approve = (c, actor, receipt, extra = {}) => call(c, actor, 'add_payment', { request_id: randomUUID(), receipt_id: receipt.id, verification_reference: 'Synthetic manual test evidence checked against ledger', ...extra })
  const parallel = async operations => {
    assert.ok(db.connection, 'real independent PostgreSQL connections required')
    const clients = await Promise.all(operations.map(() => db.connection()))
    try { return await Promise.allSettled(operations.map((op, i) => op(clients[i]))) }
    finally { await Promise.all(clients.map(c => c.close())) }
  }
  const waitFor = async sql => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if ((await row(sql)).waiting) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('the financial operation did not enter the expected real lock wait')
  }
  const current = id => row('SELECT to_jsonb(r) AS data FROM public.payment_receipts r WHERE id=$1', [id]).then(r => r.data)
  const ledger = sale => db.query('SELECT id,amount,status FROM public.payments WHERE sale_id=$1 ORDER BY id', [sale]).then(result => result.rows)
  const verifyAudits = id => row("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action IN ('CREATE_PAYMENT','VERIFY_PAYMENT_RECEIPT')", [id]).then(r => Number(r.n))
  let passed = 0
  const check = async (name, operation) => { await operation(); console.log(`PASS payment-security ${++passed}. ${name}`) }
  try {
    for (const [actor, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${id}@example.test`, JSON.stringify({ full_name: `Synthetic security ${actor}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [actor === 'owner' ? 'OWNER' : actor === 'manager' ? 'MANAGER' : 'STAFF', id])
    }
    const day = (await row('SELECT private.today()::text AS day')).day
    const createSale = async (price = 1000) => {
      const vehicle = await call(db, 'owner', 'acquire_vehicle', { request_id: randomUUID(), vehicle_type: 'Xe tay ga', frame_number: '', purchase_price: 100, acquisition_date: day })
      const sale = await call(db, 'owner', 'sell_vehicle', { request_id: randomUUID(), vehicle_id: vehicle, customer_name: 'Synthetic security customer', sale_date: day, sale_price: price, initial_payment: 0 })
      return { vehicle, sale }
    }
    await check('same operation key or same bank evidence cannot be reassigned across sales', async () => {
      const a = await createSale(), b = await createSale()
      const data = proposal(a.sale, day)
      const original = await call(db, 'staff', 'prepare_payment_receipt', data)
      const before = await current(original.id)
      await assert.rejects(() => call(db, 'other', 'prepare_payment_receipt', { ...data, sale_id: b.sale }), /PAYMENT_RECEIPT_CONFLICT/)
      await assert.rejects(() => call(db, 'other', 'prepare_payment_receipt', { ...data, request_id: randomUUID(), sale_id: b.sale }), /PAYMENT_RECEIPT_CONFLICT/)
      await assert.rejects(() => approve(db, 'owner', original, { sale_id: b.sale }), /PAYMENT_RECEIPT_CONFLICT/)
      assert.deepEqual(await current(original.id), before)
      assert.deepEqual(await ledger(a.sale), [])
      assert.deepEqual(await ledger(b.sale), [])
      assert.equal(await verifyAudits(original.id), 0)
    })
    await check('two concurrent approvals exceeding balance leave the losing proposal entirely pending', async () => {
      const { sale } = await createSale()
      const receipts = []
      for (let i = 0; i < 2; i++) receipts.push(await call(db, 'staff', 'prepare_payment_receipt', proposal(sale, day, { amount: 700 })))
      const snapshots = (await db.query('SELECT * FROM public.sale_financials WHERE sale_id=$1', [sale])).rows
      const result = await parallel([c => approve(c, 'owner', receipts[0]), c => approve(c, 'manager', receipts[1])])
      assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
      assert.match(result.find(r => r.status === 'rejected').reason.message, /PAYMENT_EXCEEDS_BALANCE/)
      const winner = result[0].status === 'fulfilled' ? 0 : 1
      const loser = await current(receipts[1 - winner].id)
      assert.equal(loser.status, 'PENDING')
      assert.equal(loser.payment_id, null)
      assert.equal(loser.verified_by, null)
      assert.equal(loser.verified_at, null)
      assert.equal(loser.verification_reference, null)
      assert.equal(await verifyAudits(loser.id), 0)
      assert.equal((await ledger(sale)).length, 1)
      assert.equal(Number((await ledger(sale))[0].amount), 700)
      const summary = await asUser(db, users.owner, c => rpc(c, 'get_sale', '$1::uuid', [sale]))
      assert.equal(Number(summary.paid_amount), 700)
      assert.equal(Number(summary.remaining_amount), 300)
      assert.deepEqual((await db.query('SELECT * FROM public.sale_financials WHERE sale_id=$1', [sale])).rows, snapshots)
    })
    await check('manager disabled during a proven vehicle lock wait cannot approve or append financial audits', async () => {
      const { sale, vehicle } = await createSale()
      const receipt = await call(db, 'staff', 'prepare_payment_receipt', proposal(sale, day))
      const before = await current(receipt.id)
      const clients = await Promise.all([db.connection(), db.connection()])
      let pending
      try {
        await clients[0].exec('BEGIN')
        await clients[0].query('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [vehicle])
        pending = approve(clients[1], 'manager', receipt).then(value => ({ value }), error => ({ error }))
        await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%add_payment%') AS waiting")
        await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.manager])
        await clients[0].exec('COMMIT')
        assert.match((await pending).error?.message ?? '', /ACCESS_DENIED/)
        assert.deepEqual(await current(receipt.id), before)
        assert.deepEqual(await ledger(sale), [])
        assert.equal(await verifyAudits(receipt.id), 0)
      } finally {
        await clients[0].exec('ROLLBACK')
        if (pending) await pending
        await Promise.all(clients.map(c => c.close()))
        await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.manager])
      }
    })
    await check('legitimate different bank transaction references with equal amount/date record separately', async () => {
      const { sale } = await createSale()
      const a = await call(db, 'staff', 'prepare_payment_receipt', proposal(sale, day))
      const b = await call(db, 'other', 'prepare_payment_receipt', proposal(sale, day))
      const results = await parallel([c => approve(c, 'owner', a), c => approve(c, 'manager', b)])
      assert.ok(results.every(r => r.status === 'fulfilled'))
      assert.notEqual(results[0].value, results[1].value)
      const rows = await ledger(sale)
      assert.equal(rows.length, 2)
      assert.equal(rows.reduce((sum, p) => sum + Number(p.amount), 0), 200)
      assert.equal(await verifyAudits(a.id), 2)
      assert.equal(await verifyAudits(b.id), 2)
    })
    await check('trim/case canonical bank references deduplicate across actors before approval', async () => {
      const { sale } = await createSale()
      const data = proposal(sale, day)
      const results = await parallel([
        c => call(c, 'staff', 'prepare_payment_receipt', data),
        c => call(c, 'other', 'prepare_payment_receipt', { ...data, request_id: randomUUID(), evidence_scope: ` ${data.evidence_scope.toLowerCase()} `, evidence_reference: ` ${data.evidence_reference.toLowerCase()} ` }),
      ])
      assert.ok(results.every(r => r.status === 'fulfilled'))
      assert.equal(results[0].value.id, results[1].value.id)
      assert.equal(results[0].value.evidence_scope, data.evidence_scope)
      assert.equal(results[0].value.evidence_reference, data.evidence_reference.toUpperCase())
      const approvals = await parallel([c => approve(c, 'owner', results[0].value), c => approve(c, 'manager', results[1].value)])
      assert.ok(approvals.every(r => r.status === 'fulfilled' && r.value === results[0].value.id))
      assert.equal((await ledger(sale)).length, 1)
      assert.equal(await verifyAudits(results[0].value.id), 2)
    })
    await check('lost canonical-alias response can be recovered by the actor without another proposal', async () => {
      const { sale } = await createSale()
      const data = proposal(sale, day)
      const first = await call(db, 'staff', 'prepare_payment_receipt', data)
      const alias = { ...data, request_id: randomUUID(), notes: 'Synthetic second actor proposal' }
      // Commit the second request but discard its response, as after timeout/reload.
      await call(db, 'other', 'prepare_payment_receipt', alias)
      const lookup = actor => asUser(db, users[actor], c => rpc(c, 'get_payment_receipt_request', '$1::uuid', [alias.request_id]))
      const recovered = await lookup('other')
      assert.equal(recovered.confirmed, true)
      assert.equal(recovered.receipt.id, first.id)
      assert.equal(recovered.receipt.sale_id, sale)
      assert.deepEqual(await lookup('staff'), { confirmed: false, receipt: null })
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.payment_receipts WHERE sale_id=$1', [sale])).n), 1)
      assert.deepEqual(await ledger(sale), [])
      assert.equal((await call(db, 'other', 'prepare_payment_receipt', alias)).id, first.id)
      await assert.rejects(() => call(db, 'other', 'prepare_payment_receipt', { ...alias, notes: 'Changed hidden metadata' }), /PAYMENT_RECEIPT_CONFLICT/)
      await assert.rejects(() => call(db, 'other', 'prepare_payment_receipt', { ...alias, amount: 101 }), /PAYMENT_RECEIPT_CONFLICT/)
      await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.other])
      try { await assert.rejects(() => lookup('other'), /ACCESS_DENIED/) }
      finally { await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.other]) }
    })
    await check('original no-evidence request still replays after a manager binds shared evidence', async () => {
      const { sale } = await createSale()
      const data = proposal(sale, day, { evidence_kind: null, evidence_scope: '', evidence_reference: '' })
      const receipt = await call(db, 'staff', 'prepare_payment_receipt', data)
      const proof = { evidence_kind: 'MANUAL_RECONCILIATION', evidence_scope: 'SYNTHETIC REVIEW REGISTER', evidence_reference: `REVIEW-${randomUUID()}` }
      assert.equal(await approve(db, 'manager', receipt, proof), receipt.id)
      const ledgerBefore = await ledger(sale)
      const auditsBefore = await verifyAudits(receipt.id)
      const replay = await call(db, 'staff', 'prepare_payment_receipt', data)
      assert.equal(replay.id, receipt.id)
      assert.equal(replay.status, 'RECORDED')
      assert.equal(replay.evidence_kind, proof.evidence_kind)
      assert.deepEqual(await ledger(sale), ledgerBefore)
      assert.equal(await verifyAudits(receipt.id), auditsBefore)
    })
    await check('concurrent manual identity binding converts index collision to a controlled conflict without partial money', async () => {
      const a = await createSale(), b = await createSale()
      const noEvidence = { evidence_kind: null, evidence_scope: '', evidence_reference: '' }
      const first = await call(db, 'staff', 'prepare_payment_receipt', proposal(a.sale, day, noEvidence))
      const second = await call(db, 'other', 'prepare_payment_receipt', proposal(b.sale, day, noEvidence))
      const evidence = { evidence_kind: 'MANUAL_RECONCILIATION', evidence_scope: 'SYNTHETIC SHARED REGISTER', evidence_reference: `MANUAL-${randomUUID()}` }
      const clients = await Promise.all([db.connection(), db.connection()])
      let retry
      try {
        await clients[0].exec('BEGIN')
        assert.equal(await approve(clients[0], 'owner', first, evidence), first.id)
        retry = approve(clients[1], 'manager', second, evidence).then(value => ({ value }), error => ({ error }))
        await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%add_payment%') AS waiting")
        await clients[0].exec('COMMIT')
        assert.match((await retry).error?.message ?? '', /PAYMENT_RECEIPT_CONFLICT/)
        assert.equal((await ledger(a.sale)).length, 1)
        assert.deepEqual(await ledger(b.sale), [])
        const rejectedWrite = await current(second.id)
        assert.equal(rejectedWrite.status, 'PENDING')
        assert.equal(rejectedWrite.evidence_kind, null)
        assert.equal(rejectedWrite.payment_id, null)
        assert.equal(await verifyAudits(second.id), 0)
      } finally {
        await clients[0].exec('ROLLBACK')
        if (retry) await retry
        await Promise.all(clients.map(c => c.close()))
      }
    })
    await check('manager-rejected clerical proposal can be corrected using the same evidence without rewriting history', async () => {
      const { sale } = await createSale()
      const data = proposal(sale, day, { amount: 110 })
      const original = await call(db, 'staff', 'prepare_payment_receipt', data)
      await asUser(db, users.manager, c => rpc(c, 'reject_payment_receipt', '$1::uuid,$2::text', [original.id, 'Synthetic documented correction: amount was transcribed incorrectly']))
      const history = await current(original.id)
      assert.equal(history.status, 'REJECTED')
      const correction = await call(db, 'staff', 'prepare_payment_receipt', { ...data, request_id: randomUUID(), amount: 100 })
      assert.notEqual(correction.id, original.id)
      assert.equal(await approve(db, 'owner', correction), correction.id)
      assert.deepEqual(await current(original.id), history)
      assert.equal((await ledger(sale)).length, 1)
      assert.equal(Number((await ledger(sale))[0].amount), 100)
      assert.equal((await call(db, 'staff', 'prepare_payment_receipt', data)).status, 'REJECTED')
      await assert.rejects(() => approve(db, 'owner', original), /PAYMENT_RECEIPT_REJECTED/)
      assert.equal(await verifyAudits(original.id), 0)
    })
    for (const approvalFirst of [false, true]) {
      await check(`real ordered cancellation race (${approvalFirst ? 'approval' : 'cancel'} first) cannot retain ACTIVE payment on cancelled sale`, async () => {
        const { sale, vehicle } = await createSale()
        const receipt = await call(db, 'staff', 'prepare_payment_receipt', proposal(sale, day))
        const clients = await Promise.all([db.connection(), db.connection(), db.connection()])
        let approval, cancellation
        const startApproval = () => approve(clients[1], 'manager', receipt).then(value => ({ value }), error => ({ error }))
        const startCancel = () => asUser(clients[2], users.owner, c => rpc(c, 'cancel_sale', '$1::uuid,$2::text', [sale, 'Synthetic race cancellation evidence'])).then(value => ({ value }), error => ({ error }))
        try {
          await clients[0].exec('BEGIN')
          await clients[0].query('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [vehicle])
          if (approvalFirst) {
            approval = startApproval()
            await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%add_payment%') AS waiting")
            cancellation = startCancel()
            await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%cancel_sale%') AS waiting")
          } else {
            cancellation = startCancel()
            await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%cancel_sale%') AS waiting")
            approval = startApproval()
            await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%add_payment%') AS waiting")
          }
          await clients[0].exec('COMMIT')
          const [a, c] = await Promise.all([approval, cancellation])
          assert.equal(c.error, undefined)
          const saleRow = await row('SELECT status FROM public.sales WHERE id=$1', [sale])
          assert.equal(saleRow.status, 'CANCELLED')
          const payments = await ledger(sale)
          assert.equal(payments.filter(p => p.status === 'ACTIVE').length, 0)
          assert.ok(payments.length <= 1)
          if (approvalFirst) {
            assert.equal(a.error, undefined)
            assert.equal(payments.length, 1)
            assert.equal(payments[0].status, 'VOIDED')
            assert.equal((await current(receipt.id)).status, 'RECORDED')
          } else {
            assert.match(a.error?.message ?? '', /SALE_CANCELLED/)
            assert.equal(payments.length, 0)
            assert.equal((await current(receipt.id)).status, 'PENDING')
            assert.equal(await verifyAudits(receipt.id), 0)
          }
        } finally {
          await clients[0].exec('ROLLBACK')
          if (approval) await approval
          if (cancellation) await cancellation
          await Promise.all(clients.map(c => c.close()))
        }
      })
    }
    await check('private financial implementations and registry writes have no authenticated or anonymous bypass', async () => {
      await assert.rejects(() => asUser(db, users.owner, c => c.query('SELECT private.add_payment_verified_impl($1::jsonb)', ['{}'])), /permission denied/)
      await assert.rejects(() => asUser(db, users.owner, c => c.query("UPDATE public.payment_receipts SET status='RECORDED'")), /permission denied/)
      await assert.rejects(() => asUser(db, users.staff, c => c.query('SELECT * FROM public.payment_receipts')), /permission denied/)
      await assert.rejects(() => asUser(db, users.staff, c => c.query('SELECT * FROM private.payment_receipt_requests')), /permission denied/)
      await assert.rejects(() => asUser(db, null, c => rpc(c, 'list_payment_receipts', '$1::uuid', [randomUUID()]), 'anon'), /permission denied/)
      const granted = await row("SELECT has_function_privilege('authenticated','private.add_payment_verified_impl(jsonb)','EXECUTE') AS authenticated,has_function_privilege('anon','private.add_payment_verified_impl(jsonb)','EXECUTE') AS anonymous")
      assert.deepEqual(granted, { authenticated: false, anonymous: false })
    })
    console.log(`Payment receipt security checks passed: ${passed}`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/payment-receipt-security.test.mjs')) {
  let failed = false
  try { await runPaymentReceiptSecurityTests() }
  catch (error) { failed = true; console.error(error.stack) }
  process.exit(failed ? 1 : 0)
}
