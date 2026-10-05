import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Only the repository's disposable database harness is used. No URLs or cloud keys.
export async function runOperationalTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'manager', 'financialManager', 'staff', 'disabled'].map(name => [name, randomUUID()]))
  const run = (name, operation) => asUser(db, users[name], operation)
  const call = (name, fn, input) => run(name, client => rpc(client, fn, '$1::jsonb', [JSON.stringify(input)]))
  const read = (name, fn, args = '', values = []) => run(name, client => rpc(client, fn, args, values))
  const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security/) => assert.rejects(operation, expression)
  const row = async (sql, values = []) => (await db.query(sql, values)).rows[0]
  let passed = 0
  const test = async (name, operation) => { await operation(); passed++; console.log(`PASS operational ${passed}. ${name}`) }
  try {
    const suite = randomUUID().slice(0, 8)
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${name}-${suite}@example.test`, JSON.stringify({ full_name: `Kiểm thử ${name}` })])
      const role = name === 'financialManager' ? 'MANAGER' : name === 'disabled' ? 'STAFF' : name.toUpperCase()
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2,can_view_financials=$3,must_change_password=false WHERE id=$4', [role, name !== 'disabled', name === 'financialManager', id])
    }
    const dates = await row("SELECT private.today()::text AS day, (private.today()-1)::text AS yesterday, (private.today()-2)::text AS older, (private.today()-100)::text AS intake, (private.today()+1)::text AS tomorrow")
    const { day, yesterday, older, intake, tomorrow } = dates
    let sequence = 0
    const vehicle = async (overrides = {}) => {
      sequence++
      return call('owner', 'save_vehicle', { brand: 'Honda', model: `Xe kiểm thử ${sequence}`, frame_number: `${suite}-FRAME-${sequence}`, engine_number: `${suite}-ENGINE-${sequence}`, license_plate: `${suite}-PLATE-${sequence}`, purchase_date: intake, purchase_price: 10_000_000, asking_price: 110_000_000, ...overrides })
    }
    const sale = async (price, date, initial = 0, overrides = {}) => {
      const vehicleId = await vehicle()
      const id = await call('staff', 'sell_vehicle', { vehicle_id: vehicleId, customer_name: 'Khách kiểm thử', customer_phone: `000${sequence.toString().padStart(7, '0')}`, sale_price: price, sale_date: date, initial_payment: initial, payment_method: 'CASH', ...overrides })
      return { id, vehicleId }
    }
    const unpaid = await sale(100_000_000, yesterday, 0, { due_date: yesterday })
    const partial = await sale(100_000_000, day, 30_000_000, { customer_name: 'Nguyễn Kiểm Thử', customer_phone: '090 000 1234', payment_method: 'BANK_TRANSFER' })
    const paid = await sale(20_000_000, day, 20_000_000, { customer_name: 'Nguyễn Kiểm Thử', customer_phone: '0910001234' })
    const oldDebt = await sale(60_000_000, older, 5_000_000)
    const historySale = await sale(90_000_000, yesterday, 10_000_000, { customer_name: 'Trần Kiểm Thử', customer_phone: '+84 90 000 1234' })
    const cancelled = await sale(40_000_000, day, 8_000_000, { payment_method: 'OTHER' })
    await read('manager', 'cancel_sale', '$1::uuid, $2::text', [cancelled.id, 'Giao dịch kiểm thử đã hủy'])
    await call('staff', 'add_payment', { sale_id: oldDebt.id, amount: 20_000_000, payment_method: 'CASH', payment_date: day })
    await call('staff', 'add_payment', { sale_id: historySale.id, amount: 15_000_000, payment_method: 'OTHER', payment_date: day })

    await test('receivables execute with unpaid, partial, paid and voided-payment cases', async () => {
      const data = await call('staff', 'list_receivables', { payment_status: 'ALL' })
      assert.equal(data.total, 5)
      assert.equal(data.items.find(s => s.id === unpaid.id).debt_status, 'OVERDUE')
      assert.equal(data.items.find(s => s.id === partial.id).debt_status, 'PARTIALLY_PAID')
      assert.equal(data.items.find(s => s.id === paid.id).debt_status, 'PAID')
      assert.ok(!data.items.some(s => s.id === cancelled.id))
      assert.equal(data.total_receivable, 270_000_000)
      assert.equal(data.total_overdue, 100_000_000)
    })
    await test('receivable totals cover the full filtered set beyond the current page', async () => {
      const first = await call('staff', 'list_receivables', { limit: 1, payment_status: 'DEBT_ONLY' })
      const second = await call('staff', 'list_receivables', { limit: 1, offset: 1, payment_status: 'DEBT_ONLY' })
      assert.equal(first.items.length, 1)
      assert.equal(first.total, 4)
      assert.equal(first.total_receivable, 270_000_000)
      assert.notEqual(first.items[0].id, second.items[0].id)
      assert.equal(first.items[0].remaining_amount, 100_000_000)
    })
    await test('debt date/search/state filters and invalid ranges are enforced', async () => {
      assert.equal((await call('staff', 'list_receivables', { payment_status: 'PAID' })).total, 1)
      assert.equal((await call('staff', 'list_receivables', { payment_status: 'UNPAID' })).total, 1)
      assert.equal((await call('staff', 'list_receivables', { payment_status: 'ALL', from: day, to: day })).total, 2)
      assert.equal((await call('staff', 'list_receivables', { search: '090 000 1234' })).total, 1)
      await deny(() => call('staff', 'list_receivables', { from: day, to: yesterday }), /INVALID_DATE_RANGE/)
      await deny(() => call('staff', 'list_receivables', { payment_status: 'UNKNOWN' }), /INVALID_PAYMENT_STATUS/)
    })
    await test('due-date changes are audited, constrained and rejected for inactive users/cancelled sale', async () => {
      const changed = await read('staff', 'update_sale_due_date', '$1::uuid, $2::date', [partial.id, day])
      assert.equal(changed.due_date, day)
      assert.equal(changed.is_overdue, false)
      await deny(() => read('staff', 'update_sale_due_date', '$1::uuid, $2::date', [partial.id, yesterday]), /INVALID_DUE_DATE/)
      await deny(() => read('disabled', 'update_sale_due_date', '$1::uuid, $2::date', [partial.id, day]))
      await deny(() => read('staff', 'update_sale_due_date', '$1::uuid, $2::date', [cancelled.id, day]), /SALE_NOT_ACTIVE/)
      assert.equal(Number((await row("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='UPDATE_SALE_DUE_DATE'", [partial.id])).n), 1)
    })
    await test('daily reconciliation distinguishes sales revenue from new-sale and older debt receipts', async () => {
      const data = await read('manager', 'daily_reconciliation', '$1::date', [day])
      assert.equal(data.sales_revenue, 120_000_000)
      assert.equal(data.sales_count, 2)
      assert.equal(data.today_sales_collected, 50_000_000)
      assert.equal(data.debt_collected_today, 35_000_000)
      assert.equal(data.total_collected, 85_000_000)
      assert.equal(data.cash_collected, 40_000_000)
      assert.equal(data.bank_transfer_collected, 30_000_000)
      assert.equal(data.other_collected, 15_000_000)
      assert.equal(data.new_debt_created, 70_000_000)
      assert.equal(data.payments.length, 4)
      assert.ok(!data.payments.some(p => p.sale_id === cancelled.id))
    })
    await test('historical day detail excludes later payments from collected/debt-at-day values', async () => {
      const data = await read('owner', 'daily_reconciliation', '$1::date', [yesterday])
      const detail = data.sales.find(s => s.id === historySale.id)
      assert.equal(detail.paid_amount, 10_000_000)
      assert.equal(detail.remaining_amount, 80_000_000)
      assert.equal(data.new_debt_created, 180_000_000)
      assert.equal(data.total_collected, 10_000_000)
      assert.equal((await read('owner', 'get_sale', '$1::uuid', [historySale.id])).remaining_amount, 65_000_000)
    })
    const expenseVehicle = await vehicle()
    await read('manager', 'save_expense', "'vehicle', $1::jsonb", [JSON.stringify({ vehicle_id: expenseVehicle, expense_type: 'REPAIR', description: 'Chi phí xe kiểm thử', amount: 2_000_000, expense_date: day })])
    await read('manager', 'save_expense', "'business', $1::jsonb", [JSON.stringify({ category: 'RENT', description: 'Chi phí cửa hàng kiểm thử', amount: 3_000_000, expense_date: day })])
    await test('reconciliation includes independent business/vehicle expenses', async () => {
      const data = await read('manager', 'daily_reconciliation', '$1::date', [day])
      assert.equal(data.business_expenses, 3_000_000)
      assert.equal(data.vehicle_expenses, 2_000_000)
      assert.equal(data.total_expenses, 5_000_000)
      assert.equal(data.net_cash_movement, 80_000_000)
      assert.equal(data.expenses.length, 2)
    })
    await test('reconciliation enforces roles and business date regardless of database timezone', async () => {
      for (const user of ['staff', 'disabled']) await deny(() => read(user, 'daily_reconciliation', '$1::date', [day]))
      await deny(() => read('owner', 'daily_reconciliation', '$1::date', [tomorrow]), /FUTURE_DATE/)
      await db.exec("SET timezone = 'America/Los_Angeles'")
      assert.equal((await read('owner', 'daily_reconciliation')).date, day)
      const boundary = await row("SELECT (timestamptz '2026-09-30 17:00:00+00' AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS day")
      assert.equal(boundary.day, '2026-10-01')
      await db.exec("SET timezone = 'UTC'")
    })
    await test('dashboard actionable alert values use genuine current debt, cost pending and old stock', async () => {
      await vehicle({ purchase_price: null })
      const data = await read('staff', 'dashboard', '$1::date, $2::date', [older, day])
      assert.equal(data.unpaid_sales_count, 4)
      assert.equal(data.total_receivables, 270_000_000)
      assert.equal(data.overdue_sales_count, 1)
      assert.equal(data.inventory_cost_pending, 1)
      assert.ok(data.old_inventory_count >= 2)
    })
    await test('inventory indicator marks at-store stock (IN_STOCK+RESERVED) strictly below/above the thresholds', async () => {
      const atStore = async () => (await row("SELECT count(*)::int AS n FROM public.vehicles WHERE status IN ('IN_STOCK','RESERVED')")).n
      const indicatorFor = async () => (await read('staff', 'dashboard', '$1::date, $2::date', [older, day])).inventory_indicator
      const count = await atStore()
      // Boundary-accurate band: the count itself is NORMAL (both strict comparisons fail).
      await call('owner', 'save_settings', { low_stock_threshold: count, high_stock_threshold: count })
      assert.equal(await indicatorFor(), 'NORMAL')
      // One more at-store vehicle than the minimum flips nothing; one BELOW does.
      await call('owner', 'save_settings', { low_stock_threshold: count + 1, high_stock_threshold: 100_000 })
      assert.equal(await indicatorFor(), 'LOW')
      await call('owner', 'save_settings', { low_stock_threshold: count, high_stock_threshold: 100_000 })
      assert.equal(await indicatorFor(), 'NORMAL')
      // Reserved bikes count as at-store stock, not 'sẵn sàng bán'.
      const reservedVehicle = await vehicle({ purchase_date: yesterday })
      assert.equal(await atStore(), count + 1)
      await call('owner', 'save_settings', { low_stock_threshold: count + 1, high_stock_threshold: 100_000 })
      assert.equal(await indicatorFor(), 'NORMAL')
      await run('owner', client => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify({ status: 'RESERVED' }), reservedVehicle]))
      assert.equal(await indicatorFor(), 'NORMAL')
      // HIGH fires only strictly above the maximum threshold. At-store is now count + 1
      // (the reserved bike still counts), so the boundary is high = count + 1 → NORMAL.
      await call('owner', 'save_settings', { low_stock_threshold: 0, high_stock_threshold: count })
      assert.equal(await indicatorFor(), 'HIGH')
      await call('owner', 'save_settings', { low_stock_threshold: 0, high_stock_threshold: count + 1 })
      assert.equal(await indicatorFor(), 'NORMAL')
      // Remove the probe bike, then restore shipped defaults. The suite's small dataset
      // sits under the default minimum of 5, so the honest indicator is LOW.
      await run('owner', client => rpc(client, 'save_vehicle', '$1::jsonb,$2::uuid', [JSON.stringify({ status: 'CANCELLED' }), reservedVehicle]))
      assert.equal(await atStore(), count)
      await call('owner', 'save_settings', { low_stock_threshold: 5, high_stock_threshold: 100 })
      assert.equal(await indicatorFor(), count < 5 ? 'LOW' : 'NORMAL')
    })
    await test('dashboard old-stock and pending-cost links resolve matching inventory filters', async () => {
      const old = await call('staff', 'list_vehicles', { status: 'AVAILABLE', min_days: 61 })
      assert.ok(old.items.length >= 2)
      assert.ok(old.items.every(v => ['IN_STOCK', 'RESERVED'].includes(v.status)))
      const pending = await call('staff', 'list_vehicles', { status: 'AVAILABLE', cost_pending: true })
      assert.equal(pending.total, 1)
      assert.equal(pending.items[0].cost_pending, true)
      assert.ok((await call('staff', 'list_vehicles', { status: '', cost_pending: '', min_days: '' })).total > 0)
      await deny(() => call('staff', 'list_vehicles', { min_days: -1 }), /INVALID_STOCK_AGE/)
      await deny(() => call('staff', 'list_vehicles', { sort: 'highest_cost', min_days: 61 }), /FINANCIAL_ACCESS_DENIED/)
    })
    await test('customer phone normalization retains purchases/payments and warns shared numbers', async () => {
      const data = await call('staff', 'list_customers', { search: '+84 90 000 1234', limit: 1 })
      assert.equal(data.total, 1)
      assert.equal(data.items[0].purchases_count, 2)
      assert.equal(data.items[0].identity_warning, true)
      assert.equal(data.items[0].customer_names.length, 2)
      const history = await read('staff', 'get_customer_history', '$1::text', ['090-000-1234'])
      assert.equal(history.total_spent, 190_000_000)
      assert.equal(history.total_paid, 55_000_000)
      assert.equal(history.total_debt, 135_000_000)
      assert.equal(history.sales.length, 2)
      assert.equal(history.sales.reduce((sum, s) => sum + s.payments.length, 0), 3)
      assert.equal(history.identity_warning, true)
      assert.ok(history.sales.every(s => !('gross_profit' in s)))
    })
    await test('customer names alone never merge different phone numbers; totals survive pagination', async () => {
      const data = await call('staff', 'list_customers', { search: 'Nguyễn Kiểm Thử', limit: 1 })
      assert.equal(data.total, 2)
      assert.equal(data.items.length, 1)
      await deny(() => read('staff', 'get_customer_history', '$1::text', ['0009999999']), /CUSTOMER_NOT_FOUND/)
    })
    await test('global search executes all result groups and finds code/plate/frame/engine/brand/model/name/phone', async () => {
      const record = await read('staff', 'get_vehicle', '$1::uuid', [partial.vehicleId])
      for (const field of ['internal_code', 'license_plate', 'frame_number', 'engine_number', 'brand', 'model']) {
        const data = await read('staff', 'global_search', '$1::text, $2::integer', [record[field], 30])
        assert.ok(data.vehicles.some(v => v.id === record.id), `Missing ${field} search`)
      }
      const byName = await read('staff', 'global_search', '$1::text, $2::integer', ['Nguyễn Kiểm Thử', 10])
      assert.ok(byName.sales.some(s => s.id === partial.id))
      assert.equal(byName.customers.length, 2)
      const byPhone = await read('staff', 'global_search', '$1::text, $2::integer', ['+84 90 000 1234', 10])
      assert.equal(byPhone.customers.length, 1)
      assert.equal(byPhone.sales.length, 2)
    })
    await test('search limits and all restricted-cost fields are excluded even for OWNER', async () => {
      for (const user of ['owner', 'manager', 'staff']) {
        const data = await read(user, 'global_search', '$1::text, $2::integer', ['Honda', 1])
        assert.ok(data.vehicles.length <= 1 && data.customers.length <= 1 && data.sales.length <= 1)
        assert.doesNotMatch(JSON.stringify(data), /purchase_price|cost_snapshot|gross_profit|supplier_name|"notes"/)
      }
      assert.deepEqual(await read('staff', 'global_search', '$1::text', ['H']), { vehicles: [], customers: [], sales: [] })
      await deny(() => read('disabled', 'global_search', '$1::text', ['Honda']))
    })
    await test('sale receipt source has auditable staff names and masks internal financial fields by role', async () => {
      const data = await read('staff', 'get_sale', '$1::uuid', [partial.id])
      assert.equal(data.employee_name, 'Kiểm thử staff')
      assert.equal(data.payments[0].creator_name, 'Kiểm thử staff')
      assert.ok(!('gross_profit' in data))
      assert.equal((await read('owner', 'get_sale', '$1::uuid', [partial.id])).gross_profit, 90_000_000)
    })
    const importRow = (overrides = {}) => ({ frame_number: `${suite}-IMPORT-${randomUUID().slice(0, 8)}`, brand: 'Yamaha', model: 'Xe nhập thử', purchase_date: day, purchase_price: 12_000_000, asking_price: 15_000_000, ...overrides })
    await test('import server preview rejects negative/fractional/garbage money and malformed date/year/enum', async () => {
      // Brand and frame_number are optional as of migration 20261005000000,
      // so an empty brand must NOT be flagged as an error. Keep the other
      // invalid payloads and add a positive assertion for blank brand/frame.
      for (const values of [{ purchase_price: -1 }, { purchase_price: 1.2 }, { purchase_price: 'abc' }, { purchase_price: 1_000_000_000_001 }, { purchase_date: '2026-02-30' }, { purchase_date: '1/2/2026' }, { purchase_date: tomorrow }, { year: '2023abc' }, { year: 1800 }, { odometer: -5 }, { status: 'SOLD' }]) {
        const data = await call('owner', 'validate_import_vehicles', [importRow(values)])
        assert.ok(data.errors.length > 0, `Accepted invalid ${JSON.stringify(values)}`)
      }
      const blankBrand = await call('owner', 'validate_import_vehicles', [importRow({ brand: '' })])
      assert.equal(blankBrand.errors.length, 0, 'Empty brand should now be accepted')
      const blankFrame = await call('owner', 'validate_import_vehicles', [importRow({ frame_number: '' })])
      assert.equal(blankFrame.errors.length, 0, 'Empty frame should now be accepted')
      await deny(() => call('owner', 'validate_import_vehicles', {}), /INVALID_INPUT/)
      await deny(() => call('owner', 'validate_import_vehicles', Array.from({ length: 501 }, () => importRow())), /IMPORT_BATCH_TOO_LARGE/)
    })
    await test('import preview detects in-file duplicates and existing chassis, engine and plate case-insensitively', async () => {
      const record = await read('owner', 'get_vehicle', '$1::uuid', [partial.vehicleId])
      const existing = await call('owner', 'validate_import_vehicles', [importRow({ frame_number: record.frame_number.toLowerCase(), engine_number: record.engine_number.toLowerCase(), license_plate: record.license_plate.toLowerCase() })])
      assert.equal(existing.duplicates.length, 3)
      const a = importRow({ engine_number: 'ENGINE-CSV', license_plate: 'PLATE-CSV' })
      const data = await call('owner', 'validate_import_vehicles', [a, { ...a }])
      assert.equal(data.duplicates.length, 3)
      assert.ok(data.duplicates.every(d => d.index === 1))
      const plateVehicle = await vehicle({ license_plate: '43A1-123.45' })
      const punctuated = await call('owner', 'validate_import_vehicles', [importRow({ license_plate: '43a1 12345' })])
      assert.deepEqual(punctuated.duplicates.map(d => d.field), ['license_plate'])
      await deny(() => call('owner', 'import_vehicles', [importRow({ license_plate: '43a1 12345' })]), /DUPLICATE_IMPORT_VEHICLE/)
      const batchPlates = await call('owner', 'validate_import_vehicles', [importRow({ license_plate: '59B1-987.65' }), importRow({ license_plate: '59b1 98765' })])
      assert.deepEqual(batchPlates.duplicates.map(d => [d.index, d.field]), [[1, 'license_plate']])
      assert.equal((await read('owner', 'get_vehicle', '$1::uuid', [plateVehicle])).license_plate, '43A1-123.45')
    })
    await test('atomic import rejects invalid/duplicate data without partially creating inventory or audit', async () => {
      const a = importRow()
      const countBefore = Number((await row('SELECT count(*) AS n FROM public.vehicles')).n)
      const logsBefore = Number((await row('SELECT count(*) AS n FROM public.audit_logs')).n)
      await deny(() => call('owner', 'import_vehicles', [a, importRow({ year: 1800 })]), /INVALID_IMPORT_DATA/)
      await deny(() => call('owner', 'import_vehicles', [a, { ...a }]), /DUPLICATE_IMPORT_VEHICLE/)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.vehicles')).n), countBefore)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.audit_logs')).n), logsBefore)
    })
    await test('unexpected failure in second acquisition rolls back first acquisition and its audit', async () => {
      await db.exec("CREATE FUNCTION private.test_import_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.model = 'TEST_IMPORT_ROLLBACK' THEN RAISE EXCEPTION 'TEST_IMPORT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_import_failure BEFORE INSERT ON public.vehicles FOR EACH ROW EXECUTE FUNCTION private.test_import_failure();")
      const first = importRow()
      const second = importRow({ model: 'TEST_IMPORT_ROLLBACK' })
      const logsBefore = Number((await row('SELECT count(*) AS n FROM public.audit_logs')).n)
      try {
        await deny(() => call('owner', 'import_vehicles', [first, second]), /TEST_IMPORT_FAILURE/)
        assert.equal(Number((await row('SELECT count(*) AS n FROM public.vehicles WHERE frame_number=ANY($1::text[])', [[first.frame_number, second.frame_number]])).n), 0)
        assert.equal(Number((await row('SELECT count(*) AS n FROM public.audit_logs')).n), logsBefore)
      } finally { await db.exec('DROP TRIGGER test_import_failure ON public.vehicles; DROP FUNCTION private.test_import_failure()') }
    })
    await test('valid import reuses acquisition lifecycle and audit and rejects replayed inventory', async () => {
      const batch = [importRow({ supplier_name: 'Người bán thử', supplier_phone: '0007777777' }), importRow()]
      const data = await call('owner', 'import_vehicles', batch)
      assert.equal(data.imported_count, 2)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=ANY($1::uuid[])', [data.vehicle_ids])).n), 2)
      for (const id of data.vehicle_ids) {
        const record = await read('owner', 'get_vehicle', '$1::uuid', [id])
        assert.equal(record.status, 'IN_STOCK')
        assert.equal(record.purchase_price, 12_000_000)
        assert.ok(record.activity.some(a => a.action === 'CREATE_ACQUISITION'))
      }
      await deny(() => call('owner', 'import_vehicles', batch), /DUPLICATE_IMPORT_VEHICLE/)
    })
    await test('inactive users cannot import and nonfinancial staff cannot set purchase cost', async () => {
      for (const user of ['disabled']) {
        await deny(() => call(user, 'validate_import_vehicles', [importRow()]))
        await deny(() => call(user, 'import_vehicles', [importRow()]))
      }
      for (const user of ['manager', 'staff']) {
        const data = await call(user, 'validate_import_vehicles', [importRow()])
        assert.ok(data.errors.some(e => e.message === 'FINANCIAL_ACCESS_DENIED'))
        await deny(() => call(user, 'import_vehicles', [importRow()]), /INVALID_IMPORT_DATA/)
        await deny(() => call(user, 'acquire_vehicle', { ...importRow(), acquisition_date: day }), /FINANCIAL_ACCESS_DENIED/)
      }
      const noCost = importRow()
      delete noCost.purchase_price
      const data = await call('staff', 'import_vehicles', [noCost])
      assert.equal((await read('owner', 'get_vehicle', '$1::uuid', [data.vehicle_ids[0]])).cost_pending, true)
    })
    await test('payment request UUID prevents duplicate payments/audit across identical retries', async () => {
      const input = { request_id: randomUUID(), sale_id: partial.id, amount: 10_000_000, payment_method: 'CASH', payment_date: day, reference: 'TEST-ONLY', notes: '' }
      assert.equal(await call('staff', 'add_payment', input), input.request_id)
      assert.equal(await call('staff', 'add_payment', input), input.request_id)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.payments WHERE id=$1', [input.request_id])).n), 1)
      assert.equal(Number((await row("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='CREATE_PAYMENT'", [input.request_id])).n), 1)
      await deny(() => call('staff', 'add_payment', { ...input, amount: 11_000_000 }), /PAYMENT_REQUEST_CONFLICT/)
      await deny(() => call('owner', 'add_payment', input), /PAYMENT_REQUEST_CONFLICT/)
      assert.equal((await read('staff', 'get_sale', '$1::uuid', [partial.id])).remaining_amount, 60_000_000)
    })
    await test('overpayment/cancellation guards survive retry enhancement and inactive users cannot collect', async () => {
      await deny(() => call('staff', 'add_payment', { request_id: randomUUID(), sale_id: partial.id, amount: 60_000_001, payment_method: 'CASH', payment_date: day }), /PAYMENT_EXCEEDS_BALANCE/)
      await deny(() => call('staff', 'add_payment', { request_id: randomUUID(), sale_id: cancelled.id, amount: 1, payment_method: 'CASH', payment_date: day }), /SALE_CANCELLED/)
      await deny(() => call('disabled', 'add_payment', { sale_id: partial.id, amount: 1, payment_method: 'CASH', payment_date: day }))
      await call('staff', 'add_payment', { request_id: randomUUID(), sale_id: partial.id, amount: 60_000_000, payment_method: 'BANK_TRANSFER', payment_date: day })
      assert.equal((await read('staff', 'get_sale', '$1::uuid', [partial.id])).remaining_amount, 0)
    })
    await test('new operational RPCs reject anonymous/inactive and retain RPC-only writes', async () => {
      for (const fn of ['list_receivables', 'list_customers']) await deny(() => call('disabled', fn, {}))
      await deny(() => read('disabled', 'get_customer_history', '$1::text', ['0900001234']))
      await deny(() => asUser(db, null, client => rpc(client, 'list_receivables', "'{}'::jsonb"), 'anon'))
      for (const name of ['owner', 'manager', 'staff']) {
        for (const table of ['sales', 'payments', 'vehicles', 'acquisitions']) {
          await deny(() => run(name, client => client.exec(`UPDATE public.${table} SET created_at=now()`)))
          await deny(() => run(name, client => client.exec(`DELETE FROM public.${table}`)))
        }
      }
    })
    await test('completed sale queues one idempotent thank-you and mock worker records history without financial data', async () => {
      await read('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: true, sale_thank_you_enabled: true, primary_message_channel: 'SMS' })])
      const vehicleId = await vehicle()
      const saleId = await call('staff', 'sell_vehicle', { vehicle_id: vehicleId, customer_name: 'Khách tin nhắn', customer_phone: '0912345678', sale_price: 80_000_000, sale_date: day, initial_payment: 0 })
      const job = await read('staff', 'get_sale_communication', '$1::uuid', [saleId])
      assert.equal(job.status, 'QUEUED')
      assert.equal(job.channel, 'SMS')
      assert.equal(job.recipient_phone, '+84912345678')
      assert.ok(!JSON.stringify(job.template_variables).includes('sale_price'))
      assert.equal((await read('staff', 'list_customer_communications', '$1::text', ['0912345678'])).length, 1)
      const claimed = await read('staff', 'claim_message', '$1::uuid', [job.id])
      assert.equal(claimed.status, 'PROCESSING')
      const temporary = await read('staff', 'fail_message', '$1::uuid,$2::text,$3::text,$4::boolean', [job.id, 'NETWORK_TIMEOUT', 'Nhà cung cấp tạm thời không phản hồi.', false])
      assert.equal(temporary.status, 'QUEUED')
      assert.ok(new Date(temporary.next_attempt_at) > new Date())
      assert.equal((await read('staff', 'get_sale', '$1::uuid', [saleId])).status, 'COMPLETED')
      await db.query('UPDATE public.message_outbox SET next_attempt_at=now() WHERE id=$1', [job.id])
      assert.equal((await read('staff', 'claim_message', '$1::uuid', [job.id])).attempt_count, 2)
      const sent = await read('staff', 'finish_mock_message', '$1::uuid,$2::text', [job.id, 'mock_test_123'])
      assert.equal(sent.status, 'SENT')
      const history = await read('staff', 'list_customer_communications', '$1::text', ['+84912345678'])
      assert.equal(history.length, 1)
      assert.equal(history[0].status, 'SENT')
      assert.equal(history[0].provider, 'MOCK')
      assert.ok(!JSON.stringify(history[0]).includes('sale_price'))
      await assert.rejects(db.query(`INSERT INTO public.message_outbox(event_type,channel,sale_id,status) VALUES('SALE_THANK_YOU','SMS',$1,'QUEUED')`, [saleId]), /unique|duplicate/i)
      await assert.rejects(run('staff', client => client.query('SELECT * FROM public.message_outbox')), /permission denied|row-level security/i)
      await assert.rejects(run('staff', client => client.query('UPDATE public.message_outbox SET status=\'CANCELLED\'')), /permission denied|row-level security/i)
      await assert.rejects(run('staff', client => client.query('SELECT * FROM public.customer_communications')), /permission denied|row-level security/i)
      await deny(() => read('staff', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: false })]))
      await read('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: false, sale_thank_you_enabled: false })])
    })
    await test('failed sale creates no message; outbox storage failure cannot roll back sale; disabled/missing phone skip safely', async () => {
      const invalidVehicle = await vehicle()
      await deny(() => call('staff', 'sell_vehicle', { vehicle_id: invalidVehicle, customer_name: 'Sai dữ liệu', customer_phone: '0912345678', sale_price: 1, initial_payment: 2, sale_date: day }), /INVALID_PAYMENT/)
      assert.equal(Number((await row('SELECT count(*) AS n FROM public.message_outbox WHERE sale_id IN (SELECT id FROM public.sales WHERE vehicle_id=$1)', [invalidVehicle])).n), 0)
      const isolatedVehicle = await vehicle()
      await db.exec(`CREATE FUNCTION private.reject_message_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outbox outage'; END $$; CREATE TRIGGER reject_message_outbox BEFORE INSERT ON public.message_outbox FOR EACH ROW EXECUTE FUNCTION private.reject_message_outbox();`)
      let isolatedSale
      try {
        isolatedSale = await call('staff', 'sell_vehicle', { vehicle_id: isolatedVehicle, customer_name: 'Bán vẫn thành công', customer_phone: '0912345678', sale_price: 80_000_000, sale_date: day, initial_payment: 0 })
      } finally {
        await db.exec('DROP TRIGGER reject_message_outbox ON public.message_outbox; DROP FUNCTION private.reject_message_outbox()')
      }
      assert.equal((await read('staff', 'get_sale', '$1::uuid', [isolatedSale])).status, 'COMPLETED')
      assert.equal((await read('staff', 'get_sale_communication', '$1::uuid', [isolatedSale])).id, undefined)
      const skippedSale = await call('staff', 'sell_vehicle', { vehicle_id: await vehicle(), customer_name: 'Không có số', customer_phone: '', sale_price: 80_000_000, sale_date: day, initial_payment: 0 })
      assert.equal((await read('staff', 'get_sale_communication', '$1::uuid', [skippedSale])).status, 'SKIPPED')
    })
    await test('OWNER/MANAGER retry reuses the same failed idempotent job after the bounded automatic attempts', async () => {
      await read('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: true, sale_thank_you_enabled: true, primary_message_channel: 'SMS' })])
      const saleId = await call('staff', 'sell_vehicle', { vehicle_id: await vehicle(), customer_name: 'Thử lại tin nhắn', customer_phone: '0934567890', sale_price: 80_000_000, sale_date: day, initial_payment: 0 })
      const job = await read('staff', 'get_sale_communication', '$1::uuid', [saleId])
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claimed = await read('staff', 'claim_message', '$1::uuid', [job.id])
        assert.equal(claimed.attempt_count, attempt)
        const state = await read('staff', 'fail_message', '$1::uuid,$2::text,$3::text,$4::boolean', [job.id, 'NETWORK_TIMEOUT', 'Tạm thời không kết nối được.', false])
        assert.equal(state.status, attempt === 3 ? 'FAILED' : 'QUEUED')
        if (attempt < 3) await db.query('UPDATE public.message_outbox SET next_attempt_at=now() WHERE id=$1', [job.id])
      }
      await deny(() => read('staff', 'retry_sale_thank_you', '$1::uuid', [saleId]), /ACCESS_DENIED/)
      const retry = await read('owner', 'retry_sale_thank_you', '$1::uuid', [saleId])
      assert.equal(retry.id, job.id)
      assert.equal(retry.attempt_count, 0)
      assert.equal((await read('staff', 'get_sale', '$1::uuid', [saleId])).status, 'COMPLETED')
      await read('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: false, sale_thank_you_enabled: false })])
    })
    await test('not-configured provider fails safely after commit and OWNER retry reuses the same job', async () => {
      await read('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: true, sale_thank_you_enabled: true, primary_message_channel: 'ZALO_ZNS' })])
      const saleId = await call('staff', 'sell_vehicle', { vehicle_id: await vehicle(), customer_name: 'Thiếu nhà cung cấp', customer_phone: '0987654321', sale_price: 80_000_000, sale_date: day, initial_payment: 0 })
      const job = await read('staff', 'get_sale_communication', '$1::uuid', [saleId])
      const claimed = await read('staff', 'claim_message', '$1::uuid', [job.id])
      const skipped = await read('staff', 'skip_message', '$1::uuid,$2::text,$3::text', [claimed.id, 'PROVIDER_NOT_CONFIGURED', 'Chưa cấu hình nhà cung cấp tin nhắn.'])
      assert.equal(skipped.status, 'SKIPPED')
      assert.equal(skipped.last_error_code, 'PROVIDER_NOT_CONFIGURED')
      assert.equal((await read('staff', 'get_sale', '$1::uuid', [saleId])).status, 'COMPLETED')
      await deny(() => read('staff', 'retry_sale_thank_you', '$1::uuid', [saleId]), /ACCESS_DENIED/)
      await deny(() => read('owner', 'retry_sale_thank_you', '$1::uuid', [saleId]), /MESSAGE_PROVIDER_NOT_CONFIGURED/)
      assert.equal((await read('staff', 'get_sale_communication', '$1::uuid', [saleId])).attempt_count, 1)
      await read('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: false, sale_thank_you_enabled: false })])
    })
    const hour = 3_600_000
    const activeFor = async (user) => (await read(user, 'list_active_announcements')).map(a => a.id)
    await test('only OWNER can manage announcements; others can only read targeted notices', async () => {
      await deny(() => call('staff', 'save_announcement', { message: 'Không có quyền' }), /ACCESS_DENIED/)
      await deny(() => call('manager', 'save_announcement', { message: 'Không có quyền' }), /ACCESS_DENIED/)
      await deny(() => read('staff', 'list_announcements'), /ACCESS_DENIED/)
      await deny(() => read('staff', 'delete_announcement', '$1::uuid', [randomUUID()]), /ACCESS_DENIED/)
      await deny(() => read('manager', 'set_announcement_active', '$1::uuid,$2::boolean', [randomUUID(), true]), /ACCESS_DENIED/)
    })
    await test('active store-wide announcement is visible to every role immediately', async () => {
      const saved = await call('owner', 'save_announcement', { message: 'Cửa hàng nghỉ Tết từ 27/01 đến 02/02.', type: 'INFO', is_active: true })
      assert.equal(saved.is_active, true)
      for (const user of ['staff', 'manager', 'owner']) assert.ok((await activeFor(user)).includes(saved.id))
      await read('owner', 'delete_announcement', '$1::uuid', [saved.id])
    })
    await test('audience targets a single role and scheduling controls the window', async () => {
      const staffOnly = await call('owner', 'save_announcement', { message: 'Họp nhân viên lúc 8h.', audience: 'STAFF', is_active: true })
      assert.ok((await activeFor('staff')).includes(staffOnly.id))
      assert.ok(!(await activeFor('manager')).includes(staffOnly.id))
      const future = await call('owner', 'save_announcement', { message: 'Chưa tới lịch.', is_active: true, starts_at: new Date(Date.now() + 6 * hour).toISOString() })
      assert.ok(!(await activeFor('owner')).includes(future.id))
      const expired = await call('owner', 'save_announcement', { message: 'Đã qua lịch.', is_active: true, ends_at: new Date(Date.now() - hour).toISOString() })
      assert.ok(!(await activeFor('owner')).includes(expired.id))
      for (const id of [staffOnly.id, future.id, expired.id]) await read('owner', 'delete_announcement', '$1::uuid', [id])
    })
    await test('invalid schedule and empty message are rejected', async () => {
      await deny(() => call('owner', 'save_announcement', { message: 'Lỗi ngày', is_active: true, starts_at: new Date(Date.now() + 6 * hour).toISOString(), ends_at: new Date(Date.now() + 2 * hour).toISOString() }), /INVALID_DATE_RANGE/)
      await deny(() => call('owner', 'save_announcement', { message: '   ' }), /INVALID_ANNOUNCEMENT_MESSAGE/)
    })
    await test('critical outranks lower types, activation toggles visibility, changes are audited', async () => {
      const info = await call('owner', 'save_announcement', { message: 'Nhắc quy trình.', type: 'INFO', is_active: true })
      const critical = await call('owner', 'save_announcement', { message: 'Bảo trì hệ thống.', type: 'CRITICAL', is_active: true })
      const list = await read('staff', 'list_active_announcements')
      assert.ok(list.findIndex(a => a.id === critical.id) < list.findIndex(a => a.id === info.id))
      const toggled = await read('owner', 'set_announcement_active', '$1::uuid,$2::boolean', [critical.id, false])
      assert.equal(toggled.is_active, false)
      assert.ok(!(await activeFor('staff')).includes(critical.id))
      await read('owner', 'set_announcement_active', '$1::uuid,$2::boolean', [critical.id, true])
      assert.ok((await activeFor('staff')).includes(critical.id))
      await read('owner', 'delete_announcement', '$1::uuid', [info.id])
      await read('owner', 'delete_announcement', '$1::uuid', [critical.id])
      const actions = (await db.query("SELECT action FROM public.audit_logs WHERE entity_type='system_announcements'")).rows.map(r => r.action)
      for (const action of ['ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_ACTIVATE', 'ANNOUNCEMENT_DEACTIVATE', 'ANNOUNCEMENT_DELETE']) assert.ok(actions.includes(action), `missing audit ${action}`)
    })
    if (db.connection) {
      await test('concurrent keyed retries record once; competing payments cannot exceed debt', async () => {
        const debt = await sale(100_000_000, day)
        const connections = [await db.connection(), await db.connection()]
        try {
          const input = { request_id: randomUUID(), sale_id: debt.id, amount: 30_000_000, payment_method: 'CASH', payment_date: day }
          const same = await Promise.all(connections.map(client => asUser(client, users.staff, conn => rpc(conn, 'add_payment', '$1::jsonb', [JSON.stringify(input)]))))
          assert.deepEqual(same, [input.request_id, input.request_id])
          const competing = await Promise.allSettled(connections.map(client => asUser(client, users.staff, conn => rpc(conn, 'add_payment', '$1::jsonb', [JSON.stringify({ ...input, request_id: randomUUID(), amount: 50_000_000 })]))))
          assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1)
          assert.equal(competing.filter(r => r.status === 'rejected').length, 1)
          assert.equal((await read('owner', 'get_sale', '$1::uuid', [debt.id])).paid_amount, 80_000_000)
        } finally { await Promise.all(connections.map(client => client.close())) }
      })
    } else console.log('SKIP operational concurrency: PGlite has one connection; native PostgreSQL required')
    console.log(`Operational database checks passed: ${passed}`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/operational-features.test.mjs')) {
  try { await runOperationalTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' }) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
