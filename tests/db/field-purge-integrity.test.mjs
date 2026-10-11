/**
 * Database Field-Purge Integrity Suite
 * Proves migration 20261008000300 permanently removed the vehicle spec fields
 * and rebuilt the RPC surface around the new identity/price rules, WITHOUT
 * disturbing the money that must survive (business + financial tables):
 * 1. the six columns are gone from `vehicles`; the quickpick columns are gone
 *    from `system_settings`; the engine-number index is gone
 * 2. `vehicle_type_id` is present, NOT NULL and FK-backed
 * 3. every history table was emptied and stays empty until new activity
 * 4. no surviving public/private function references a purged field name
 * 5. the legacy 4-argument vehicle_label_text signature is gone
 * 6. get_vehicle now projects the new identity (title/subtitle/type) and never
 *    leaks a purged key
 * 7. profit still derives from the immutable sale_financials snapshot and the
 *    sale price is never prefilled from the vehicle (there is no asking_price)
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

const PURGED_COLUMNS = ['brand', 'model', 'variant', 'engine_number', 'odometer', 'asking_price']
const HISTORY_TABLES = [
  'audit_logs',
  'vehicle_activity',
  'notifications',
  'customer_communications',
  'message_outbox',
]

export async function runFieldPurgeIntegrityTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Field-Purge Integrity Suite ---')
    let passed = 0
    const pass = (name) => {
      passed += 1
      console.log(`PASS ${passed}. ${name}`)
    }
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]

    const users = Object.fromEntries(['owner', 'staff'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) =>
      run(user, (client) => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const read = (user, name, args = '', values = []) =>
      run(user, (client) => rpc(client, name, args, values))

    // --- Introspection first: run before any activity rows are generated. ---
    const vehicleColumns = (await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicles'",
    )).rows.map((r) => r.column_name)
    await pass('the six spec columns are gone from vehicles')
    for (const column of PURGED_COLUMNS)
      assert.ok(!vehicleColumns.includes(column), `column ${column} still present`)
    assert.ok(vehicleColumns.includes('vehicle_type_id'), 'vehicle_type_id must exist')

    await pass('the quickpick brand/model columns are gone from system_settings')
    const settingsColumns = (await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='system_settings'",
    )).rows.map((r) => r.column_name)
    assert.ok(!settingsColumns.includes('quickpick_brands'))
    assert.ok(!settingsColumns.includes('quickpick_models'))

    await pass('vehicle_type_id is NOT NULL and protected by a foreign key to vehicle_types')
    const notNull = await row(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicles' AND column_name='vehicle_type_id'",
    )
    assert.equal(notNull.is_nullable, 'NO')
    const fk = await row(
      "SELECT confrelid::regclass::text AS ref FROM pg_constraint WHERE conrelid='public.vehicles'::regclass AND conname='vehicles_vehicle_type_id_fkey' AND contype='f'",
    )
    assert.equal(fk.ref, 'vehicle_types', 'FK must target public.vehicle_types')

    await pass('the engine-number index was dropped with the column')
    assert.equal(
      Number((await row("SELECT count(*)::int AS n FROM pg_class WHERE relname='vehicles_engine_number'")).n),
      0,
    )

    await pass('every history table was emptied by the migration')
    for (const table of HISTORY_TABLES)
      assert.equal(
        Number((await row(`SELECT count(*)::int AS n FROM public.${table}`)).n),
        0,
        `${table} should hold no rows after the purge`,
      )

    await pass('no surviving function references a purged field name')
    const lingering = await row(
      `SELECT string_agg(x.who, ', ') AS who FROM (
         SELECT n.nspname || '.' || p.proname AS who
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public','private')
           AND p.proname != 'log_post_ai_usage'
           AND p.prosrc ~ '\\m(brand|model|variant|engine_number|odometer|asking_price|quickpick_brands|quickpick_models)\\M'
       ) x`,
    )
    assert.equal(lingering.who, null, `functions still mention purged fields: ${lingering.who}`)

    await pass('the legacy 4-argument vehicle_label_text signature is gone')
    assert.equal(
      Number((await row(
        "SELECT count(*)::int AS n FROM pg_proc WHERE proname='vehicle_label_text' AND array_length(proargtypes, 1)=4",
      )).n),
      0,
    )

    // --- Functional cycle proving the rebuilt RPCs keep the money correct. ---
    const day = (await row('SELECT private.today()::text AS day')).day
    for (const [name, id] of Object.entries(users)) {
      await db.query(
        'INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `purge-${name}@example.test`, JSON.stringify({ full_name: name })]
      )
      await db.query(
        'UPDATE public.profiles SET role=$1::public.user_role,active=true,can_view_financials=true WHERE id=$2',
        [name.toUpperCase(), id]
      )
    }
    const catalogue = await read('owner', 'list_vehicle_types')
    const typeId = catalogue.find((item) => item.name === 'Xe số').id

    await pass('get_vehicle projects the new identity and never leaks a purged key')
    const vehicleId = await call('staff', 'save_vehicle', {
      request_id: randomUUID(),
      vehicle_type_id: typeId,
      purchase_date: day,
      purchase_price: 30_000_000,
      license_plate: '51H-123.45',
      frame_number: 'PURGEFRAME0001',
      color: 'Đen',
      year: 2023,
    })
    const vehicle = await read('owner', 'get_vehicle', '$1::uuid', [vehicleId])
    for (const column of PURGED_COLUMNS)
      assert.equal(Object.hasOwn(vehicle, column), false, `get_vehicle still exposes ${column}`)
    assert.equal(vehicle.vehicle_type, 'Xe số')
    assert.match(vehicle.vehicle_title, /51H-123\.45/)
    assert.match(vehicle.vehicle_title, /PURGEFRAME0001/)
    assert.equal(vehicle.vehicle_subtitle, 'Xe số · 2023 · Đen')

    await pass('sale price is never prefilled from the vehicle; profit derives from the snapshot')
    await run('owner', (client) =>
      rpc(client, 'save_expense', "'vehicle',$1::jsonb", [
        JSON.stringify({ vehicle_id: vehicleId, expense_type: 'REPAIR', description: 'Chi phí purge test', amount: 2_000_000, expense_date: day }),
      ]))
    const saleId = await call('staff', 'sell_vehicle', {
      vehicle_id: vehicleId,
      customer_name: 'Khách purge',
      customer_phone: '0900000000',
      sale_price: 45_000_000,
      sale_date: day,
      initial_payment: 5_000_000,
      payment_method: 'CASH',
    })
    const sale = await read('owner', 'get_sale', '$1::uuid', [saleId])
    assert.equal(sale.purchase_cost_snapshot, 30_000_000)
    assert.equal(sale.expense_cost_snapshot, 2_000_000)
    assert.equal(sale.total_cost_snapshot, 32_000_000)
    assert.equal(sale.gross_profit, 13_000_000) // 45M - 30M - 2M, entirely from sale_financials

    await pass('sale_financials is immutable and business tables survived the purge')
    await assert.rejects(
      () => db.query('UPDATE public.sale_financials SET purchase_cost_snapshot=1 WHERE sale_id=$1', [saleId]),
      /IMMUTABLE_HISTORY/,
    )
    for (const table of ['vehicles', 'acquisitions', 'sales', 'payments', 'vehicle_expenses', 'sale_financials']) {
      const exists = await row(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
        [table],
      )
      assert.equal(exists.n, 1, `${table} must still exist after the purge`)
    }

    console.log(`${passed} field-purge integrity checks passed on ${engine}.`)
    return passed
  } finally {
    if (ownDb) await db.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runFieldPurgeIntegrityTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
    .then(() => process.exit(0))
    .catch((error) => { console.error(error); process.exit(1) })
}
