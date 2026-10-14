/**
 * Database Smart Sales Automation Test Suite (V1 + V2)
 * Covers customer automation and the verified bank-transfer lifecycle:
 *  1. ingest_bank_transaction is service_role-only: authenticated/anon are denied.
 *  2. Anti-double-credit: same (provider, provider_txn_id) is idempotent (one row).
 *  3. Bare 5-digit content (no CAREM GD prefix) never links a VietQR by mistake.
 *  4. A trusted exact bank credit records its sale receipt/payment atomically.
 *  5. Amount mismatch -> neutral MANUAL_REVIEW (never leaks the correct amount).
 *  6. auto_match disabled -> MANUAL_REVIEW with AUTO_MATCH_DISABLED.
 *  7. Legacy acknowledgement cannot record money without matching bank evidence.
 *  8. Financial gating: STAFF denied list/confirm/link/ignore/matching-status.
 *  9. get_vietqr_matching_status returns state only, never an amount.
 * 10. link_bank_transaction accepts a human reference (CAREM GDxxxxx).
 * 11. ignore_bank_transaction requires a reason.
 * 12. get_bank_webhook_state is OWNER-only and leaks no secret.
 * 13. Bank reconciliation notices never reach a non-financial, non-participant STAFF.
 *
 * (Số 13-15 cũ về customer_contacts/message_templates/thank-you queue đã bị gỡ
 *  cùng subsystem chăm sóc khách hàng — migration 20261014000500.)
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runSmartSalesAutomationTests(externalDb, { engine = 'pglite' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Smart Sales Automation Test Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'manager', 'financialManager', 'staff', 'svc'].map((r) => [r, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const callUuid = (user, name, id) => run(user, (client) => rpc(client, name, '$1::uuid', [id]))
    const callNoArg = (user, name) => run(user, (client) => rpc(client, name, '', []))
    // service_role webhook has no end-user JWT sub (auth.uid() => NULL), matching production.
    const callSvc = (data, name = 'ingest_bank_transaction') => asUser(db, null, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify({ account_number: '0000000000', direction: 'in', transfer_at: new Date().toISOString(), ...data })]), 'service_role')
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)
    const svcTxn = (extra) => callSvc({ provider: 'SEPAY', provider_txn_id: `SEPAY-${randomUUID().slice(0, 8)}`, ...extra })

    const day = (await row('SELECT private.today()::text AS day')).day

    for (const name of ['owner', 'manager', 'financialManager', 'staff']) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [users[name], `ssa-${name}@example.test`, JSON.stringify({ full_name: name })])
      const role = name === 'financialManager' ? 'MANAGER' : name.toUpperCase()
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,can_view_financials=$2 WHERE id=$3', [
        role,
        name === 'owner' || name === 'financialManager',
        users[name]
      ])
    }

    // Bank + VietQR baseline with auto-match on.
    await call('owner', 'save_settings', {
      bank_bin: '970422',
      bank_name: 'MBBank',
      bank_account_no: '0000000000',
      bank_account_name: 'SYNTHETIC QR RECEIVER',
      vietqr_enabled: true,
      bank_provider: 'SEPAY',
      bank_webhook_enabled: true,
      bank_auto_match_enabled: true
    })

    // 1. ingest is service_role-only.
    await deny(() => call('staff', 'ingest_bank_transaction', { provider: 'SEPAY', provider_txn_id: 'x1', amount: 1000000, transfer_content: 'abc' }))
    await deny(() => call('owner', 'ingest_bank_transaction', { provider: 'SEPAY', provider_txn_id: 'x2', amount: 1000000, transfer_content: 'abc' }))
    await deny(() => asUser(db, null, (client) => rpc(client, 'ingest_bank_transaction', '$1::jsonb', [JSON.stringify({ provider: 'SEPAY', provider_txn_id: 'x3', amount: 1000000 })]), 'anon'))
    pass('ingest_bank_transaction is denied to authenticated and anonymous roles (service_role only)')

    // Two sales with debt so each scenario can hang a distinct PENDING VietQR.
    const mkSale = async (plate, phone) => {
      const v = await call('owner', 'save_vehicle', { request_id: randomUUID(), vehicle_type: 'Xe tay ga', license_plate: plate, frame_number: `F${randomUUID().slice(0, 8)}`, purchase_date: day, purchase_price: 30_000_000 })
      const s = await call('owner', 'sell_vehicle', { vehicle_id: v, customer_name: 'Khách Tự Động', customer_phone: phone, sale_price: 100_000_000, initial_payment: 10_000_000, payment_method: 'CASH', sale_date: day, request_id: randomUUID() })
      return { vehicleId: v, saleId: s }
    }
    const saleA = await mkSale('92B1-50001', '0905550001')
    const saleB = await mkSale('92B1-50002', '0905550002')
    const saleC = await mkSale('92B1-50003', '0905550003')

    const qrA = await call('owner', 'create_vietqr_payment_request', { sale_id: saleA.saleId, amount: 30_000_000, qr_payload: 'ssa-a' })
    const qrB = await call('owner', 'create_vietqr_payment_request', { sale_id: saleB.saleId, amount: 30_000_000, qr_payload: 'ssa-b' })
    const qrC = await call('owner', 'create_vietqr_payment_request', { sale_id: saleC.saleId, amount: 20_000_000, qr_payload: 'ssa-c' })
    assert.ok(qrA.qr_reference.startsWith('CAREM GD'))

    await assert.rejects(() => call('owner', 'confirm_vietqr_payment', {
      qr_request_id: qrA.id, notes: 'Synthetic manual confirmation without evidence',
    }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    assert.equal(await count('SELECT count(*) FROM public.bank_transactions'), 0)
    assert.equal(await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleA.saleId]), 1)
    pass('OWNER cannot turn a manual claim into a verified bank payment')

    // 4 + 2. Trusted arrival records the receipt/payment, then delivery is idempotent.
    const txnA = `SEPAY-${randomUUID().slice(0, 8)}`
    const first = await callSvc({ provider: 'SEPAY', provider_txn_id: txnA, amount: 30_000_000, sender_name: 'KH TU DONG', transfer_content: `Chuyen khoan ${qrA.qr_reference}` })
    assert.equal(first.status, 'RECORDED')
    const matched = await row('SELECT status, match_reason, qr_request_id, sale_id, vehicle_id,payment_id FROM public.bank_transactions WHERE id=$1', [first.id])
    assert.equal(matched.status, 'RECORDED')
    assert.equal(matched.match_reason, 'REFERENCE_AMOUNT_MATCH')
    assert.equal(matched.qr_request_id, qrA.id)
    assert.equal(matched.sale_id, saleA.saleId)
    assert.equal(matched.vehicle_id, saleA.vehicleId)
    assert.ok(matched.payment_id)
    assert.equal((await row('SELECT amount,payment_method FROM public.payments WHERE id=$1', [matched.payment_id])).payment_method, 'BANK_TRANSFER')
    assert.equal(await count('SELECT sum(amount) AS count FROM public.payments WHERE sale_id=$1', [saleA.saleId]), 40_000_000)
    const dup = await callSvc({ provider: 'SEPAY', provider_txn_id: txnA, amount: 30_000_000, transfer_content: `Chuyen khoan ${qrA.qr_reference}` })
    assert.equal(dup.duplicate, true)
    assert.equal(dup.id, first.id)
    assert.equal(await count('SELECT count(*) FROM public.bank_transactions WHERE provider=$1 AND provider_txn_id=$2', ['SEPAY', txnA]), 1)
    assert.equal(await count('SELECT count(*) FROM public.payment_receipts WHERE payment_id=$1', [matched.payment_id]), 1)
    pass('Trusted exact bank credit records its sale payment/receipt once; webhook replay is idempotent')

    // 9. get_vietqr_matching_status -> state only, no amount; finance-gated.
    const status = await callUuid('owner', 'get_vietqr_matching_status', qrA.id)
    assert.equal(status.state, 'RECORDED')
    assert.equal(status.bank_received, true)
    assert.equal(status.qr_status, 'CONFIRMED')
    assert.equal(Object.hasOwn(status, 'amount'), false)
    assert.ok(typeof status.sender_name === 'string')
    await deny(() => callUuid('staff', 'get_vietqr_matching_status', qrA.id))
    pass('get_vietqr_matching_status exposes state (no amount) and is finance-gated')

    // 7. Legacy confirm only acknowledges a payment the bank event already recorded.
    const confirmReq = randomUUID()
    const recorded = await call('owner', 'confirm_bank_transaction', { id: first.id, request_id: confirmReq, notes: 'du 30tr' })
    assert.equal(recorded.status, 'RECORDED')
    assert.ok(recorded.payment_id)
    assert.equal(recorded.payment_id, matched.payment_id)
    const payCount = await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleA.saleId])
    const reconfirmed = await call('owner', 'confirm_bank_transaction', { id: first.id, request_id: confirmReq })
    assert.equal(reconfirmed.payment_id, recorded.payment_id)
    assert.equal(reconfirmed.status, 'RECORDED')
    assert.equal(await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleA.saleId]), payCount)
    assert.equal(payCount, 2)
    const secondCredit = await svcTxn({ amount: 30_000_000, transfer_content: qrA.qr_reference })
    assert.equal(secondCredit.status, 'MANUAL_REVIEW')
    await assert.rejects(() => call('owner', 'confirm_bank_transaction', { id: secondCredit.id }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    assert.equal(await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleA.saleId]), 2)
    pass('Repeated acknowledgement or a second independent transfer cannot double-credit the same QR')

    // 3. Bare 5-digit content never links by mistake.
    const bare = await svcTxn({ amount: 30_000_000, transfer_content: 'chuyen tien GD01001 noi dung thuong' })
    assert.equal(bare.status, 'UNMATCHED')
    const bareRow = await row('SELECT match_reason, qr_request_id FROM public.bank_transactions WHERE id=$1', [bare.id])
    assert.equal(bareRow.qr_request_id, null)
    assert.equal(bareRow.match_reason, 'NO_REFERENCE')
    pass('A bare 5-digit code without the CAREM GD prefix never links a VietQR request')

    const extendedReference = await svcTxn({ amount: 30_000_000, transfer_content: `${qrB.qr_reference}1` })
    assert.equal(extendedReference.status, 'UNMATCHED')
    assert.equal((await row('SELECT qr_request_id FROM public.bank_transactions WHERE id=$1', [extendedReference.id])).qr_request_id, null)
    const ambiguous = await svcTxn({ amount: 30_000_000, transfer_content: `${qrB.qr_reference} ${qrC.qr_reference}` })
    assert.equal(ambiguous.status, 'MANUAL_REVIEW')
    assert.equal((await row('SELECT match_reason,qr_request_id FROM public.bank_transactions WHERE id=$1', [ambiguous.id])).match_reason, 'AMBIGUOUS_REFERENCE')
    assert.equal((await row('SELECT qr_request_id FROM public.bank_transactions WHERE id=$1', [ambiguous.id])).qr_request_id, null)
    pass('Extra reference digits and ambiguous memos cannot match a different payment request')

    // 5. Amount mismatch (QR B still PENDING) -> neutral MANUAL_REVIEW.
    const wrong = await svcTxn({ amount: 29_000_000, transfer_content: `Thanh toan ${qrB.qr_reference}` })
    assert.equal(wrong.status, 'MANUAL_REVIEW')
    assert.equal((await row('SELECT match_reason FROM public.bank_transactions WHERE id=$1', [wrong.id])).match_reason, 'AMOUNT_MISMATCH')
    await assert.rejects(() => call('owner', 'confirm_bank_transaction', { id: wrong.id }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    const mismatchStatus = await callUuid('owner', 'get_vietqr_matching_status', qrB.id)
    assert.equal(mismatchStatus.bank_received, false)
    assert.equal(mismatchStatus.state, 'REVIEW')
    pass('Right reference, wrong amount lands in neutral MANUAL_REVIEW (AMOUNT_MISMATCH)')

    // 11. ignore requires a reason.
    await assert.rejects(() => call('owner', 'ignore_bank_transaction', { id: wrong.id, reason: '' }), /REASON_REQUIRED/i)
    assert.equal((await call('owner', 'ignore_bank_transaction', { id: wrong.id, reason: 'Khach chuyen thieu, da hoan' })).status, 'IGNORED')
    pass('ignore_bank_transaction requires a reason and marks the transaction IGNORED')

    // 6. auto_match disabled -> MANUAL_REVIEW with AUTO_MATCH_DISABLED (qrB still PENDING).
    await call('owner', 'save_settings', { bank_auto_match_enabled: false })
    const disabled = await svcTxn({ amount: 30_000_000, transfer_content: `${qrB.qr_reference} sao ke tat` })
    assert.equal(disabled.status, 'MANUAL_REVIEW')
    assert.equal((await row('SELECT match_reason FROM public.bank_transactions WHERE id=$1', [disabled.id])).match_reason, 'AUTO_MATCH_DISABLED')
    await call('owner', 'save_settings', { bank_auto_match_enabled: true })
    pass('auto_match disabled routes an otherwise-perfect reference to MANUAL_REVIEW')

    // 10. link_bank_transaction binds a fresh UNMATCHED txn to a clean PENDING QR by reference.
    const orphan = await callSvc({ provider: 'SEPAY', provider_txn_id: `SEPAY-${randomUUID().slice(0, 8)}`, amount: 20_000_000, transfer_content: 'khong co ma tham chieu' })
    assert.equal(orphan.status, 'UNMATCHED')
    const linked = await call('financialManager', 'link_bank_transaction', { id: orphan.id, reference: qrC.qr_reference })
    assert.equal(linked.status, 'MANUAL_REVIEW')
    assert.equal(linked.qr_request_id, qrC.id)
    await assert.rejects(() => call('financialManager', 'confirm_bank_transaction', { id: orphan.id }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    assert.equal(await count('SELECT count(*) FROM public.payments WHERE sale_id=$1', [saleC.saleId]), 1)
    pass('link_bank_transaction binds an unmatched transaction by human CAREM GD reference')

    // 8. STAFF cannot read/act on the reconciliation queue.
    await deny(() => call('staff', 'list_bank_transactions', {}))
    await deny(() => call('staff', 'confirm_bank_transaction', { id: orphan.id }))
    await deny(() => call('staff', 'link_bank_transaction', { id: orphan.id, reference: qrA.qr_reference }))
    await deny(() => call('staff', 'ignore_bank_transaction', { id: disabled.id, reason: 'test' }))
    pass('STAFF without finance rights is denied list/confirm/link/ignore on bank transactions')

    const list = await call('financialManager', 'list_bank_transactions', { limit: 50 })
    assert.ok(Array.isArray(list.items))
    assert.ok(list.total >= 5)
    assert.ok(typeof list.pending_count === 'number')
    pass('Financial roles can list bank transactions with total/pending_count')

    // 12. get_bank_webhook_state is OWNER-only, leaks no secret.
    const hookState = await callNoArg('owner', 'get_bank_webhook_state')
    assert.equal(hookState.provider, 'SEPAY')
    assert.equal(hookState.account_configured, true)
    assert.equal(Object.hasOwn(hookState, 'webhook_secret'), false)
    await deny(() => callNoArg('manager', 'get_bank_webhook_state'))
    pass('get_bank_webhook_state is OWNER-only and returns no secret material')

    // 13. A non-participant STAFF never receives bank reconciliation notices.
    const staffBankNotices = await count("SELECT count(*) FROM public.notifications WHERE user_id=$1 AND action LIKE 'BANK_TRANSACTION%'", [users.staff])
    assert.equal(staffBankNotices, 0)
    pass('Bank reconciliation notices do not reach a non-financial, non-participant STAFF')

    console.log(`\nSmart Sales Automation suite: ${passed} groups passed`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('smart-sales-automation.test.mjs')) {
  await runSmartSalesAutomationTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
