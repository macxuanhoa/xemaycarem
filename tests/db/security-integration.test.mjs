import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Real disposable PostgreSQL, independent sessions, synthetic money and identities.
// These checks protect the provenance contract rather than relaxing older gates.
export async function runSecurityIntegrationTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'finance', 'manager', 'staff'].map(name => [name, randomUUID()]))
  const call = (name, fn, data) => asUser(db, users[name], c => rpc(c, fn, '$1::jsonb', [JSON.stringify(data)]))
  const read = (name, fn, id) => asUser(db, users[name], c => rpc(c, fn, '$1::uuid', [id]))
  const ingest = (data, client = db) => asUser(client, null, c => rpc(c, 'ingest_bank_transaction', '$1::jsonb', [JSON.stringify(data)]), 'service_role')
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  let passed = 0
  const check = async (name, action) => { await action(); console.log(`PASS security-integration ${++passed}. ${name}`) }
  try {
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@example.test`])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,can_view_financials=$2 WHERE id=$3', [name === 'finance' ? 'MANAGER' : name.toUpperCase(), name === 'finance', id])
    }
    const day = (await row('SELECT private.today()::text AS day')).day
    const vehicle = (name, cost = 77_770_000) => call(name, 'save_vehicle', { request_id: randomUUID(), vehicle_type: 'Synthetic security', frame_number: randomUUID(), purchase_date: day, purchase_price: cost })
    const sale = (name, vehicleId, price = 88_880_000) => call(name, 'sell_vehicle', { request_id: randomUUID(), vehicle_id: vehicleId, customer_name: 'Synthetic security', sale_date: day, sale_price: price, initial_payment: 0 })
    const privateVehicle = await vehicle('owner')
    const publicVehicle = await vehicle('staff', 22_220_000)

    await check('OWNER prices stay masked and STAFF prices stay public across roles and direct RLS', async () => {
      for (const name of ['staff', 'manager', 'finance', 'owner']) {
        const hidden = await read(name, 'get_vehicle', privateVehicle)
        assert.equal(hidden.purchase_price, ['owner', 'finance'].includes(name) ? 77_770_000 : null)
        assert.equal((await read(name, 'get_vehicle', publicVehicle)).purchase_price, 22_220_000)
        if (['staff', 'manager'].includes(name)) {
          assert.equal(Object.hasOwn(hidden, 'total_cost'), false)
          assert.equal((await asUser(db, users[name], c => c.query('SELECT * FROM public.vehicle_financials'))).rows.length, 0)
        }
      }
      await asUser(db, users.staff, c => rpc(c, 'save_vehicle', '$1::jsonb,$2::uuid', ['{"color":"Synthetic metadata edit"}', privateVehicle]))
      assert.equal((await read('staff', 'get_vehicle', privateVehicle)).purchase_price, null)
    })

    await check('hidden-cost sale attempts give the same owner gate above and below cost', async () => {
      for (const price of [1, 77_770_000, 99_990_000]) {
        await assert.rejects(() => sale('staff', privateVehicle, price), /SALE_OWNER_CONFIRMATION_REQUIRED/)
      }
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.sales WHERE vehicle_id=$1', [privateVehicle])).n), 0)
    })

    await check('a proposal notification cannot disclose shortfall or reconstruct hidden OWNER cost', async () => {
      await call('staff', 'request_sale_below_cost', { request_id: randomUUID(), vehicle_id: privateVehicle, customer_name: 'Synthetic proposal', sale_date: day, sale_price: 40_000_000, initial_payment: 0 })
      for (const name of ['staff', 'manager']) {
        const notifications = await call(name, 'list_notifications', {})
        const notice = notifications.items.find(n => n.action === 'REQUEST_SALE_BELOW_COST' && n.vehicle_id === privateVehicle)
        assert.ok(notice)
        assert.doesNotMatch(notice.body, /37\.770\.000|77\.770\.000|thiếu/)
      }
      const ownerNotices = await call('owner', 'list_notifications', {})
      assert.match(ownerNotices.items.find(n => n.action === 'REQUEST_SALE_BELOW_COST').body, /37\.770\.000/)
    })

    await check('public-cost proposal still shows its known shortfall to its submitting actor', async () => {
      await call('staff', 'request_sale_below_cost', { request_id: randomUUID(), vehicle_id: publicVehicle, customer_name: 'Synthetic proposal', sale_date: day, sale_price: 20_000_000, initial_payment: 0 })
      const notifications = await call('staff', 'list_notifications', {})
      assert.match(notifications.items.find(n => n.vehicle_id === publicVehicle && n.action === 'REQUEST_SALE_BELOW_COST').body, /2\.220\.000/)
    })

    const privateSale = await sale('owner', await vehicle('owner', 11_110_000))
    await call('owner', 'prepare_payment_receipt', { request_id: randomUUID(), sale_id: privateSale, amount: 33_330_000, payment_method: 'CASH', payment_date: day })
    await check('OWNER-private sale masks the receipt registry and every payment-derived projection', async () => {
      for (const name of ['staff', 'manager', 'finance', 'owner']) {
        const ledger = await read(name, 'list_payment_receipts', privateSale)
        assert.equal(ledger.length, ['finance', 'owner'].includes(name) ? 1 : 0)
        const projected = await read(name, 'get_sale', privateSale)
        if (['staff', 'manager'].includes(name)) {
          assert.equal(projected.sale_price, null)
          for (const key of ['remaining_amount', 'paid_amount', 'gross_profit', 'debt_status']) assert.equal(Object.hasOwn(projected, key), false)
          assert.deepEqual(projected.payments, [])
        }
      }
    })

    await call('owner', 'save_settings', { bank_bin: '970422', bank_name: 'Synthetic', bank_account_no: '0987654321', bank_account_name: 'SYNTHETIC ONLY', vietqr_enabled: true, bank_provider: 'SEPAY', bank_webhook_enabled: false })
    const event = (extra = {}) => ({ provider: 'SEPAY', provider_txn_id: randomUUID(), amount: 100, direction: 'in', account_number: '0987654321', transfer_content: 'Synthetic bank', transfer_at: new Date().toISOString(), ...extra })
    await check('bank ingest fails closed for disabled, wrong provider/account, outgoing and invalid IDs', async () => {
      await assert.rejects(() => ingest(event()), /BANK_WEBHOOK_NOT_CONFIGURED/)
      await call('owner', 'save_settings', { bank_webhook_enabled: true })
      await assert.rejects(() => ingest(event({ provider: 'CASSO' })), /BANK_PROVIDER_MISMATCH/)
      for (const account of ['', '0000000000']) await assert.rejects(() => ingest(event({ account_number: account })), /BANK_ACCOUNT_MISMATCH/)
      for (const direction of ['out', '', undefined]) await assert.rejects(() => ingest(event({ direction })), /INVALID_INPUT/)
      await assert.rejects(() => ingest(event({ provider_txn_id: 'X'.repeat(81) })), /INVALID_INPUT/)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.bank_transactions')).n), 0)
    })

    await check('service authorization uses the real database role and rejects spoofed claim settings', async () => {
      await assert.rejects(() => asUser(db, users.owner, async c => {
        await c.query("SELECT set_config('request.jwt.claim.role','service_role',false)")
        return rpc(c, 'ingest_bank_transaction', '$1::jsonb', [JSON.stringify(event())])
      }), /permission denied|ACCESS_DENIED/)
      assert.ok((await ingest(event())).id)
      await assert.rejects(() => asUser(db, null, async c => {
        await c.query("SELECT set_config('request.jwt.claim.role','authenticated',false)")
        return rpc(c, 'ingest_bank_transaction', '$1::jsonb', [JSON.stringify(event())])
      }, 'service_role'), /ACCESS_DENIED/)
    })

    await check('concurrent webhook delivery returns one transaction and emits one audit event', async () => {
      const clients = await Promise.all([db.connection(), db.connection()])
      const data = event()
      try {
        const results = await Promise.all(clients.map(c => ingest(data, c)))
        assert.equal(results[0].id, results[1].id)
        assert.equal(results.filter(r => r.duplicate).length, 1)
        assert.equal(Number((await row('SELECT count(*) AS n FROM public.bank_transactions WHERE provider_txn_id=$1', [data.provider_txn_id])).n), 1)
        assert.equal(Number((await row('SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1', [results[0].id])).n), 1)
      } finally { await Promise.all(clients.map(c => c.close())) }
    })

    const qr = await call('owner', 'create_vietqr_payment_request', { sale_id: privateSale, amount: 100, qr_payload: 'Synthetic' })
    const wrong = await ingest(event({ amount: 99, transfer_content: qr.qr_reference }))
    await check('amount mismatch stays in manual review and cannot record the larger QR amount', async () => {
      assert.equal(wrong.status, 'MANUAL_REVIEW')
      const before = Number((await row('SELECT count(*) AS n FROM public.payments WHERE sale_id=$1', [privateSale])).n)
      await assert.rejects(() => call('owner', 'confirm_bank_transaction', { id: wrong.id, request_id: randomUUID() }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.payments WHERE sale_id=$1', [privateSale])).n), before)
      assert.equal((await row('SELECT status FROM public.bank_transactions WHERE id=$1', [wrong.id])).status, 'MANUAL_REVIEW')
      const unmatched = await ingest(event({ amount: 98 }))
      await assert.rejects(() => call('owner', 'link_bank_transaction', { id: unmatched.id, qr_request_id: qr.id }), /BANK_TRANSACTION_AMOUNT_MISMATCH/)
      assert.equal((await row('SELECT qr_request_id FROM public.bank_transactions WHERE id=$1', [unmatched.id])).qr_request_id, null)
    })

    await check('one QR cannot credit two independent bank transactions even when both amounts match', async () => {
      const first = await ingest(event({ transfer_content: qr.qr_reference }))
      const second = await ingest(event({ transfer_content: qr.qr_reference }))
      assert.equal(first.status, 'RECORDED')
      assert.equal(second.status, 'MANUAL_REVIEW')
      const recorded = await call('owner', 'confirm_bank_transaction', { id: first.id, request_id: randomUUID() })
      assert.equal(Number((await row('SELECT amount FROM public.payments WHERE id=$1', [recorded.payment_id])).amount), 100)
      // Một mã QR đã được ghi thu thì không ghi thêm lần hai. 20261015000200 tách
      // mã lỗi theo nguyên nhân nên yêu cầu thứ hai nhận VIETQR_REQUEST_NOT_PENDING
      // (mã QR không còn PENDING) thay vì VIETQR_BANK_EVIDENCE_REQUIRED; ba dòng
      // dưới mới là bất biến: vẫn bị từ chối, vẫn MANUAL_REVIEW, vẫn đúng MỘT khoản thu.
      await assert.rejects(() => call('owner', 'confirm_bank_transaction', { id: second.id, request_id: randomUUID() }), /VIETQR_REQUEST_NOT_PENDING|VIETQR_BANK_EVIDENCE_REQUIRED/)
      assert.equal((await row('SELECT status FROM public.bank_transactions WHERE id=$1', [second.id])).status, 'MANUAL_REVIEW')
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.payments WHERE sale_id=$1 AND amount=100', [privateSale])).n), 1)
      assert.equal((await call('owner', 'confirm_bank_transaction', { id: first.id })).payment_id, recorded.payment_id)
    })

    await check('financial access revoked while confirmation waits is rechecked after the database lock', async () => {
      await db.query("UPDATE public.vietqr_requests SET replace_available_at=clock_timestamp()-interval '1 second' WHERE id=$1", [qr.id])
      const nextQr = await call('owner', 'create_vietqr_payment_request', { sale_id: privateSale, amount: 101, qr_payload: 'Synthetic revoke' })
      // A real credit with the wrong amount remains in review. Confirmation must
      // recheck access after waiting even when it will later reject the evidence.
      const transaction = await ingest(event({ amount: 100, transfer_content: nextQr.qr_reference }))
      assert.equal(transaction.status, 'MANUAL_REVIEW')
      const lock = await db.connection(), worker = await db.connection()
      let pending
      try {
        await lock.exec('BEGIN')
        await lock.query('SELECT id FROM public.vehicles WHERE id=$1 FOR UPDATE', [nextQr.vehicle_id])
        pending = asUser(worker, users.finance, c => rpc(c, 'confirm_bank_transaction', '$1::jsonb', [JSON.stringify({ id: transaction.id, request_id: randomUUID() })])).then(value => ({ value }), error => ({ error }))
        let waiting = false
        for (let attempt = 0; attempt < 100; attempt++) {
          if (Number((await row("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).n) > 0) { waiting = true; break }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(waiting, true, 'confirmation must wait on a real PostgreSQL lock')
        await db.query('UPDATE public.profiles SET can_view_financials=false WHERE id=$1', [users.finance])
        await lock.exec('COMMIT')
        const outcome = await pending
        assert.match(outcome.error?.message ?? '', /ACCESS_DENIED/)
        assert.equal((await row('SELECT status FROM public.bank_transactions WHERE id=$1', [transaction.id])).status, 'MANUAL_REVIEW')
        assert.equal(Number((await row("SELECT count(*) AS n FROM public.payments WHERE sale_id=$1 AND amount=101", [privateSale])).n), 0)
      } finally {
        await lock.exec('ROLLBACK').catch(() => {})
        if (pending) await pending
        await lock.close(); await worker.close()
        await db.query('UPDATE public.profiles SET can_view_financials=true WHERE id=$1', [users.finance])
      }
    })

    await check('mixed approval paging excludes duplicate reviews before count and limit', async () => {
      // Synthetic queue rows isolate ordering/paging; all business mutations above use real RPCs.
      for (let index = 0; index < 4; index++) {
        const subject = await vehicle('staff', 100)
        await db.query('INSERT INTO public.approval_requests(kind,subject_id,requested_by,reason) VALUES($1,$2,$3,$4)', [index < 2 ? 'VEHICLE_DUPLICATE_REVIEW' : 'VEHICLE_DELETION', subject, users.staff, 'Synthetic paging'])
      }
      const all = await call('owner', 'list_pending_approvals', { limit: 1 })
      const first = await call('owner', 'list_pending_approvals', { limit: 1, exclude_kind: 'VEHICLE_DUPLICATE_REVIEW' })
      const next = await call('owner', 'list_pending_approvals', { limit: 1, offset: 1, exclude_kind: 'VEHICLE_DUPLICATE_REVIEW' })
      assert.equal(first.total, all.total - 2)
      assert.ok(first.items.every(r => r.kind !== 'VEHICLE_DUPLICATE_REVIEW'))
      assert.ok(next.items.every(r => r.kind !== 'VEHICLE_DUPLICATE_REVIEW'))
      assert.notEqual(first.items[0].id, next.items[0].id)
    })
    return passed
  } finally { if (!externalDb) await db.close() }
}
