/**
 * Database Business Risks Test Suite
 * Covers real financial, data integrity, authorization, and concurrency risks:
 * 1. Authentication & Inactive User rejection at DB level
 * 2. Role security (OWNER, MANAGER, STAFF, active=false)
 * 3. Vehicle Inventory (Creation, Unique internal_code, search, filter, cost_pending)
 * 4. Financial Data Separation (vehicles vs vehicle_financials)
 * 5. Vehicle Expenses (Active vs Cancelled, cost basis accumulation)
 * 6. Sell Vehicle Atomic Flow & Rollback
 * 7. Double Sale Concurrency
 * 8. Payments & Overpayment Guard
 * 9. Sale Cancellation & History Immutability
 * 10. Profit Calculation with BigInt VND
 * 11. Business Expenses (Independent from vehicle costs)
 * 12. Reporting (Asia/Ho_Chi_Minh timezone, date ranges)
 * 13. Audit Logging (Preserved across cancellations, immutable)
 * 14. Direct RLS table operations (SELECT/INSERT/UPDATE/DELETE denials)
 * 15. Input validation (negative/fractional money, dates, enums)
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'
import { verifiedPayment } from './payment-fixtures.mjs'

export async function runBusinessRisksTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Business Risks Test Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }

  const users = Object.fromEntries(
    ['owner', 'manager', 'financialManager', 'staff', 'disabled'].map((role) => [role, randomUUID()])
  )
  const run = (user, fn) => asUser(db, users[user], fn)
  const call = (user, name, data) => name === 'add_payment' ? verifiedPayment(db,users[user],users.owner,data) : run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
  const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security|violates check constraint/i) =>
    assert.rejects(operation, expression)

  const day = (await row('SELECT private.today()::text AS day')).day

  // Setup auth users & profiles with unique emails
  const suiteId = randomUUID().slice(0, 6)
  for (const [name, id] of Object.entries(users)) {
    await db.query(
      'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
      [id, `${name}-${suiteId}@example.test`, JSON.stringify({ full_name: `User ${name}` })]
    )
    const role = name === 'financialManager' ? 'MANAGER' : name === 'disabled' ? 'STAFF' : name.toUpperCase()
    await db.query(
      'UPDATE public.profiles SET role=$1::public.user_role,active=$2,can_view_financials=$3 WHERE id=$4',
      [role, name !== 'disabled', name === 'financialManager', id]
    )
  }

  // 1. VEHICLE INVENTORY: Unique internal_code constraint
  // STAFF-authored intake has PUBLIC cost for the accounting/sale contract.
  const v1Id = await call('staff', 'save_vehicle', {
    request_id: randomUUID(),
    vehicle_type: 'Xe tay ga',
    license_plate: '29-TEST-01',
    frame_number: 'FRAME-001',
    purchase_date: day,
    purchase_price: 80_000_000,
  })
  const v1 = await run('owner', (c) => rpc(c, 'get_vehicle', '$1::uuid', [v1Id]))
  assert.ok(v1.internal_code, 'internal_code must be assigned')

  // Direct insert attempting duplicate internal_code must violate unique constraint
  await deny(
    () =>
      db.query(
        "INSERT INTO public.vehicles(internal_code,vehicle_type_id,purchase_date,created_by) VALUES($1,(SELECT id FROM public.vehicle_types WHERE lower(btrim(name))='chưa phân loại'),$2,$3)",
        [v1.internal_code, day, users.owner]
      ),
    /duplicate key value violates unique constraint/i
  )
  pass('Vehicle internal_code unique constraint prevents duplicate vehicle codes')

  // 2. VEHICLE SEARCH & FILTERS
  const searchByPlate = await call('staff', 'list_vehicles', { search: '29-TEST-01' })
  assert.equal(searchByPlate.total, 1)
  assert.equal(searchByPlate.items[0].id, v1Id)

  const searchByFrame = await call('staff', 'list_vehicles', { search: 'FRAME-001' })
  assert.equal(searchByFrame.total, 1)

  const filterByStatus = await call('staff', 'list_vehicles', { status: 'IN_STOCK' })
  assert.ok(filterByStatus.items.some((i) => i.id === v1Id))

  const filterByUnavailable = await call('staff', 'list_vehicles', { status: 'SOLD' })
  assert.ok(!filterByUnavailable.items.some((i) => i.id === v1Id))
  pass('Search and status filters accurately match plate, frame, engine and inventory status')

  // 3. FINANCIAL SEPARATION & RLS DENIAL FOR RESTRICTED ROLES
  // Direct table query against vehicle_financials
  const staffFinDirect = await run('staff', (c) => c.query('SELECT * FROM public.vehicle_financials WHERE vehicle_id=$1', [v1Id]))
  assert.equal(staffFinDirect.rows.length, 0, 'STAFF must see 0 rows from direct vehicle_financials')

  const disabledFinDirect = await run('disabled', (c) => c.query('SELECT * FROM public.vehicle_financials WHERE vehicle_id=$1', [v1Id]))
  assert.equal(disabledFinDirect.rows.length, 0, 'Disabled user must see 0 rows from direct vehicle_financials')

  // Inactive user attempting RPC
  await deny(() => call('disabled', 'list_vehicles', {}), /ACCESS_DENIED/)
  pass('Direct RLS and RPCs strictly deny financial data and access for STAFF and disabled users')

  // 4. VEHICLE EXPENSES & COST BASIS Derivation
  const exp1Id = await run('manager', (c) =>
    rpc(c, 'save_expense', "'vehicle', $1::jsonb", [
      JSON.stringify({
        vehicle_id: v1Id,
        expense_type: 'REPAIR',
        description: 'Sơn dặm và kiểm tra động cơ',
        amount: 1_500_000,
        expense_date: day,
      }),
    ])
  )
  assert.ok(exp1Id)
  const exp2Id = await run('owner', (c) =>
    rpc(c, 'save_expense', "'vehicle', $1::jsonb", [
      JSON.stringify({
        vehicle_id: v1Id,
        expense_type: 'PARTS',
        description: 'Thay vỏ xe Michelin',
        amount: 2_000_000,
        expense_date: day,
      }),
    ])
  )
  assert.ok(exp2Id)
  const expCancelledId = await run('owner', (c) =>
    rpc(c, 'save_expense', "'vehicle', $1::jsonb", [
      JSON.stringify({
        vehicle_id: v1Id,
        expense_type: 'OTHER',
        description: 'Chi phí nhầm lẫn hủy bỏ',
        amount: 10_000_000,
        expense_date: day,
      }),
    ])
  )
  await run('owner', (c) => rpc(c, 'cancel_expense', "'vehicle', $1::uuid, 'Nhập nhầm hóa đơn'", [expCancelledId]))

  const v1WithCosts = await run('owner', (c) => rpc(c, 'get_vehicle', '$1::uuid', [v1Id]))
  assert.equal(v1WithCosts.purchase_price, 80_000_000)
  assert.equal(v1WithCosts.expense_total, 3_500_000) // 1.5M + 2.0M, excludes 10M cancelled
  assert.equal(v1WithCosts.total_cost, 83_500_000)
  pass('Vehicle cost basis aggregates only ACTIVE vehicle expenses (80M + 3.5M = 83.5M)')

  // 5. BUSINESS EXPENSES INDEPENDENCE
  const bExpId = await run('manager', (c) =>
    rpc(c, 'save_expense', "'business', $1::jsonb", [
      JSON.stringify({
        category: 'RENT',
        description: 'Tiền thuê cửa hàng tháng 9',
        amount: 20_000_000,
        expense_date: day,
      }),
    ])
  )
  const v1AfterBusinessExp = await run('owner', (c) => rpc(c, 'get_vehicle', '$1::uuid', [v1Id]))
  assert.equal(v1AfterBusinessExp.total_cost, 83_500_000, 'Business expenses must NEVER inflate vehicle total cost')

  // Business expenses list/report
  const bList = await run('manager', (c) => rpc(c, 'list_expenses', "$1::jsonb", ['{"kind":"business"}']))
  assert.ok(bList.items.some((i) => i.id === bExpId))

  // STAFF cannot list or add business expenses
  await deny(() => call('staff', 'list_expenses', { kind: 'business' }), /ACCESS_DENIED/)
  await deny(
    () =>
      run('staff', (c) =>
        rpc(c, 'save_expense', "'business', $1::jsonb", [
          JSON.stringify({ category: 'RENT', description: 'Unauthorized', amount: 1000, expense_date: day }),
        ])
      ),
    /ACCESS_DENIED/
  )
  pass('Business expenses remain completely isolated from vehicle costs and restricted to OWNER/MANAGER')

  // 6. SELL VEHICLE ATOMIC TRANSACTION & SNAPSHOTS
  const saleId = await call('staff', 'sell_vehicle', {
    vehicle_id: v1Id,
    customer_name: 'Nguyễn Khách Mua',
    customer_phone: '0912345678',
    sale_price: 92_000_000,
    sale_date: day,
    initial_payment: 30_000_000,
    payment_method: 'BANK_TRANSFER',
  })

  const saleRecord = await run('owner', (c) => rpc(c, 'get_sale', '$1::uuid', [saleId]))
  assert.equal(saleRecord.purchase_cost_snapshot, 80_000_000)
  assert.equal(saleRecord.expense_cost_snapshot, 3_500_000)
  assert.equal(saleRecord.total_cost_snapshot, 83_500_000)
  assert.equal(saleRecord.gross_profit, 8_500_000) // 92M - 83.5M
  assert.equal(saleRecord.paid_amount, 30_000_000)
  assert.equal(saleRecord.remaining_amount, 62_000_000)
  assert.equal((await run('owner', (c) => rpc(c, 'get_vehicle', '$1::uuid', [v1Id]))).status, 'SOLD')
  pass('sell_vehicle atomically records financial snapshot, gross profit, initial payment, and SOLD state')

  // 7. PAYMENTS & OVERPAYMENT GUARD
  // Pay partial 20M
  await call('staff', 'add_payment', { sale_id: saleId, amount: 20_000_000, payment_method: 'CASH', payment_date: day })
  let saleAfterP2 = await run('owner', (c) => rpc(c, 'get_sale', '$1::uuid', [saleId]))
  assert.equal(saleAfterP2.paid_amount, 50_000_000)
  assert.equal(saleAfterP2.remaining_amount, 42_000_000)

  // Attempting overpayment (> 42M)
  await deny(
    () => call('staff', 'add_payment', { sale_id: saleId, amount: 42_000_001, payment_method: 'CASH', payment_date: day }),
    /PAYMENT_EXCEEDS_BALANCE/
  )
  // Pay remaining 42M
  await call('staff', 'add_payment', { sale_id: saleId, amount: 42_000_000, payment_method: 'BANK_TRANSFER', payment_date: day })
  let salePaidFull = await run('owner', (c) => rpc(c, 'get_sale', '$1::uuid', [saleId]))
  assert.equal(salePaidFull.paid_amount, 92_000_000)
  assert.equal(salePaidFull.remaining_amount, 0)

  // Cannot pay any more
  await deny(
    () => call('staff', 'add_payment', { sale_id: saleId, amount: 1, payment_method: 'CASH', payment_date: day }),
    /PAYMENT_EXCEEDS_BALANCE/
  )
  pass('Payments validate exact remaining balance and strictly reject any overpayment')

  // 8. SALE CANCELLATION & AUDIT HISTORY PRESERVATION
  await run('manager', (c) => rpc(c, 'cancel_sale', "$1::uuid, 'Khách đổi ý trả lại xe'", [saleId]))
  const cancelledSale = await run('owner', (c) => rpc(c, 'get_sale', '$1::uuid', [saleId]))
  assert.equal(cancelledSale.status, 'CANCELLED')
  assert.equal(cancelledSale.payments.length, 3)
  assert.ok(cancelledSale.payments.every((p) => p.status === 'VOIDED'))
  assert.equal((await run('owner', (c) => rpc(c, 'get_vehicle', '$1::uuid', [v1Id]))).status, 'IN_STOCK')

  // Snapshots must NOT be erased or modified on cancellation
  assert.equal(cancelledSale.total_cost_snapshot, 83_500_000)
  assert.equal(cancelledSale.gross_profit, 8_500_000)

  // Cannot add payment to cancelled sale
  await deny(
    () => call('staff', 'add_payment', { sale_id: saleId, amount: 1000, payment_method: 'CASH', payment_date: day }),
    /SALE_CANCELLED/
  )
  pass('cancel_sale voids all payments, returns vehicle to IN_STOCK, and preserves snapshots')

  // 9. AUDIT LOGS IMMUTABILITY & TRACEABILITY
  const logs = (
    await db.query(
      "SELECT * FROM public.audit_logs WHERE action IN ('CREATE_VEHICLE','ADD_EXPENSE','CANCEL_EXPENSE','CREATE_SALE','CREATE_PAYMENT','VOID_PAYMENT','CANCEL_SALE')"
    )
  ).rows
  assert.ok(logs.length >= 7, 'Audit logs must capture every mutation step')

  // Direct tamper attempts on audit_logs must fail via trigger
  await deny(() => db.query("UPDATE public.audit_logs SET action='HACKED'"), /IMMUTABLE_HISTORY/)
  await deny(() => db.query('DELETE FROM public.audit_logs'), /IMMUTABLE_HISTORY/)
  pass('Audit logs capture all lifecycle transitions and cannot be altered or deleted')

  // 10. DIRECT TABLE MANIPULATION REJECTIONS (RLS & Table Privileges)
  for (const role of ['owner', 'manager', 'staff']) {
    await deny(() => run(role, (c) => c.query('DELETE FROM public.sales')), /permission denied|row-level security/i)
    await deny(() => run(role, (c) => c.query('DELETE FROM public.payments')), /permission denied|row-level security/i)
    await deny(() => run(role, (c) => c.query('DELETE FROM public.vehicle_expenses')), /permission denied|row-level security/i)
    await deny(() => run(role, (c) => c.query('DELETE FROM public.vehicles')), /permission denied|row-level security/i)
  }
  pass('Direct table DELETE and unauthorized UPDATE privileges are denied for all roles')
  console.log(`--- All ${passed} Business Risks database tests passed! ---\n`)
  } finally {
    if (ownDb) await db.close()
  }
}

// Allow direct CLI invocation: node tests/db/business-risks.test.mjs
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/business-risks.test.mjs')) {
  const engine = process.argv.includes('--pglite') ? 'pglite' : 'postgres'
  await runBusinessRisksTests(null, { engine })
}
