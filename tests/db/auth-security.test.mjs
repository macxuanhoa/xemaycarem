import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { asUser, createDatabase, rpc } from '../../scripts/db-harness.mjs'

export async function runAuthSecurityTests({ engine = 'pglite' } = {}) {
  const db = await createDatabase({ engine })
  const ids = Object.fromEntries(['owner', 'manager', 'finance', 'staff', 'temporary'].map((name) => [name, randomUUID()]))
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
    for (const [name, role] of Object.entries({ owner: 'OWNER', manager: 'MANAGER', finance: 'MANAGER', staff: 'STAFF', temporary: 'STAFF' })) {
      await db.query('UPDATE public.profiles SET role=$1,active=true,can_view_financials=$2,must_change_password=$3 WHERE id=$4',
        [role, name === 'finance', name === 'temporary', ids[name]])
    }
    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const vehicles = []
    for (let index = 0; index < 2; index++) {
      vehicles.push(await call('owner', 'acquire_vehicle', {
        request_id: randomUUID(),
        frame_number: `AUTH-TEST-${randomUUID()}`, vehicle_type: 'Xe tay ga',
        purchase_price: 50, acquisition_date: day,
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
    await test('Shared schedule on system_settings gates every non-OWNER role', async () => {
      // A one-hour window two hours ahead of the Vietnam wall clock can never
      // contain the current moment, so OUTSIDE_HOURS is deterministic.
      const vnNow = new Date(Date.now() + 7 * 3600 * 1000)
      const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00`
      await call('owner', 'save_settings', {
        staff_allowed_from: hhmm(new Date(vnNow.getTime() + 2 * 3600 * 1000)),
        staff_allowed_until: hhmm(new Date(vnNow.getTime() + 3 * 3600 * 1000)),
      })
      for (const name of ['staff', 'manager']) {
        const access = await run(name, (client) => rpc(client, 'check_user_access'))
        assert.equal(access.allowed, false)
        assert.equal(access.code, 'OUTSIDE_HOURS')
      }
      assert.equal((await run('owner', (client) => rpc(client, 'check_user_access'))).allowed, true)
      // Full-day window but today excluded isolates OUTSIDE_DAYS.
      const vnDay = vnNow.getUTCDay() === 0 ? 7 : vnNow.getUTCDay()
      await call('owner', 'save_settings', {
        staff_allowed_from: '00:00:00', staff_allowed_until: '23:59:59',
        staff_working_days: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== vnDay),
      })
      const dayAccess = await run('staff', (client) => rpc(client, 'check_user_access'))
      assert.equal(dayAccess.allowed, false)
      assert.equal(dayAccess.code, 'OUTSIDE_DAYS')
      await call('owner', 'save_settings', { staff_working_days: [1, 2, 3, 4, 5, 6, 7] })
      assert.equal((await run('staff', (client) => rpc(client, 'check_user_access'))).allowed, true)
    })
    await test('Shared schedule input is validated and OWNER-only to write', async () => {
      for (const bad of [{ staff_allowed_from: '25:00:00' }, { staff_allowed_until: '' }, { staff_working_days: [9] }]) {
        await assert.rejects(call('owner', 'save_settings', bad), /INVALID_SCHEDULE/)
      }
      await assert.rejects(call('staff', 'save_settings', { staff_allowed_from: '00:00:00' }), /ACCESS_DENIED/)
      // The rejected writes must not have changed the shared row.
      const settings = await run('staff', (client) => rpc(client, 'get_settings'))
      assert.equal(settings.staff_allowed_from, '00:00:00')
      assert.deepEqual(settings.staff_working_days, [1, 2, 3, 4, 5, 6, 7])
    })
    await test('Bounded temporary ban blocks logins only until its expiry', async () => {
      const future = new Date(Date.now() + 3600 * 1000).toISOString()
      await run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.staff, JSON.stringify({ active: true, disabled_until: future, disable_reason: 'Cấm thử nghiệm' })]))
      const banned = await run('staff', (client) => rpc(client, 'check_user_access'))
      assert.equal(banned.allowed, false)
      assert.equal(banned.code, 'TEMP_LOCKED')
      // An already-expired ban no longer blocks; lifting clears it entirely.
      await run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.staff, JSON.stringify({ disabled_until: new Date(Date.now() - 60 * 1000).toISOString() })]))
      assert.equal((await run('staff', (client) => rpc(client, 'check_user_access'))).allowed, true)
      await run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.staff, JSON.stringify({ disabled_until: null })]))
    })
    await test('MANAGER may only change the role of STAFF accounts', async () => {
      const update = (actor, id, data) => run(actor, (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [id, JSON.stringify(data)]))
      await assert.rejects(update('manager', ids.staff, { full_name: 'Đổi bởi quản lý' }), /ACCESS_DENIED/)
      await assert.rejects(update('manager', ids.finance, { role: 'STAFF' }), /ACCESS_DENIED/)
      await assert.rejects(update('manager', ids.manager, { role: 'STAFF' }), /ACCESS_DENIED/)
      await assert.rejects(update('manager', ids.staff, { role: 'OWNER' }), /ACCESS_DENIED/)
      await update('manager', ids.staff, { role: 'MANAGER' })
      await update('owner', ids.staff, { role: 'STAFF' })
      // STAFF keeps editing only their own name, never roles.
      await update('staff', ids.staff, { full_name: 'Nguyễn Nhân Viên' })
      await assert.rejects(update('staff', ids.manager, { full_name: 'X' }), /ACCESS_DENIED/)
      await assert.rejects(update('staff', ids.staff, { role: 'MANAGER' }), /ACCESS_DENIED/)
    })
    await test('No browser role can read password fingerprints or anonymous completion RPC', async () => {
      for (const name of ['owner', 'staff']) {
        await assert.rejects(run(name, (client) => client.query('SELECT * FROM private.required_password_changes')), /permission denied/)
      }
      await assert.rejects(asUser(db, null, (client) => rpc(client, 'complete_password_change'), 'anon'), /permission denied/)
    })
    await test('Acquisition rows stay RLS-private while every active role reads the intake price', async () => {
      for (const name of ['manager', 'staff']) {
        // Không có đường đọc trực tiếp: RLS trên bảng acquisitions vẫn chặn.
        assert.equal((await run(name, (client) => client.query('SELECT purchase_price FROM public.acquisitions'))).rows.length, 0)
        // RPC danh sách thu là đường đọc duy nhất, và từ 20261010000300 nó trả lại
        // đúng giá thu mà chính nhân viên thao tác xe đã nhập (không còn che).
        const list = await run(name, (client) => rpc(client, 'list_acquisitions'))
        assert.equal(list.total, 2)
        assert.ok(list.items.every((item) => Number(item.purchase_price) === 50))
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
      for (const name of ['manager', 'finance', 'staff']) {
        assert.equal((await run(name, (client) => client.query('SELECT * FROM public.user_performance_summary'))).rows.length, 0)
      }
    })
    await test('Soft deleting the only usable owner is rejected and legacy unauthorised deletion helpers are absent', async () => {
      await assert.rejects(run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.owner, '{"deleted_at":"2026-09-30T00:00:00Z"}'])), /LAST_OWNER_REQUIRED/)
      const functions = await db.query("SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND proname IN ('delete_auth_user','cleanup_deleted_accounts')")
      assert.equal(functions.rows.length, 0)
    })
    await test('Deleting staff removes the account from the system at once but keeps the work they recorded', async () => {
      const vanish = randomUUID()
      await db.query('INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data) VALUES($1,$2,$3,$4::jsonb)',
        [vanish, 'vanish@example.test', 'disposable-auth-hash', JSON.stringify({ full_name: 'vanish', username: 'vanish' })])
      await db.query("UPDATE public.profiles SET role='STAFF', active=true, username='vanish', full_name='Nhân sự bị xóa', must_change_password=false WHERE id=$1", [vanish])
      const listed = async () => (await run('owner', (client) => rpc(client, 'list_profiles'))).map((p) => p.id)
      assert.ok((await listed()).includes(vanish))
      // Tài khoản trắng (chưa ghi nhận gì) là nhánh "xóa sạch": Edge được phép xóa hàng profiles.
      const pristine = await run('owner', (client) => rpc(client, 'check_user_can_hard_delete', '$1::uuid', [vanish]))
      assert.equal(pristine.can_delete, true)
      // Chủ bấm xóa khi đã có nghiệp vụ: Edge giữ hàng profiles làm mộ, chặn đăng nhập và ẩn khỏi Nhân sự.
      await db.query('UPDATE public.profiles SET active=false, deleted_at=now(), purged_at=now() WHERE id=$1', [vanish])
      assert.ok(!(await listed()).includes(vanish), 'tài khoản đã xóa phải biến mất khỏi trang Nhân sự')
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.profiles WHERE id=$1', [vanish])).rows[0].n, 1)
      const tombstoneAccess = await asUser(db, vanish, (client) => rpc(client, 'check_user_access'))
      assert.equal(tombstoneAccess.allowed, false)
      assert.equal(tombstoneAccess.code, 'ACCOUNT_DELETED')
      // Dấu vết chỉ ở system_settings cũng đủ để cấm xóa sạch — bản cũ chỉ quét bảy bảng
      // nên Edge sẽ đụng FK violation giữa chừng khi xóa tài khoản kiểu này.
      const settingsOwner = (await db.query('SELECT updated_by FROM public.system_settings WHERE id')).rows[0].updated_by
      await db.query('UPDATE public.system_settings SET updated_by=$1 WHERE id', [ids.finance])
      try {
        const traced = await run('owner', (client) => rpc(client, 'check_user_can_hard_delete', '$1::uuid', [ids.finance]))
        assert.equal(traced.can_delete, false)
        assert.equal(traced.reason, 'USER_HAS_BUSINESS_HISTORY')
      } finally {
        await db.query('UPDATE public.system_settings SET updated_by=$1 WHERE id', [settingsOwner])
      }
      // STAFF không được phán quyết xóa.
      await assert.rejects(run('staff', (client) => rpc(client, 'check_user_can_hard_delete', '$1::uuid', [ids.manager])), /ACCESS_DENIED|permission denied/)
    })
    await test('Ownership transfers atomically and the system keeps exactly one active OWNER', async () => {
      const ghost = randomUUID()
      await db.query('INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data) VALUES($1,$2,$3,$4::jsonb)',
        [ghost, 'ghost@example.test', 'disposable-auth-hash', JSON.stringify({ full_name: 'ghost' })])
      await db.query('UPDATE public.profiles SET role=$1,active=false WHERE id=$2', ['STAFF', ghost])
      await assert.rejects(run('owner', (client) => rpc(client, 'transfer_ownership', '$1::uuid', [ids.owner])), /SELF_TRANSFER/)
      await assert.rejects(run('owner', (client) => rpc(client, 'transfer_ownership', '$1::uuid', [ghost])), /TARGET_NOT_ACTIVE/)
      // Hand over to the staff account: exactly one active OWNER, old owner demoted.
      await run('owner', (client) => rpc(client, 'transfer_ownership', '$1::uuid', [ids.staff]))
      const roles = await db.query("SELECT id,role,active FROM public.profiles WHERE id IN ($1,$2)", [ids.owner, ids.staff])
      assert.deepEqual(Object.fromEntries(roles.rows.map((r) => [r.id, r.role])), { [ids.owner]: 'MANAGER', [ids.staff]: 'OWNER' })
      const owners = await db.query("SELECT count(*)::int AS n FROM public.profiles WHERE role='OWNER' AND active AND deleted_at IS NULL")
      assert.equal(owners.rows[0].n, 1)
      // Raw role writes can never create a second owner while one is active.
      await assert.rejects(run('staff', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb',
        [ids.finance, '{"role":"OWNER"}'])), /SINGLE_OWNER_REQUIRED/)
      // Hand back to the baseline owner and restore the fixture roles.
      await run('staff', (client) => rpc(client, 'transfer_ownership', '$1::uuid', [ids.owner]))
      await run('owner', (client) => rpc(client, 'update_profile', '$1::uuid,$2::jsonb', [ids.staff, '{"role":"STAFF"}']))
      const finalOwners = await db.query("SELECT count(*)::int AS n FROM public.profiles WHERE role='OWNER' AND active AND deleted_at IS NULL")
      assert.equal(finalOwners.rows[0].n, 1)
      assert.equal((await run('owner', (client) => rpc(client, 'check_user_access'))).role, 'OWNER')
    })
    console.log(`${passed} auth database security checks passed on ${engine}.`)
  } finally {
    await db.close()
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/auth-security.test.mjs')) {
  await runAuthSecurityTests({ engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' })
}
