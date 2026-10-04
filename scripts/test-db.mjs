import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from './db-harness.mjs'
import { runMigrationTests } from '../tests/db/migration.test.mjs'
import { runBusinessRisksTests } from '../tests/db/business-risks.test.mjs'
import { runOperationalTests } from '../tests/db/operational-features.test.mjs'
import { runAuthSecurityTests } from '../tests/db/auth-security.test.mjs'
import { runKnowledgeTests } from '../tests/db/knowledge.test.mjs'
import { runCopilotGapTests } from '../tests/db/copilot-gaps.test.mjs'
import { runIdentityDocumentTests } from '../tests/db/identity-documents.test.mjs'
import { runShowroomTests } from '../tests/db/showroom.test.mjs'
import { runHardDeleteTests } from '../tests/db/hard-delete.test.mjs'
import { runNotificationsTests } from '../tests/db/notifications.test.mjs'

const engine = process.argv.includes('--pglite') ? 'pglite' : 'postgres'
console.log(`Database integration suite: ${engine} (disposable database; no cloud credentials)`)
await runMigrationTests({ engine })
await runBusinessRisksTests(null, { engine })
await runOperationalTests(null, { engine })
await runAuthSecurityTests({ engine })
await runKnowledgeTests(null, { engine })
await runCopilotGapTests(null, { engine })
await runIdentityDocumentTests(null, { engine })
await runShowroomTests(null, { engine })
await runHardDeleteTests(null, { engine })
await runNotificationsTests(null, { engine })
const db = await createDatabase({ engine })
let passed = 0
const users = Object.fromEntries(['owner', 'manager', 'financialManager', 'staff', 'disabled'].map((role) => [role, randomUUID()]))
const run = (user, fn) => asUser(db, users[user], fn)
const call = (user, name, data) => run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/i) => assert.rejects(operation, expression)
async function test(name, operation) {
  await operation()
  passed += 1
  console.log(`PASS ${passed}. ${name}`)
}
let day, vehicleId, saleId, expenseId
const vehicle = (overrides = {}) => ({ brand: 'Honda', model: 'SH 160', license_plate: 'TEST-ONLY', purchase_date: day, purchase_price: 80_000_000, asking_price: 90_000_000, ...overrides })
const sale = (id, overrides = {}) => ({ vehicle_id: id, customer_name: 'Khách kiểm thử', customer_phone: '0000000000', sale_price: 90_000_000, sale_date: day, initial_payment: 20_000_000, payment_method: 'CASH', ...overrides })
const expense = (id, amount = 1_200_000) => ({ vehicle_id: id, expense_type: 'REPAIR', description: 'Chi phí kiểm thử', amount, expense_date: day })
const getVehicle = (user, id) => run(user, (client) => rpc(client, 'get_vehicle', '$1::uuid', [id]))
const getSale = (user, id) => run(user, (client) => rpc(client, 'get_sale', '$1::uuid', [id]))
const addExpense = (user, id, amount) => run(user, (client) => rpc(client, 'save_expense', "'vehicle', $1::jsonb", [JSON.stringify(expense(id, amount))]))

try {
  day = (await row('SELECT private.today()::text AS day')).day
  for (const [name, id] of Object.entries(users)) {
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${name}@example.test`, JSON.stringify({ full_name: name, role: 'OWNER', active: true })])
  }

  await test('User-editable auth metadata cannot create an active OWNER', async () => {
    const profiles = (await db.query('SELECT role,active FROM public.profiles')).rows
    assert.equal(profiles.length, 5)
    assert.ok(profiles.every((profile) => profile.role === 'STAFF'))
  })
  for (const [name, id] of Object.entries(users)) {
    const role = name === 'financialManager' ? 'MANAGER' : name === 'disabled' ? 'STAFF' : name.toUpperCase()
    await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2,can_view_financials=$3 WHERE id=$4', [role, name !== 'disabled', name === 'financialManager', id])
  }
  await test('OWNER creates a vehicle; actor and inventory state come from the session', async () => {
    vehicleId = await call('owner', 'save_vehicle', vehicle({ created_by: users.staff }))
    const actual = await getVehicle('owner', vehicleId)
    assert.equal(actual.purchase_price, 80_000_000)
    assert.equal(actual.total_cost, 80_000_000)
    assert.equal(actual.status, 'IN_STOCK')
    assert.equal(actual.created_by, users.owner)
    assert.match(actual.internal_code, /^XE-\d{4}-\d+$/)
  })
  await test('Anonymous role cannot read business data or invoke privileged RPCs', async () => {
    await deny(() => asUser(db, null, (client) => client.query('SELECT * FROM public.vehicles'), 'anon'))
    await deny(() => asUser(db, null, (client) => rpc(client, 'list_vehicles'), 'anon'))
    await deny(() => asUser(db, null, (client) => rpc(client, 'save_vehicle', '$1::jsonb', [JSON.stringify(vehicle())]), 'anon'))
  })
  await test('All browser roles are denied direct financial/business writes and hard deletes', async () => {
    for (const user of ['owner', 'manager', 'staff']) {
      await deny(() => run(user, (client) => client.query("UPDATE public.vehicles SET status='SOLD' WHERE id=$1", [vehicleId])))
      await deny(() => run(user, (client) => client.query('DELETE FROM public.sales')))
      await deny(() => run(user, (client) => client.query('DELETE FROM public.payments')))
      await deny(() => run(user, (client) => client.query('DELETE FROM public.vehicle_expenses')))
      await deny(() => run(user, (client) => client.query("UPDATE public.profiles SET role='OWNER'")))
    }
  })
  await test('Sensitive costs are absent in RPCs and filtered by table RLS for STAFF and ordinary MANAGER', async () => {
    for (const user of ['staff', 'manager']) {
      const actual = await getVehicle(user, vehicleId)
      assert.equal(Object.hasOwn(actual, 'purchase_price'), false)
      assert.equal(Object.hasOwn(actual, 'total_cost'), false)
      const direct = await run(user, (client) => client.query('SELECT * FROM public.vehicle_financials'))
      assert.equal(direct.rows.length, 0)
      await deny(() => call(user, 'save_vehicle', vehicle()))
    }
    assert.equal((await getVehicle('financialManager', vehicleId)).purchase_price, 80_000_000)
    assert.equal((await getVehicle('owner', vehicleId)).purchase_price, 80_000_000)
  })
  await test('Disabled users lose RPC and table access even with an existing identity token', async () => {
    await deny(() => call('disabled', 'list_vehicles', {}))
    await deny(() => call('disabled', 'save_vehicle', vehicle()))
    assert.equal((await run('disabled', (client) => client.query('SELECT * FROM public.vehicles'))).rows.length, 0)
    assert.equal((await run('disabled', (client) => client.query('SELECT * FROM public.vehicle_financials'))).rows.length, 0)
  })
  await test('STAFF cannot create expenses or escalate roles', async () => {
    assert.equal((await call('staff', 'list_vehicles', {})).total, 1)
    await deny(() => addExpense('staff', vehicleId, 1_200_000))
    await deny(() => run('staff', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [users.staff, '{"role":"OWNER"}'])))
    await deny(() => run('staff', (client) => rpc(client, 'list_profiles')))
    await deny(() => call('staff', 'list_audit', {}))
    await deny(() => call('manager', 'save_settings', { store_name: 'Unauthorized' }))
  })
  await test('Operational vehicle entry with unknown purchase cost blocks a sale', async () => {
    const pending = await call('staff', 'save_vehicle', vehicle({ purchase_price: undefined }))
    assert.equal((await getVehicle('staff', pending)).cost_pending, true)
    await deny(() => call('staff', 'sell_vehicle', sale(pending)), /PURCHASE_COST_REQUIRED/)
    assert.equal((await getVehicle('owner', pending)).purchase_price, null)
  })
  await test('Total cost derives only from ACTIVE vehicle expenses; business expenses remain separate', async () => {
    expenseId = await addExpense('manager', vehicleId, 1_200_000)
    await addExpense('owner', vehicleId, 800_000)
    await addExpense('owner', vehicleId, 300_000)
    const cancelled = await addExpense('owner', vehicleId, 7_000_000)
    await run('owner', (client) => rpc(client, 'cancel_expense', "'vehicle',$1::uuid,'Sai phiếu nhập'", [cancelled]))
    await run('manager', (client) => rpc(client, 'save_expense', "'business',$1::jsonb", [JSON.stringify({ category: 'RENT', description: 'Mặt bằng kiểm thử', amount: 5_000_000, expense_date: day })]))
    const actual = await getVehicle('owner', vehicleId)
    assert.equal(actual.total_cost, 82_300_000)
    assert.equal(actual.expense_total, 2_300_000)
  })
  await test('Database rejects fractional, negative and oversized money', async () => {
    for (const amount of [-1, 1.5, '1e7', 1_000_000_000_001]) await deny(() => addExpense('owner', vehicleId, amount), /INVALID_MONEY|check constraint/)
    await deny(() => call('owner', 'save_vehicle', vehicle({ asking_price: -1 })), /INVALID_MONEY/)
  })
  await test('A late audit failure rolls back sale, snapshot, payment and vehicle status together', async () => {
    const id = await call('owner', 'save_vehicle', vehicle())
    const before = await row('SELECT (SELECT count(*) FROM public.sales) AS sales,(SELECT count(*) FROM public.payments) AS payments,(SELECT count(*) FROM public.sale_financials) AS snapshots,(SELECT count(*) FROM public.audit_logs) AS audits')
    await db.exec("CREATE FUNCTION private.test_reject_sale_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CREATE_SALE' THEN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_reject_sale_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION private.test_reject_sale_audit();")
    try { await deny(() => call('staff', 'sell_vehicle', sale(id)), /TEST_AUDIT_FAILURE/) }
    finally { await db.exec('DROP TRIGGER test_reject_sale_audit ON public.audit_logs; DROP FUNCTION private.test_reject_sale_audit()') }
    const after = await row('SELECT (SELECT count(*) FROM public.sales) AS sales,(SELECT count(*) FROM public.payments) AS payments,(SELECT count(*) FROM public.sale_financials) AS snapshots,(SELECT count(*) FROM public.audit_logs) AS audits')
    assert.deepEqual(after, before)
    assert.equal((await getVehicle('owner', id)).status, 'IN_STOCK')
  })
  await test('A sale atomically stores accurate cost snapshots, gross profit, payment and SOLD state', async () => {
    saleId = await call('staff', 'sell_vehicle', sale(vehicleId))
    const actual = await getSale('owner', saleId)
    assert.equal(actual.purchase_cost_snapshot, 80_000_000)
    assert.equal(actual.expense_cost_snapshot, 2_300_000)
    assert.equal(actual.total_cost_snapshot, 82_300_000)
    assert.equal(actual.gross_profit, 7_700_000)
    assert.equal(actual.paid_amount, 20_000_000)
    assert.equal(actual.remaining_amount, 70_000_000)
    assert.equal(actual.sold_by, users.staff)
    assert.equal((await getVehicle('owner', vehicleId)).status, 'SOLD')
  })
  await test('A sold vehicle cannot be sold again or have its original costs changed', async () => {
    await deny(() => call('staff', 'sell_vehicle', sale(vehicleId)), /VEHICLE_NOT_AVAILABLE/)
    await deny(() => addExpense('owner', vehicleId, 999), /VEHICLE_EXPENSE_LOCKED/)
    await deny(() => run('owner', (client) => rpc(client, 'save_expense', "'vehicle',$1::jsonb,$2::uuid", ['{"amount":999}', expenseId])), /VEHICLE_EXPENSE_LOCKED/)
    await deny(() => run('owner', (client) => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', ['{"purchase_price":1}', vehicleId])), /SOLD_VEHICLE_LOCKED/)
    await deny(() => db.query('UPDATE public.sale_financials SET purchase_cost_snapshot=1 WHERE sale_id=$1', [saleId]), /IMMUTABLE_HISTORY/)
    assert.equal((await getSale('owner', saleId)).gross_profit, 7_700_000)
  })
  await test('STAFF and ordinary MANAGER cannot see historical profit through direct tables, detail or reports', async () => {
    for (const user of ['staff', 'manager']) {
      assert.equal(Object.hasOwn(await getSale(user, saleId), 'gross_profit'), false)
      assert.equal((await run(user, (client) => client.query('SELECT * FROM public.sale_financials'))).rows.length, 0)
      await deny(() => run(user, (client) => rpc(client, 'report', "'profit','{}'::jsonb")))
    }
    assert.equal((await getSale('financialManager', saleId)).gross_profit, 7_700_000)
  })
  await test('Payment balances are exact; zero, overpayment and invalid payment methods are rejected', async () => {
    await call('staff', 'add_payment', { sale_id: saleId, amount: 30_000_000, payment_method: 'BANK_TRANSFER', payment_date: day })
    assert.equal((await getSale('owner', saleId)).remaining_amount, 40_000_000)
    await deny(() => call('staff', 'add_payment', { sale_id: saleId, amount: 40_000_001, payment_method: 'CASH' }), /PAYMENT_EXCEEDS_BALANCE/)
    await deny(() => call('staff', 'add_payment', { sale_id: saleId, amount: 0, payment_method: 'CASH' }), /PAYMENT_EXCEEDS_BALANCE/)
    await deny(() => call('staff', 'add_payment', { sale_id: saleId, amount: 1, payment_method: 'BAD' }), /invalid input value for enum/)
    assert.equal((await getSale('owner', saleId)).paid_amount, 50_000_000)
  })
  await test('Sales reports and dashboard totals use completed sale prices, not cash collected', async () => {
    const dashboard = await run('owner', (client) => rpc(client, 'dashboard', '$1::date,$1::date', [day]))
    assert.equal(dashboard.revenue, 90_000_000)
    assert.equal(dashboard.gross_profit, 7_700_000)
    assert.equal(dashboard.sales_count, 1)
    const report = await run('owner', (client) => rpc(client, 'report', "'sales',$1::jsonb", [JSON.stringify({ from: day, to: day })]))
    assert.equal(report.total, 1)
  })
  await test('Sale cancellation requires privilege and preserves voided payments and immutable snapshots', async () => {
    await deny(() => run('staff', (client) => rpc(client, 'cancel_sale', "$1::uuid,'Nhập nhầm phiếu'", [saleId])))
    await run('manager', (client) => rpc(client, 'cancel_sale', "$1::uuid,'Nhập nhầm phiếu'", [saleId]))
    const actual = await getSale('owner', saleId)
    assert.equal(actual.status, 'CANCELLED')
    assert.ok(actual.payments.length >= 2)
    assert.ok(actual.payments.every((payment) => payment.status === 'VOIDED'))
    assert.equal((await getVehicle('owner', vehicleId)).status, 'IN_STOCK')
    assert.equal(actual.gross_profit, 7_700_000)
    await deny(() => call('staff', 'add_payment', { sale_id: saleId, amount: 1, payment_method: 'CASH' }), /SALE_CANCELLED/)
    assert.equal((await run('owner', (client) => rpc(client, 'dashboard', '$1::date,$1::date', [day]))).revenue, 0)
  })
  await test('A cancelled sale can be replaced while the previous snapshot remains unchanged', async () => {
    await addExpense('owner', vehicleId, 100_000)
    const replacement = await call('owner', 'sell_vehicle', sale(vehicleId, { initial_payment: 0 }))
    assert.equal((await getSale('owner', replacement)).total_cost_snapshot, 82_400_000)
    assert.equal((await getSale('owner', saleId)).total_cost_snapshot, 82_300_000)
    assert.equal(Number((await row("SELECT count(*) AS count FROM public.sales WHERE vehicle_id=$1 AND status='COMPLETED'", [vehicleId])).count), 1)
  })
  await test('Audit history includes actors and before/after data, and cannot be rewritten', async () => {
    const logs = (await db.query("SELECT * FROM public.audit_logs WHERE action IN ('CREATE_SALE','CANCEL_SALE','VOID_PAYMENT','ADD_EXPENSE')")).rows
    assert.ok(logs.some((log) => log.action === 'CREATE_SALE' && log.user_id === users.staff))
    assert.ok(logs.some((log) => log.action === 'CANCEL_SALE' && log.old_data.status === 'COMPLETED' && log.new_data.status === 'CANCELLED'))
    await deny(() => db.exec("UPDATE public.audit_logs SET action='TAMPERED'"), /IMMUTABLE_HISTORY/)
    assert.equal((await run('staff', (client) => client.query('SELECT * FROM public.audit_logs'))).rows.length, 0)
  })
  await test('Last active OWNER cannot be disabled or demoted', async () => {
    await deny(() => run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [users.owner, '{"active":false}'])), /LAST_OWNER_REQUIRED/)
    await deny(() => run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [users.owner, '{"role":"STAFF"}'])), /LAST_OWNER_REQUIRED/)
  })
  await test('Security-definer functions use fixed search paths and private mutation helpers are inaccessible', async () => {
    const functions = (await db.query("SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prosecdef")).rows
    assert.ok(functions.length > 10)
    assert.ok(functions.every((fn) => fn.proconfig?.some((value) => value.startsWith('search_path='))))
    await deny(() => run('staff', (client) => client.query("SELECT private.audit('TAMPER','vehicles',$1::uuid,null,null)", [vehicleId])))
  })
  await test('Private image uploads and reads enforce role, vehicle path, registration and soft deletion', async () => {
    const id = await call('owner', 'save_vehicle', vehicle())
    const path = `${id}/${randomUUID()}.jpg`
    const upload = (user, objectPath) => run(user, (client) => client.query("INSERT INTO storage.objects(bucket_id,name) VALUES('vehicle-images',$1)", [objectPath]))
    for (const user of ['disabled']) await deny(() => upload(user, path))
    await deny(() => upload('staff', `${randomUUID()}/${randomUUID()}.jpg`))
    await deny(() => upload('staff', `${id}/${randomUUID()}.html`))
    await upload('staff', path)
    assert.equal((await run('staff', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 0)
    await deny(() => run('disabled', (client) => rpc(client, 'register_vehicle_image', '$1::uuid,$2', [id, path])))
    const image = await run('staff', (client) => rpc(client, 'register_vehicle_image', '$1::uuid,$2', [id, path]))
    assert.equal((await getVehicle('staff', id)).images.length, 1)
    assert.equal((await run('staff', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 1)
    assert.equal((await run('disabled', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 0)
    assert.equal((await asUser(db, null, (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]), 'anon')).rows.length, 0)
    const deleted = await run('staff', (client) => client.query('DELETE FROM storage.objects WHERE name=$1 RETURNING id', [path]))
    assert.equal(deleted.rows.length, 0)
    await run('staff', (client) => rpc(client, 'remove_vehicle_image', '$1::uuid', [image]))
    assert.equal((await getVehicle('owner', id)).images.length, 0)
    assert.equal((await run('owner', (client) => client.query('SELECT * FROM storage.objects WHERE name=$1', [path]))).rows.length, 0)
    assert.equal(Number((await row('SELECT count(*) AS count FROM storage.objects WHERE name=$1', [path])).count), 1)
  })
  await test('Cost sorting and dashboard cannot disclose restricted financial data', async () => {
    for (const user of ['staff', 'manager']) await deny(() => call(user, 'list_vehicles', { sort: 'highest_cost' }))
    const dashboard = await run('staff', (client) => rpc(client, 'dashboard'))
    for (const field of ['inventory_cost', 'today_revenue', 'month_revenue', 'revenue', 'today_profit', 'month_profit', 'gross_profit', 'business_expenses']) assert.equal(dashboard[field], null)
    assert.deepEqual(dashboard.top_profitable, [])
    const detail = await getVehicle('staff', vehicleId)
    assert.deepEqual(detail.expenses, [])
    assert.ok(detail.activity.every((entry) => !Object.hasOwn(entry, 'old_data') && !Object.hasOwn(entry, 'new_data') && !Object.hasOwn(entry, 'amount')))
  })
  await test('Purchase cost completion and missing inventory costs remain explicit', async () => {
    const before = await run('owner', (client) => rpc(client, 'dashboard'))
    assert.ok(before.inventory_cost_pending > 0)
    assert.equal(before.inventory_cost, null)
    const pending = (await call('owner', 'list_vehicles', {})).items.find((item) => item.cost_pending)
    await run('financialManager', (client) => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', ['{"purchase_price":42000000}', pending.id]))
    assert.equal((await getVehicle('owner', pending.id)).cost_pending, false)
    assert.equal((await getVehicle('owner', pending.id)).total_cost, 42_000_000)
    const after = await run('owner', (client) => rpc(client, 'dashboard'))
    assert.equal(after.inventory_cost_pending, 0)
    assert.equal(typeof after.inventory_cost, 'number')
  })

  if (db.connection) await concurrencyTests()
  else console.log('SKIP concurrency: PGlite is single-session. Run without --pglite for multi-session PostgreSQL races.')
  console.log(`\n${passed} database integration checks passed on ${engine}.`)
} catch (error) {
  // Record the failure instead of letting the finally-block exit swallow it.
  console.error(error)
  process.exitCode = 1
} finally {
  await db.close()
  // Embedded-postgres handles can keep the event loop alive after close(); exit
  // explicitly, but propagate the recorded status so CI sees real failures.
  process.exit(process.exitCode ?? 0)
}

async function concurrencyTests() {
  // The first transaction remains open; pg_stat_activity verifies that the second
  // session is truly blocked on a PostgreSQL lock before the first commits.
  async function interleave(first, second, secondSucceeds, secondUser = users.staff) {
    const a = await db.connection()
    const b = await db.connection()
    let pending
    try {
      await a.exec('BEGIN')
      const firstResult = await asUser(a, users.owner, first)
      pending = asUser(b, secondUser, second).then((value) => ({ value }), (error) => ({ error }))
      let blocked = false
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await db.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()")
        if (Number(result.rows[0].count) > 0) { blocked = true; break }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(blocked, true, 'Second session must be blocked on an actual database lock')
      await a.exec('COMMIT')
      const outcome = await pending
      if (secondSucceeds) { if (outcome.error) throw outcome.error }
      else assert.ok(outcome.error, 'Second operation must fail after lock release')
      return { first: firstResult, second: outcome }
    } finally {
      await a.exec('ROLLBACK').catch(() => {})
      if (pending) await pending
      await a.close()
      await b.close()
    }
  }
  await test('Two concurrent sales serialize on the vehicle: exactly one sale succeeds', async () => {
    const id = await call('owner', 'save_vehicle', vehicle())
    const input = JSON.stringify(sale(id, { initial_payment: 0 }))
    const result = await interleave((client) => rpc(client, 'sell_vehicle', '$1::jsonb', [input]), (client) => rpc(client, 'sell_vehicle', '$1::jsonb', [input]), false)
    assert.match(result.second.error.message, /VEHICLE_NOT_AVAILABLE/)
    assert.equal(Number((await row('SELECT count(*) AS count FROM public.sales WHERE vehicle_id=$1', [id])).count), 1)
  })
  await test('Concurrent payments cannot jointly overpay the remaining balance', async () => {
    const id = await call('owner', 'save_vehicle', vehicle({ purchase_price: 50, asking_price: 100 }))
    const sold = await call('owner', 'sell_vehicle', sale(id, { sale_price: 100, initial_payment: 0 }))
    const input = JSON.stringify({ sale_id: sold, amount: 60, payment_method: 'CASH', payment_date: day })
    const result = await interleave((client) => rpc(client, 'add_payment', '$1::jsonb', [input]), (client) => rpc(client, 'add_payment', '$1::jsonb', [input]), false)
    assert.match(result.second.error.message, /PAYMENT_EXCEEDS_BALANCE/)
    assert.equal((await getSale('owner', sold)).paid_amount, 60)
  })
  await test('A sale waits for an in-flight expense and includes its committed cost snapshot', async () => {
    const id = await call('owner', 'save_vehicle', vehicle())
    const result = await interleave((client) => rpc(client, 'save_expense', "'vehicle',$1::jsonb", [JSON.stringify(expense(id, 900_000))]), (client) => rpc(client, 'sell_vehicle', '$1::jsonb', [JSON.stringify(sale(id))]), true)
    assert.equal((await getSale('owner', result.second.value)).total_cost_snapshot, 80_900_000)
  })
  await test('Payment submitted while cancellation is in flight fails after cancellation commits', async () => {
    const id = await call('owner', 'save_vehicle', vehicle())
    const sold = await call('owner', 'sell_vehicle', sale(id, { initial_payment: 0 }))
    const result = await interleave((client) => rpc(client, 'cancel_sale', "$1::uuid,'Hủy kiểm thử đồng thời'", [sold]), (client) => rpc(client, 'add_payment', '$1::jsonb', [JSON.stringify({ sale_id: sold, amount: 1, payment_method: 'CASH' })]), false)
    assert.match(result.second.error.message, /SALE_CANCELLED/)
    assert.equal(Number((await row('SELECT count(*) AS count FROM public.payments WHERE sale_id=$1', [sold])).count), 0)
  })
  await test('Raw second-owner writes are rejected while an active OWNER exists', async () => {
    const secondOwner = randomUUID()
    await db.query("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,'second-owner@example.test','{\"full_name\":\"Second Owner\"}')", [secondOwner])
    await assert.rejects(
      run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [secondOwner, '{"role":"OWNER","active":true}'])),
      /SINGLE_OWNER_REQUIRED/,
    )
    await assert.rejects(
      run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [users.owner, '{"role":"MANAGER"}'])),
      /LAST_OWNER_REQUIRED/,
    )
    assert.equal(Number((await row("SELECT count(*) AS count FROM public.profiles WHERE role='OWNER' AND active")).count), 1)
  })
  await test('Ownership handover serializes against concurrent role mutations and retains one active OWNER', async () => {
    // The in-flight transfer holds the shared advisory lock; the manager's
    // demotion attempt queues behind it and then sees the committed handover
    // (the ex-owner is now MANAGER, so a junior-only manager is denied).
    const result = await interleave(
      (client) => rpc(client, 'transfer_ownership', '$1::uuid', [users.staff]),
      (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [users.owner, '{"role":"MANAGER"}']),
      false, users.manager,
    )
    assert.match(result.second.error.message, /ACCESS_DENIED|LAST_OWNER_REQUIRED/)
    const owners = await row("SELECT count(*) AS count FROM public.profiles WHERE role='OWNER' AND active")
    assert.equal(Number(owners.count), 1)
  })
}
