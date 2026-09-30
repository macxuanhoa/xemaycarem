import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { asUser, createDatabase, rpc } from '../../scripts/db-harness.mjs'

export async function runAuthSecurityTests({ engine = 'pglite' } = {}) {
  const db = await createDatabase({ engine })
  const ids = Object.fromEntries(['owner', 'manager', 'finance', 'staff', 'viewer', 'temporary'].map((name) => [name, randomUUID()]))
  const run = (name, operation) => asUser(db, ids[name], operation)
  const call = (name, functionName, data) => run(name, (client) => rpc(client, functionName, '$1::jsonb', [JSON.stringify(data)]))
  let passed = 0
  async function test(name, operation) {
    await operation()
    console.log(`PASS auth ${++passed}. ${name}`)
  }
  try {
    for (const [name, id] of Object.entries(ids)) {
      await db.query('INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data) VALUES($1,$2,$3,$4::jsonb)',
        [id, `${name}@example.test`, 'disposable-auth-hash-before', JSON.stringify({ full_name: name })])
    }
    for (const [name, role] of Object.entries({ owner: 'OWNER', manager: 'MANAGER', finance: 'MANAGER', staff: 'STAFF', viewer: 'VIEWER', temporary: 'STAFF' })) {
      await db.query('UPDATE public.profiles SET role=$1,active=true,can_view_financials=$2,must_change_password=$3 WHERE id=$4',
        [role, name === 'finance', name === 'temporary', ids[name]])
    }
    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const vehicles = []
    for (const price of [100, 200]) {
      vehicles.push(await call('owner', 'acquire_vehicle', {
        frame_number: `AUTH-TEST-${randomUUID()}`, brand: 'Honda', model: 'Test',
        purchase_price: 50, asking_price: price, acquisition_date: day,
      }))
    }
    await test('Required password users can read their profile and open the change screen, but cannot read business data', async () => {
      const access = await run('temporary', (client) => rpc(client, 'check_user_access'))
      assert.equal(access.allowed, true)
      assert.equal(access.must_change_password, true)
      const profile = await run('temporary', (client) => client.query('SELECT id FROM public.profiles'))
      assert.equal(profile.rows.length, 1)
      assert.equal((await run('temporary', (client) => client.query('SELECT * FROM public.vehicles'))).rows.length, 0)
      await assert.rejects(run('temporary', (client) => rpc(client, 'list_vehicles')), /ACCESS_DENIED/)
    })
    await test('Direct completion and owner flag clearing cannot bypass an unchanged Auth password', async () => {
      await assert.rejects(run('temporary', (client) => rpc(client, 'complete_password_change')), /PASSWORD_CHANGE_REQUIRED/)
      await assert.rejects(run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.temporary, '{"must_change_password":false}'])), /PASSWORD_CHANGE_REQUIRED/)
      await db.query("UPDATE auth.users SET raw_user_meta_data=raw_user_meta_data || '{\"full_name\":\"Edited\"}'::jsonb WHERE id=$1", [ids.temporary])
      await assert.rejects(run('temporary', (client) => rpc(client, 'complete_password_change')), /PASSWORD_CHANGE_REQUIRED/)
    })
    await test('The real password hash must change before completion; the next reset requires another change', async () => {
      // Only a disposable Auth stub is updated here. Hosted password updates must
      // run through Supabase Auth; this test exercises the DB verification rule.
      await db.query('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2', ['disposable-auth-hash-after', ids.temporary])
      await run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [ids.temporary, '{"full_name":"Renamed while changing password"}']))
      await run('temporary', (client) => rpc(client, 'complete_password_change'))
      assert.equal((await run('temporary', (client) => rpc(client, 'list_vehicles'))).total, 2)
      await run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [ids.temporary, '{"must_change_password":true}']))
      await assert.rejects(run('temporary', (client) => rpc(client, 'complete_password_change')), /PASSWORD_CHANGE_REQUIRED/)
      await db.query('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2', ['disposable-auth-hash-next', ids.temporary])
      await run('temporary', (client) => rpc(client, 'complete_password_change'))
    })
    await test('Pending administrative resets gate old sessions and cannot be completed using the temporary credential', async () => {
      await run('owner', (client) => rpc(client, 'require_password_change', '$1::uuid,true', [ids.temporary]))
      await db.query('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2', ['disposable-temporary-reset-hash', ids.temporary])
      await assert.rejects(run('temporary', (client) => rpc(client, 'complete_password_change')), /PASSWORD_CHANGE_REQUIRED/)
      await assert.rejects(run('temporary', (client) => rpc(client, 'list_vehicles')), /ACCESS_DENIED/)
      await asUser(db, null, (client) => rpc(client, 'require_password_change', '$1::uuid,false', [ids.temporary]), 'service_role')
      await assert.rejects(run('temporary', (client) => rpc(client, 'complete_password_change')), /PASSWORD_CHANGE_REQUIRED/)
      await db.query('UPDATE auth.users SET encrypted_password=$1 WHERE id=$2', ['disposable-user-permanent-hash', ids.temporary])
      await run('temporary', (client) => rpc(client, 'complete_password_change'))
    })
    await test('Daytime and overnight schedule windows use the same authoritative SQL check', async () => {
      for (const [from, until, time, allowed] of [['07:00', '20:00', '10:00', true], ['07:00', '20:00', '22:00', false],
        ['22:00', '06:00', '23:00', true], ['22:00', '06:00', '03:00', true], ['22:00', '06:00', '12:00', false]]) {
        const result = await db.query('SELECT private.schedule_allows_time($1::time,$2::time,$3::time) AS allowed', [from, until, time])
        assert.equal(result.rows[0].allowed, allowed)
      }
    })
    await test('No browser role can read password fingerprints or anonymous completion RPC', async () => {
      for (const name of ['owner', 'staff', 'viewer']) {
        await assert.rejects(run(name, (client) => client.query('SELECT * FROM private.required_password_changes')), /permission denied/)
      }
      await assert.rejects(asUser(db, null, (client) => rpc(client, 'complete_password_change'), 'anon'), /permission denied/)
    })
    await test('Acquisition table costs are private while operational acquisition lists remain masked', async () => {
      for (const name of ['manager', 'staff', 'viewer']) {
        assert.equal((await run(name, (client) => client.query('SELECT purchase_price FROM public.acquisitions'))).rows.length, 0)
        const list = await run(name, (client) => rpc(client, 'list_acquisitions'))
        assert.equal(list.total, 2)
        assert.ok(list.items.every((item) => item.purchase_price === null))
      }
      assert.equal((await run('finance', (client) => client.query('SELECT purchase_price FROM public.acquisitions'))).rows.length, 2)
    })
    for (const [index, vehicleId] of vehicles.entries()) {
      await run('owner', (client) => rpc(client, 'save_expense', "'vehicle',$1::jsonb", [JSON.stringify({
        vehicle_id: vehicleId, expense_type: 'REPAIR', description: 'Test expense', amount: 1, expense_date: day,
      })]))
      await call('owner', 'sell_vehicle', {
        vehicle_id: vehicleId, customer_name: 'Test customer', sale_price: [100, 200][index],
        initial_payment: 10, payment_method: 'CASH', sale_date: day,
      })
    }
    await test('Performance revenue is accurate across multiple acquisitions, expenses, payments and audit rows', async () => {
      const result = await run('owner', (client) => client.query('SELECT * FROM public.user_performance_summary WHERE user_id=$1', [ids.owner]))
      assert.equal(result.rows.length, 1)
      assert.equal(Number(result.rows[0].total_sales_revenue), 300)
      assert.equal(Number(result.rows[0].vehicles_acquired_count), 2)
      assert.equal(Number(result.rows[0].vehicles_sold_count), 2)
      assert.equal(Number(result.rows[0].vehicle_expenses_count), 2)
      assert.equal(Number(result.rows[0].payments_recorded_count), 2)
      for (const name of ['manager', 'finance', 'staff', 'viewer']) {
        assert.equal((await run(name, (client) => client.query('SELECT * FROM public.user_performance_summary'))).rows.length, 0)
      }
    })
    await test('Soft deleting the only usable owner is rejected and legacy unauthorised deletion helpers are absent', async () => {
      await assert.rejects(run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.owner, '{"deleted_at":"2026-09-30T00:00:00Z"}'])), /LAST_OWNER_REQUIRED/)
      const functions = await db.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND proname IN ('delete_auth_user','cleanup_deleted_accounts')")
      assert.equal(functions.rows.length, 0)
    })
    console.log(`${passed} auth database security checks passed on ${engine}.`)
  } finally {
    await db.close()
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/auth-security.test.mjs')) {
  await runAuthSecurityTests({ engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
