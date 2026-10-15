/**
 * Database Smart Sales Automation Test Suite (V1 + V2)
 * Covers migrations 20261012000100 / 20261012000200 / 20261012000300:
 *  1. ingest_bank_transaction is service_role-only: authenticated/anon are denied.
 *  2. Anti-double-credit: same (provider, provider_txn_id) is idempotent (one row).
 *  3. Bare 5-digit content (no CAREM GD prefix) never links a VietQR by mistake.
 *  4. Exact match on an OWNER-created code: money records itself onto the sale
 *     (RECORDED / AUTO_RECORDED) and the VietQR flips to CONFIRMED.
 *  5. Amount mismatch -> neutral MANUAL_REVIEW (never leaks the correct amount).
 *  6. auto_match disabled -> MANUAL_REVIEW with AUTO_MATCH_DISABLED.
 *  7. Exact match on a non-OWNER-created code waits on the sale as a pending
 *     receipt (MATCHED_PENDING / PENDING_OWNER_APPROVAL); confirm_bank_transaction
 *     records it once and closes that receipt.
 *  8. Financial gating: STAFF denied list/confirm/link/ignore/matching-status.
 *  9. get_vietqr_matching_status returns state only, never an amount.
 * 10. link_bank_transaction accepts a human reference (CAREM GDxxxxx).
 * 11. ignore_bank_transaction requires a reason.
 * 12. get_bank_webhook_state is OWNER-only and leaks no secret.
 * 13. customer_contacts carry no price fields; verify is OWNER/MANAGER-only.
 * 14. message_templates reject price placeholders; save is OWNER-only.
 * 15. Personal thank-you enqueues on VERIFY_SALE_CONTACT (contacts cannot pre-exist the sale).
 * 16. Money-arrival notices never reach a non-financial, non-participant STAFF.
 * 17. Approving the receipt on the sale closes the whole loop: payment booked,
 *     bank transaction RECORDED, VietQR CONFIRMED, queue empty (no separate screen).
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
    const callSvc = (data, name = 'ingest_bank_transaction') => asUser(db, null, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify({ account_number: '0987654321', direction: 'in', ...data })]), 'service_role')
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
      bank_account_no: '0987654321',
      bank_account_name: 'CAREM SHOWROOM',
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

    // 4 + 2. Exact money on an OWNER-created code records itself onto the sale,
    // and re-delivery of the same bank transaction stays a single row.
    const txnA = `SEPAY-${randomUUID().slice(0, 8)}`
    const first = await callSvc({ provider: 'SEPAY', provider_txn_id: txnA, amount: 30_000_000, sender_name: 'KH TU DONG', transfer_content: `Chuyen khoan ${qrA.qr_reference}` })
    assert.equal(first.status, 'RECORDED')
    const matched = await row('SELECT status, match_reason, qr_request_id, sale_id, vehicle_id, payment_id, confirmed_by FROM public.bank_transactions WHERE id=$1', [first.id])
    assert.equal(matched.status, 'RECORDED')
    assert.equal(matched.match_reason, 'AUTO_RECORDED')
    assert.equal(matched.qr_request_id, qrA.id)
    assert.equal(matched.sale_id, saleA.saleId)
    assert.equal(matched.vehicle_id, saleA.vehicleId)
    assert.ok(matched.payment_id, 'Auto-recorded money must carry a real payment')
    assert.equal(matched.confirmed_by, users.owner)
    const qrRow = await row('SELECT status, payment_id FROM public.vietqr_requests WHERE id=$1', [qrA.id])
    assert.equal(qrRow.status, 'CONFIRMED')
    assert.equal(qrRow.payment_id, matched.payment_id)
    assert.equal(await count('SELECT count(*) FROM public.payments WHERE id=$1', [matched.payment_id]), 1)
    assert.equal(await count("SELECT count(*) FROM public.payment_receipts WHERE sale_id=$1 AND status='PENDING'", [saleA.saleId]), 0)
    const dup = await callSvc({ provider: 'SEPAY', provider_txn_id: txnA, amount: 30_000_000, transfer_content: `Chuyen khoan ${qrA.qr_reference}` })
    assert.equal(dup.duplicate, true)
    assert.equal(dup.id, first.id)
    assert.equal(await count('SELECT count(*) FROM public.bank_transactions WHERE provider=$1 AND provider_txn_id=$2', ['SEPAY', txnA]), 1)
    // Chuông báo phải tới chủ cửa hàng mà không ai phải bấm gì.
    assert.ok(
      await count("SELECT count(*) FROM public.notifications WHERE user_id=$1 AND action='CREATE_PAYMENT' AND deep_link=$2", [users.owner, '/sales/' + saleA.saleId]) >= 1,
      'Auto-recorded money must ring the owner straight onto the sale'
    )
    pass('Exact money on an owner-created code books itself onto the sale and re-delivery is idempotent')

    // 9. get_vietqr_matching_status -> state only, no amount; finance-gated.
    const status = await callUuid('owner', 'get_vietqr_matching_status', qrA.id)
    assert.equal(status.state, 'RECORDED')
    assert.equal(Object.hasOwn(status, 'amount'), false)
    assert.ok(typeof status.sender_name === 'string')
    await deny(() => callUuid('staff', 'get_vietqr_matching_status', qrA.id))
    pass('get_vietqr_matching_status exposes state (no amount) and is finance-gated')

    // 7. Separation of duties: a code created by someone else never self-books.
    // It lands on the sale as a pending receipt until the OWNER confirms it.
    const saleD = await mkSale('92B1-50004', '0905550004')
    const qrD = await call('financialManager', 'create_vietqr_payment_request', { sale_id: saleD.saleId, amount: 25_000_000, qr_payload: 'ssa-d' })
    const txnD = `SEPAY-${randomUUID().slice(0, 8)}`
    const waiting = await callSvc({ provider: 'SEPAY', provider_txn_id: txnD, amount: 25_000_000, sender_name: 'KH QUAN LY', transfer_content: `Chuyen khoan ${qrD.qr_reference}` })
    assert.equal(waiting.status, 'MATCHED_PENDING')
    const waitingRow = await row('SELECT match_reason, payment_id FROM public.bank_transactions WHERE id=$1', [waiting.id])
    assert.equal(waitingRow.match_reason, 'PENDING_OWNER_APPROVAL')
    assert.equal(waitingRow.payment_id, null)
    const pendingReceipts = async () => (await callUuid('owner', 'list_payment_receipts', saleD.saleId)).filter(r => r.status === 'PENDING')
    assert.equal((await pendingReceipts()).length, 1, 'Money must appear on the sale as one pending receipt')
    assert.ok(
      await count("SELECT count(*) FROM public.notifications WHERE user_id=$1 AND action='BANK_TRANSACTION_MATCHED' AND deep_link=$2", [users.owner, '/sales/' + saleD.saleId]) >= 1,
      'Waiting money must point the owner at the order, not at a separate queue'
    )
    const confirmReq = randomUUID()
    const recorded = await call('owner', 'confirm_bank_transaction', { id: waiting.id, request_id: confirmReq, notes: 'du 25tr' })
    assert.equal(recorded.status, 'RECORDED')
    assert.ok(recorded.payment_id)
    assert.equal((await pendingReceipts()).length, 0, 'Confirming the money must close its pending receipt')
    const payCount = await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleD.saleId])
    const reconfirmed = await call('owner', 'confirm_bank_transaction', { id: waiting.id, request_id: confirmReq })
    assert.equal(reconfirmed.payment_id, recorded.payment_id)
    assert.equal(reconfirmed.status, 'RECORDED')
    assert.equal(await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleD.saleId]), payCount)
    const redelivered = await callSvc({ provider: 'SEPAY', provider_txn_id: txnD, amount: 25_000_000, transfer_content: `Chuyen khoan ${qrD.qr_reference}` })
    assert.equal(redelivered.duplicate, true)
    assert.equal(await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'", [saleD.saleId]), payCount)
    pass('Money on a code the owner did not create waits on the sale, then books once on confirm')

    // 3. Bare 5-digit content never links by mistake.
    const bare = await svcTxn({ amount: 30_000_000, transfer_content: 'chuyen tien GD01001 noi dung thuong' })
    assert.equal(bare.status, 'UNMATCHED')
    const bareRow = await row('SELECT match_reason, qr_request_id FROM public.bank_transactions WHERE id=$1', [bare.id])
    assert.equal(bareRow.qr_request_id, null)
    assert.equal(bareRow.match_reason, 'NO_REFERENCE')
    pass('A bare 5-digit code without the CAREM GD prefix never links a VietQR request')

    // 5. Amount mismatch (QR B still PENDING) -> neutral MANUAL_REVIEW.
    const wrong = await svcTxn({ amount: 29_000_000, transfer_content: `Thanh toan ${qrB.qr_reference}` })
    assert.equal(wrong.status, 'MANUAL_REVIEW')
    assert.equal((await row('SELECT match_reason FROM public.bank_transactions WHERE id=$1', [wrong.id])).match_reason, 'AMOUNT_MISMATCH')
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
    pass('link_bank_transaction binds an unmatched transaction by human CAREM GD reference')

    // 17. Approving the receipt on the sale is the only approval UI left, so it must
    // close the money loop by itself: payment + bank transaction + VietQR.
    const saleCReceipts = async () => (await callUuid('owner', 'list_payment_receipts', saleC.saleId)).filter(r => r.status === 'PENDING')
    const linkedReceipt = await saleCReceipts()
    assert.equal(linkedReceipt.length, 1, 'Linking money onto a sale must surface it as one pending receipt')
    const approvalReq = randomUUID()
    const approvedPayment = await call('owner', 'add_payment', {
      request_id: approvalReq, receipt_id: linkedReceipt[0].id,
      verification_reference: 'Kiem tra sao ke ngan hang khop ma CAREM GD tren QR',
    })
    assert.ok(approvedPayment, 'add_payment from a receipt returns the new payment id')
    const closedTxn = await row('SELECT status, payment_id, confirmed_by FROM public.bank_transactions WHERE id=$1', [orphan.id])
    assert.equal(closedTxn.status, 'RECORDED')
    assert.equal(closedTxn.payment_id, approvedPayment)
    assert.equal(closedTxn.confirmed_by, users.owner)
    const closedQr = await row('SELECT status, payment_id FROM public.vietqr_requests WHERE id=$1', [qrC.id])
    assert.equal(closedQr.status, 'CONFIRMED')
    assert.equal(closedQr.payment_id, approvedPayment)
    assert.equal((await saleCReceipts()).length, 0, 'Approval must empty the sale queue')
    assert.equal((await callUuid('owner', 'get_vietqr_matching_status', qrC.id)).state, 'RECORDED')
    assert.equal(await count("SELECT count(*) FROM public.payments WHERE sale_id=$1 AND amount=20000000", [saleC.saleId]), 1)
    pass('Recording the pending receipt on the sale also closes its bank transaction and VietQR code')

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

    // 13. customer_contacts: no price fields; STAFF cannot verify.
    const contact = await call('staff', 'save_sale_contact', { sale_id: saleA.saleId, channel: 'ZALO_PERSONAL', handle: 'kah-tu-dong', display_name: 'Khách Tự Động', phone: '0905550001' })
    assert.ok(contact.id)
    assert.equal(Object.hasOwn(contact, 'sale_price'), false)
    assert.equal(Object.hasOwn(contact, 'purchase_price'), false)
    const contacts = await callUuid('staff', 'list_sale_contacts', saleA.saleId)
    assert.ok(contacts.some((c) => c.id === contact.id && c.channel === 'ZALO_PERSONAL' && c.verified === false))
    await deny(() => call('staff', 'verify_sale_contact', { id: contact.id, verified: true }))
    pass('customer_contacts hold no price fields and STAFF cannot verify a contact')

    // 15. Personal thank-you enqueues ONLY on VERIFY_SALE_CONTACT of a personal channel.
    await call('owner', 'save_settings', { thankyou_manual_enabled: true })
    await call('owner', 'verify_sale_contact', { id: contact.id, verified: true })
    const queue = await callUuid('owner', 'list_sale_thank_you_queue', saleA.saleId)
    assert.ok(queue.some((q) => q.channel === 'ZALO_PERSONAL'), 'Expected a personal thank-you queue item after VERIFY_SALE_CONTACT')
    const outboxRow = await row("SELECT status, last_error_code FROM public.message_outbox WHERE sale_id=$1 AND event_type='SALE_THANK_YOU_PERSONAL' AND channel='ZALO_PERSONAL'", [saleA.saleId])
    assert.equal(outboxRow.status, 'QUEUED')
    assert.equal(outboxRow.last_error_code, 'MANUAL_CHANNEL')
    pass('Verifying a personal contact enqueues the manual thank-you (no auto-send, no unofficial API)')

    const oaContact = await call('owner', 'save_sale_contact', { sale_id: saleA.saleId, channel: 'ZALO_OA', handle: 'carem-oa', display_name: 'Khách OA' })
    await call('owner', 'verify_sale_contact', { id: oaContact.id, verified: true })
    assert.equal(await count("SELECT count(*) FROM public.message_outbox WHERE sale_id=$1 AND event_type='SALE_THANK_YOU_PERSONAL' AND channel='ZALO_OA'", [saleA.saleId]), 0)
    pass('Official channels never fall into the personal thank-you enqueue')

    // 14. message_templates reject price placeholders; save OWNER-only.
    await assert.rejects(() => call('owner', 'save_message_template', { code: 'evil_template_v1', body: 'Cam on {customer_name}, gia ban {sale_price}d' }), /TEMPLATE_VARIABLE_NOT_ALLOWED/i)
    await deny(() => call('manager', 'save_message_template', { code: 'ok_template_v1', body: 'Cam on {customer_name} da mua tai {store_name}' }))
    await call('owner', 'save_message_template', { code: 'ok_template_v1', body: 'Cam on {customer_name} da mua tai {store_name}' })
    const preview = await call('owner', 'preview_message_template', { code: 'ok_template_v1', sale_id: saleA.saleId })
    assert.ok(typeof preview.rendered === 'string' && !/\{sale_price\}/.test(preview.rendered) && !/100000000|100.000.000/.test(preview.rendered))
    pass('message_templates reject price placeholders, save is OWNER-only, preview renders no price')

    // 16. A non-participant STAFF never receives money-arrival notices.
    const staffBankNotices = await count("SELECT count(*) FROM public.notifications WHERE user_id=$1 AND action LIKE 'BANK_TRANSACTION%'", [users.staff])
    assert.equal(staffBankNotices, 0)
    pass('Money-arrival notices do not reach a non-financial, non-participant STAFF')

    console.log(`\nSmart Sales Automation suite: ${passed} groups passed`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('smart-sales-automation.test.mjs')) {
  await runSmartSalesAutomationTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
