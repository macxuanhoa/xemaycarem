/**
 * Database VietQR Dynamic Payment Test Suite
 * Covers migration 20261010000700:
 *  1. Bank Account Settings on system_settings: OWNER can configure bank_bin, bank_name,
 *     bank_account_no, bank_account_name, vietqr_enabled; STAFF is denied.
 *  2. Validation: enabling VietQR without required bank details fails with VIETQR_CONFIG_REQUIRED.
 *  3. Audit: Bank settings changes emit BANK_ACCOUNT_CHANGED audit log.
 *  4. Access Control: STAFF without finance permissions is denied from creating or confirming VietQR.
 *  5. Dynamic QR Creation: creates PENDING request with unique reference (e.g. CAREM GD01001).
 *  6. Idempotency: calling with same amount reuses existing PENDING request.
 *  7. Amount Change Supersession: calling with different amount cancels old request with
 *     SUPERSEDED_BY_NEW_AMOUNT and issues a fresh one.
 *  8. Multi-stage Sale & Balance Protection: creates sale with remaining debt; rejects QR
 *     requests exceeding remaining balance with PAYMENT_EXCEEDS_BALANCE.
 *  9. Confirmation & Recording: OWNER confirmation atomically records BANK_TRANSFER payment,
 *     links payment_id, updates request status to CONFIRMED, and reduces sale balance.
 * 10. Re-confirmation Idempotency: repeating confirm returns existing payment without double-counting.
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
    const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const count = async (sql, args = []) => Number((await row(sql, args)).count)
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) =>
      assert.rejects(operation, expression)

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
      bank_account_no: '0987654321',
      bank_account_name: 'NGUYEN VAN A',
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
      bank_account_no: '0987654321',
      bank_account_name: 'NGUYEN VAN A',
      vietqr_enabled: true
    })
    const settings = await row('SELECT bank_bin, bank_name, bank_account_no, bank_account_name, vietqr_enabled FROM public.system_settings WHERE id')
    assert.equal(settings.bank_bin, '970422')
    assert.equal(settings.bank_name, 'MBBank')
    assert.equal(settings.bank_account_no, '0987654321')
    assert.equal(settings.bank_account_name, 'NGUYEN VAN A')
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
    assert.equal(qr1.bank_account_no, '0987654321')
    assert.equal(qr1.superseded, false)
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
    pass('Calling create_vietqr_payment_request with same amount idempotently returns existing request')

    // 8. Amount Change Supersession: changing amount cancels old QR and issues new QR
    const qr2 = await call('owner', 'create_vietqr_payment_request', {
      vehicle_id: vehicleId,
      amount: 10_000_000,
      qr_payload: 'test-payload-10m'
    })
    assert.notEqual(qr2.id, qr1.id)
    assert.equal(qr2.amount, 10_000_000)
    assert.equal(qr2.status, 'PENDING')
    assert.equal(qr2.superseded, true)

    // Check old request status
    const oldReq = await row('SELECT status, cancellation_reason FROM public.vietqr_requests WHERE id = $1', [qr1.id])
    assert.equal(oldReq.status, 'CANCELLED')
    assert.equal(oldReq.cancellation_reason, 'SUPERSEDED_BY_NEW_AMOUNT')

    const cancelAudit = await count("SELECT count(*) FROM public.audit_logs WHERE action = 'CANCEL_VIETQR_PAYMENT_REQUEST' AND entity_id = $1", [qr1.id])
    assert.ok(cancelAudit >= 1, 'Expected CANCEL_VIETQR_PAYMENT_REQUEST audit log')
    pass('Changing payment amount marks old QR CANCELLED (SUPERSEDED_BY_NEW_AMOUNT) and issues fresh QR')

    // 9. Cancel QR explicitly
    await call('owner', 'cancel_vietqr_payment_request', qr2.id)
    const cancelledQr2 = await row('SELECT status FROM public.vietqr_requests WHERE id = $1', [qr2.id])
    assert.equal(cancelledQr2.status, 'CANCELLED')
    pass('OWNER can explicitly cancel pending VietQR request')

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

    // 11. Confirmation & Recording:
    // OWNER confirms receipt of funds: records payment, marks CONFIRMED
    const confirmRequestId = randomUUID()
    const paymentId = await call('owner', 'confirm_vietqr_payment', {
      qr_request_id: saleQr.id,
      request_id: confirmRequestId,
      notes: 'Khach da chuyen khoan du 20 trieu qua app Vietcombank'
    })
    assert.ok(paymentId, 'Expected payment ID')

    const confirmedReq = await row('SELECT status, payment_id, confirmed_by FROM public.vietqr_requests WHERE id = $1', [saleQr.id])
    assert.equal(confirmedReq.status, 'CONFIRMED')
    assert.equal(confirmedReq.payment_id, paymentId)
    assert.equal(confirmedReq.confirmed_by, users.owner)

    const paymentRow = await row('SELECT amount, payment_method, reference FROM public.payments WHERE id = $1', [paymentId])
    assert.equal(Number(paymentRow.amount), 20_000_000)
    assert.equal(paymentRow.payment_method, 'BANK_TRANSFER')
    assert.equal(paymentRow.reference, saleQr.qr_reference)

    const totalPaid = await count('SELECT sum(amount) AS count FROM public.payments WHERE sale_id = $1 AND status = $2', [saleId, 'ACTIVE'])
    assert.equal(totalPaid, 25_000_000)
    pass('OWNER confirmation records BANK_TRANSFER payment with QR reference, marks CONFIRMED, and clears debt')

    // 12. Idempotent re-confirmation: returns same paymentId without double-crediting
    const reconfirmedPaymentId = await call('owner', 'confirm_vietqr_payment', {
      qr_request_id: saleQr.id,
      request_id: confirmRequestId
    })
    assert.equal(reconfirmedPaymentId, paymentId)
    const totalPaidAfter = await count('SELECT sum(amount) AS count FROM public.payments WHERE sale_id = $1 AND status = $2', [saleId, 'ACTIVE'])
    assert.equal(totalPaidAfter, 25_000_000)
    pass('Re-confirming payment is idempotent and never creates duplicate payment records')

    console.log(`\nAll ${passed} VietQR database tests passed!`)
  } finally {
    if (ownDb && db.end) await db.end()
  }
}

if (process.argv[1]?.endsWith('vietqr-payment.test.mjs')) {
  await runVietQrPaymentTests()
}
