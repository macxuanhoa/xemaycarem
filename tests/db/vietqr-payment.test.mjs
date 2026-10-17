/**
 * Database VietQR Dynamic Payment Test Suite
 * Covers the server-issued, verified VietQR lifecycle:
 *  1. Bank Account Settings on system_settings: OWNER can configure bank_bin, bank_name,
 *     bank_account_no, bank_account_name, vietqr_enabled; STAFF is denied.
 *  2. Validation: enabling VietQR without required bank details fails with VIETQR_CONFIG_REQUIRED.
 *  3. Audit: Bank settings changes emit BANK_ACCOUNT_CHANGED audit log.
 *  4. Access Control: STAFF without finance permissions is denied from creating or confirming VietQR.
 *  5. Dynamic QR Creation: creates PENDING request with unique reference (e.g. CAREM GD01001).
 *  6. Idempotency: calling with same amount reuses existing PENDING request.
 *  7. Replacement is explicit and rate-limited; closing/reopening never resets expiry.
 *  8. Multi-stage Sale & Balance Protection: creates sale with remaining debt; rejects QR
 *     requests exceeding remaining balance with PAYMENT_EXCEEDS_BALANCE.
 *  9. Only an authenticated inbound bank credit can record BANK_TRANSFER payment.
 * 10. Pre-sale bank evidence is bound once to the sale, receipt and payment ledger.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runVietQrPaymentTests(externalDb, { engine = 'pglite' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database VietQR Dynamic Payment Test Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

    const users = Object.fromEntries(['owner', 'manager', 'staff'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(
      ['create_vietqr_payment_request', 'replace_vietqr_payment_request'].includes(name) && !data.sale_id
        ? { payer_name: 'Synthetic QR Payer', ...data } : data,
    )]))
    const readQr = (id) => run('owner', (client) => rpc(client, 'get_vietqr_payment_request', '$1::uuid', [id]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)
    const ingest = async (data) => asUser(db, null, (client) => rpc(client, 'ingest_bank_transaction', '$1::jsonb', [JSON.stringify({
      provider: 'SEPAY', provider_txn_id: randomUUID(), direction: 'in',
      account_number: '0000000000', transfer_at: new Date().toISOString(), ...data,
    })]), 'service_role')

    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `vietqr-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,can_view_financials=$2 WHERE id=$3', [
        name.toUpperCase(),
        name === 'owner',
        id
      ])
    }

    // 1. Bank Account Settings: OWNER configures bank details; STAFF is denied.
    await deny(() => call('staff', 'save_settings', {
      bank_bin: '970422',
      bank_name: 'MBBank',
      bank_account_no: '0000000000',
      bank_account_name: 'SYNTHETIC QR RECEIVER',
      vietqr_enabled: true
    }))
    pass('STAFF is strictly denied from changing bank account settings')

    // 2. Validation: enabling VietQR without required bank details fails with VIETQR_CONFIG_REQUIRED
    await assert.rejects(
      () => call('owner', 'save_settings', {
        bank_bin: '',
        bank_account_no: '',
        vietqr_enabled: true
      }),
      /VIETQR_CONFIG_REQUIRED/i
    )
    pass('Enabling VietQR without required bank details fails with VIETQR_CONFIG_REQUIRED')

    // 3. OWNER configures bank settings successfully and emits BANK_ACCOUNT_CHANGED audit
    await call('owner', 'save_settings', {
      bank_bin: '970422',
      bank_name: 'MBBank',
      bank_account_no: '0000000000',
      bank_account_name: 'SYNTHETIC QR RECEIVER',
      vietqr_enabled: true,
      bank_provider: 'SEPAY', bank_webhook_enabled: true, bank_auto_match_enabled: true,
    })
    const settings = await row('SELECT bank_bin, bank_name, bank_account_no, bank_account_name, vietqr_enabled FROM public.system_settings WHERE id')
    assert.equal(settings.bank_bin, '970422')
    assert.equal(settings.bank_name, 'MBBank')
    assert.equal(settings.bank_account_no, '0000000000')
    assert.equal(settings.bank_account_name, 'SYNTHETIC QR RECEIVER')
    assert.equal(settings.vietqr_enabled, true)

    const bankAuditCount = await count("SELECT count(*) FROM public.audit_logs WHERE action = 'BANK_ACCOUNT_CHANGED'")
    assert.ok(bankAuditCount >= 1, 'Expected BANK_ACCOUNT_CHANGED audit log')
    pass('OWNER successfully saves bank account settings and writes BANK_ACCOUNT_CHANGED audit log')

    // 4. Create vehicle for testing
    const vehicleId = await call('owner', 'save_vehicle', {
      request_id: randomUUID(),
      vehicle_type: 'Xe tay ga',
      license_plate: '92B1-12345',
      frame_number: `FRAME${randomUUID().slice(0, 8)}`,
      purchase_date: day,
      purchase_price: 20_000_000,
    })

    // 5. Access Control: STAFF without finance permission cannot create VietQR payment request
    await deny(() => call('staff', 'create_vietqr_payment_request', {
      vehicle_id: vehicleId,
      amount: 5_000_000,
      qr_payload: 'test-payload'
    }))
    pass('STAFF is strictly denied from creating VietQR payment requests')

    await assert.rejects(() => run('owner', (client) => rpc(client, 'create_vietqr_payment_request', '$1::jsonb', [JSON.stringify({
      vehicle_id: vehicleId, amount: 5_000_000,
    })])), /VIETQR_PAYER_REQUIRED/)

    // 6. Dynamic QR Creation for intake/reserved bike
    const qr1 = await call('owner', 'create_vietqr_payment_request', {
      vehicle_id: vehicleId,
      amount: 5_000_000,
      qr_payload: 'test-payload-5m'
    })
    assert.ok(qr1.id, 'Expected QR request ID')
    assert.ok(qr1.qr_reference.startsWith('CAREM GD'), `Expected reference starting with CAREM GD, got: ${qr1.qr_reference}`)
    assert.equal(qr1.amount, 5_000_000)
    assert.equal(qr1.status, 'PENDING')
    assert.equal(qr1.bank_bin, '970422')
    assert.equal(qr1.bank_account_no, '0000000000')
    assert.equal(qr1.superseded, false)
    assert.equal(new Date(qr1.expires_at) - new Date(qr1.created_at), 15 * 60_000)
    assert.equal(new Date(qr1.replace_available_at) - new Date(qr1.created_at), 60_000)
    assert.equal(qr1.monitoring_available, true)
    assert.equal(qr1.payer_name, 'Synthetic QR Payer')
    assert.ok(qr1.agreement_text.includes('Synthetic QR Payer'))
    assert.ok(qr1.agreement_text.includes('SYNTHETIC QR RECEIVER'))
    pass('OWNER creates dynamic VietQR request with formatted unique reference CAREM GD...')

    // 7. Idempotency: re-requesting same amount reuses existing PENDING request
    const qr1Duplicate = await call('owner', 'create_vietqr_payment_request', {
      vehicle_id: vehicleId,
      amount: 5_000_000,
      qr_payload: 'test-payload-5m'
    })
    assert.equal(qr1Duplicate.id, qr1.id)
    assert.equal(qr1Duplicate.qr_reference, qr1.qr_reference)
    assert.equal(qr1Duplicate.superseded, false)
    assert.equal(qr1Duplicate.expires_at, qr1.expires_at)
    assert.equal(qr1Duplicate.replace_available_at, qr1.replace_available_at)
    pass('Reopening with the same amount reuses the request and never extends its 15-minute lifetime')

    await deny(() => call('staff', 'confirm_vietqr_payment', { qr_request_id: qr1.id }))
    await assert.rejects(() => call('owner', 'confirm_vietqr_payment', {
      qr_request_id: qr1.id, notes: 'Synthetic manual claim',
    }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    assert.equal((await readQr(qr1.id)).status, 'PENDING')
    assert.equal(await count('SELECT count(*) FROM public.bank_transactions'), 0)
    pass('Legacy confirmation cannot manufacture receipt of money, even for OWNER')

    // Đổi thông tin (số tiền/tên) là thao tác thay mã rõ ràng nên được BỎ 60 giây
    // cooldown: nhân viên sửa biểu mẫu rồi mở lại thấy ngay mã đúng số tiền mới,
    // không bị kẹt hiển thị mã cũ. Create mới (v_replace NULL) với thông tin khác
    // vẫn bắt buộc phải thay mã; thay mã CÙNG thông tin (bấm spam) vẫn dính cooldown.
    await assert.rejects(() => call('owner', 'create_vietqr_payment_request', {
      vehicle_id: vehicleId, amount: 10_000_000,
    }), /VIETQR_REPLACE_REQUIRED/)
    const qr2 = await call('owner', 'replace_vietqr_payment_request', {
      replace_request_id: qr1.id, amount: 10_000_000,
    })
    assert.notEqual(qr2.id, qr1.id)
    assert.equal(qr2.amount, 10_000_000)
    assert.equal(qr2.status, 'PENDING')
    assert.equal(qr2.superseded, true)

    // Check old request status
    const oldReq = await row('SELECT status, cancellation_reason FROM public.vietqr_requests WHERE id = $1', [qr1.id])
    assert.equal(oldReq.status, 'CANCELLED')
    assert.equal(oldReq.cancellation_reason, 'REPLACED_BY_NEW_REQUEST')

    const cancelAudit = await count("SELECT count(*) FROM public.audit_logs WHERE action = 'CANCEL_VIETQR_PAYMENT_REQUEST' AND entity_id = $1", [qr1.id])
    assert.ok(cancelAudit >= 1, 'Expected CANCEL_VIETQR_PAYMENT_REQUEST audit log')
    await assert.rejects(() => call('owner', 'replace_vietqr_payment_request', {
      replace_request_id: qr2.id, amount: 10_000_000,
    }), /VIETQR_REPLACEMENT_COOLDOWN/)
    pass('A detail change replaces the code instantly (bypassing cooldown) while identical reissues still wait')

    // 9. Cancel QR explicitly
    await call('owner', 'cancel_vietqr_payment_request', qr2.id)
    const cancelledQr2 = await row('SELECT status FROM public.vietqr_requests WHERE id = $1', [qr2.id])
    assert.equal(cancelledQr2.status, 'CANCELLED')
    pass('OWNER can explicitly cancel pending VietQR request')

    const expiringVehicle = await call('owner', 'save_vehicle', {
      request_id: randomUUID(), vehicle_type: 'Xe tay ga', license_plate: '92B1-12347',
      frame_number: `FRAME${randomUUID().slice(0, 8)}`, purchase_date: day, purchase_price: 10_000_000,
    })
    const expiring = await call('owner', 'create_vietqr_payment_request', { vehicle_id: expiringVehicle, amount: 10_000_000 })
    const expiredTiming = await row("UPDATE public.vietqr_requests SET created_at=clock_timestamp()-interval '16 minutes', expires_at=clock_timestamp()-interval '1 minute', replace_available_at=clock_timestamp()-interval '15 minutes' WHERE id=$1 RETURNING created_at,expires_at", [expiring.id])
    assert.equal((await readQr(expiring.id)).status, 'EXPIRED')
    const reopenedExpired = await call('owner', 'create_vietqr_payment_request', { vehicle_id: expiringVehicle, amount: 10_000_000 })
    assert.equal(reopenedExpired.id, expiring.id)
    assert.equal(reopenedExpired.status, 'EXPIRED')
    assert.equal(new Date(reopenedExpired.expires_at).getTime(), new Date(expiredTiming.expires_at).getTime())
    const late = await ingest({ amount: 10_000_000, transfer_content: expiring.qr_reference })
    assert.equal(late.status, 'MANUAL_REVIEW')
    await assert.rejects(() => call('owner', 'confirm_vietqr_payment', { qr_request_id: expiring.id }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    assert.equal((await readQr(expiring.id)).bank_transaction_id, null)
    pass('Expired requests remain expired across reopening; a late bank credit never produces payment success')

    // 10. Multi-stage Sale & Balance Protection:
    // Create Sale: 25,000,000 VND, initial payment: 5,000,000 VND (remaining: 20,000,000 VND)
    const saleId = await call('owner', 'sell_vehicle', {
      vehicle_id: vehicleId,
      customer_name: 'Khach Mua VietQR',
      customer_phone: '0901234567',
      sale_price: 25_000_000,
      initial_payment: 5_000_000,
      payment_method: 'CASH',
      sale_date: day,
      request_id: randomUUID()
    })
    const saleRow = await row('SELECT sale_price FROM public.sales WHERE id = $1', [saleId])
    assert.equal(Number(saleRow.sale_price), 25_000_000)

    // Attempting to create QR for 25M exceeds 20M remaining balance -> PAYMENT_EXCEEDS_BALANCE
    await assert.rejects(
      () => call('owner', 'create_vietqr_payment_request', {
        sale_id: saleId,
        amount: 25_000_000,
        qr_payload: 'test-25m'
      }),
      /PAYMENT_EXCEEDS_BALANCE/i
    )
    pass('Creating QR exceeding remaining sale balance is rejected with PAYMENT_EXCEEDS_BALANCE')

    // Create valid second stage QR for remaining 20,000,000 VND
    const saleQr = await call('owner', 'create_vietqr_payment_request', {
      sale_id: saleId,
      amount: 20_000_000,
      qr_payload: 'test-payload-20m'
    })
    assert.equal(saleQr.amount, 20_000_000)
    assert.equal(saleQr.status, 'PENDING')
    assert.ok(saleQr.qr_reference.startsWith('CAREM GD'))
    pass('Successfully created stage 2 VietQR request for exact remaining debt (20,000,000 VNĐ)')

    // 11. A trusted bank event records the receipt and payment without manual claims.
    const confirmRequestId = randomUUID()
    await assert.rejects(() => call('owner', 'confirm_vietqr_payment', {
      qr_request_id: saleQr.id, request_id: confirmRequestId,
    }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    const bankEvent = { provider_txn_id: randomUUID(), amount: 20_000_000, transfer_content: saleQr.transfer_content }
    const bankCredit = await ingest(bankEvent)
    assert.equal(bankCredit.status, 'RECORDED')
    const paymentId = await call('owner', 'confirm_vietqr_payment', {
      qr_request_id: saleQr.id,
      request_id: confirmRequestId,
      notes: 'Khach da chuyen khoan du 20 trieu qua app Vietcombank'
    })
    assert.ok(paymentId, 'Expected payment ID')

    const confirmedReq = await row('SELECT status, payment_id, bank_transaction_id, receipt_id FROM public.vietqr_requests WHERE id = $1', [saleQr.id])
    assert.equal(confirmedReq.status, 'CONFIRMED')
    assert.equal(confirmedReq.payment_id, paymentId)
    assert.equal(confirmedReq.bank_transaction_id, bankCredit.id)
    assert.ok(confirmedReq.receipt_id)
    assert.equal((await row('SELECT status,payment_id FROM public.payment_receipts WHERE id=$1', [confirmedReq.receipt_id])).payment_id, paymentId)

    const paymentRow = await row('SELECT amount, payment_method, reference FROM public.payments WHERE id = $1', [paymentId])
    assert.equal(Number(paymentRow.amount), 20_000_000)
    assert.equal(paymentRow.payment_method, 'BANK_TRANSFER')
    assert.equal(paymentRow.reference, saleQr.qr_reference)

    const totalPaid = await count('SELECT sum(amount) AS count FROM public.payments WHERE sale_id = $1 AND status = $2', [saleId, 'ACTIVE'])
    assert.equal(totalPaid, 25_000_000)
    pass('Only the trusted incoming credit records BANK_TRANSFER payment, its receipt and clears debt')

    // 12. Idempotent re-confirmation: returns same paymentId without double-crediting
    const reconfirmedPaymentId = await call('owner', 'confirm_vietqr_payment', {
      qr_request_id: saleQr.id,
      request_id: confirmRequestId
    })
    assert.equal(reconfirmedPaymentId, paymentId)
    const totalPaidAfter = await count('SELECT sum(amount) AS count FROM public.payments WHERE sale_id = $1 AND status = $2', [saleId, 'ACTIVE'])
    assert.equal(totalPaidAfter, 25_000_000)
    const replay = await ingest(bankEvent)
    assert.equal(replay.id, bankCredit.id)
    assert.equal(replay.duplicate, true)
    assert.equal(await count('SELECT count(*) FROM public.payments WHERE id=$1', [paymentId]), 1)
    pass('Acknowledging or replaying a verified bank credit never creates duplicate payment records')

    // Bank evidence before the sale exists is retained, then bound exactly once.
    const preSaleVehicle = await call('owner', 'save_vehicle', {
      request_id: randomUUID(), vehicle_type: 'Xe tay ga', license_plate: '92B1-12346',
      frame_number: `FRAME${randomUUID().slice(0, 8)}`, purchase_date: day, purchase_price: 10_000_000,
    })
    const preSaleQr = await call('owner', 'create_vietqr_payment_request', {
      vehicle_id: preSaleVehicle, amount: 5_000_000, payer_name: 'Synthetic Payer',
    })
    // The provider can deliver late; the bank transfer itself happened within 15 minutes.
    const preSaleTiming = await row("UPDATE public.vietqr_requests SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute',replace_available_at=clock_timestamp()-interval '15 minutes' WHERE id=$1 RETURNING created_at", [preSaleQr.id])
    assert.equal((await readQr(preSaleQr.id)).status, 'EXPIRED')
    const preSaleEvent = {
      provider_txn_id: randomUUID(), amount: 5_000_000, transfer_content: preSaleQr.transfer_content,
      transfer_at: new Date(new Date(preSaleTiming.created_at).getTime() + 60_000).toISOString(),
    }
    const preSaleBank = await ingest(preSaleEvent)
    assert.equal(preSaleBank.status, 'RECEIVED')
    const received = await readQr(preSaleQr.id)
    assert.equal(received.status, 'RECEIVED')
    assert.equal(received.bank_transaction_id, preSaleBank.id)
    assert.equal(received.payment_id, null)
    assert.equal(await call('owner', 'confirm_vietqr_payment', { qr_request_id: preSaleQr.id }), null)
    assert.equal((await call('owner', 'create_vietqr_payment_request', {
      vehicle_id: preSaleVehicle, amount: 5_000_000, payer_name: 'Synthetic Payer',
    })).id, preSaleQr.id)
    await assert.rejects(() => call('owner', 'replace_vietqr_payment_request', {
      replace_request_id: preSaleQr.id, amount: 5_000_000, payer_name: 'Synthetic Payer',
    }), /VIETQR_FUNDS_ALREADY_RECEIVED/)
    pass('A timely bank transfer delivered late remains verified pre-sale evidence across reopening')

    const preSaleData = {
      request_id: randomUUID(), vehicle_id: preSaleVehicle, customer_name: 'Synthetic Payer',
      sale_price: 20_000_000, initial_payment: 5_000_000, payment_method: 'BANK_TRANSFER',
      sale_date: day, vietqr_request_id: preSaleQr.id,
    }
    await assert.rejects(() => call('owner', 'sell_vehicle', {
      ...preSaleData, request_id: randomUUID(), vietqr_request_id: undefined,
    }), /VIETQR_BANK_EVIDENCE_REQUIRED/)
    for (const override of [{ customer_name: 'Another Synthetic Payer' }, { initial_payment: 4_000_000 }, { payment_method: 'CASH' }]) {
      await assert.rejects(() => call('owner', 'sell_vehicle', {
        ...preSaleData, ...override, request_id: randomUUID(),
      }), /VIETQR_SALE_BINDING_MISMATCH/)
    }
    assert.equal(await count('SELECT count(*) FROM public.sales WHERE vehicle_id=$1', [preSaleVehicle]), 0)
    const boundSale = await call('owner', 'sell_vehicle', preSaleData)
    assert.equal(await call('owner', 'sell_vehicle', preSaleData), boundSale)
    const boundQr = await readQr(preSaleQr.id)
    assert.equal(boundQr.status, 'CONFIRMED')
    assert.equal(boundQr.sale_id, boundSale)
    assert.ok(boundQr.payment_id)
    assert.equal((await row('SELECT payment_id FROM public.bank_transactions WHERE id=$1', [preSaleBank.id])).payment_id, boundQr.payment_id)
    assert.equal(await count('SELECT count(*) FROM public.payments WHERE sale_id=$1', [boundSale]), 1)
    assert.equal(await count('SELECT sum(amount) AS count FROM public.payments WHERE sale_id=$1', [boundSale]), 5_000_000)
    assert.equal((await ingest(preSaleEvent)).duplicate, true)
    assert.equal(await count('SELECT count(*) FROM public.payments WHERE sale_id=$1', [boundSale]), 1)
    pass('Vehicle, payer, amount and method are bound atomically; sale replay never double-credits the pre-sale transfer')

    // Regression: the sequence must retain six digits after 99,999.
    const previousSequence = await row('SELECT last_value FROM private.vietqr_ref_seq')
    await db.query("SELECT setval('private.vietqr_ref_seq',greatest($1::bigint,99999),true)", [previousSequence.last_value])
    const wideReference = (await row('SELECT private.generate_vietqr_reference() AS reference')).reference
    assert.match(wideReference, /^CAREM GD[0-9]{6,}$/)
    assert.notEqual(wideReference, 'CAREM GD10000')
    pass('Reference generation retains all sequence digits and cannot collide through five-digit truncation')

    console.log(`\nAll ${passed} VietQR database tests passed!`)
  } finally {
    if (ownDb) await db.close()
  }
}

if (process.argv[1]?.endsWith('vietqr-payment.test.mjs')) {
  await runVietQrPaymentTests()
}
