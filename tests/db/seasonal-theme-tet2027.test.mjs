/**
 * Database Seasonal Theme (Tết 2027) Test Suite
 * Covers migration 20261013000100_seasonal_theme_tet2027:
 *  1. Deploy default: the seeded row is DEFAULT and not active — nothing turns itself on.
 *  2. Read fan-out: OWNER, MANAGER and STAFF all receive the same resolved configuration.
 *  3. Write boundary: only OWNER may change it; MANAGER/STAFF and anon are denied.
 *  4. Table privileges: clients may SELECT the row (Realtime precondition) but never write it.
 *  5. TET_2027 activates immediately, DEFAULT deactivates again.
 *  6. AUTO follows the OWNER-configured window in Asia/Ho_Chi_Minh, inclusive at both bounds.
 *  7. Validation: SEASONAL_WINDOW_REQUIRED, SEASONAL_WINDOW_REVERSED, SEASONAL_MODE_INVALID,
 *     INVALID_DATE, INVALID_INPUT for unknown keys.
 *  8. Partial payloads keep the stored schedule (mode change never wipes the dates).
 *  9. Cinematic opening is an independent switch.
 * 10. Audit trail records SEASONAL_THEME_CHANGED with before/after.
 * 11. Isolation: the seasonal row never leaks into get_settings and never moves business data.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runSeasonalThemeTetTests(externalDb, { engine = 'pglite' } = {}) {
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Seasonal Theme (Tết 2027) Test Suite ---')
    let passed = 0
    const pass = (name) => console.log(`PASS ${++passed}. ${name}`)

    const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map((role) => [role, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const call = (user, name, data) => run(user, (client) =>
      data === undefined ? rpc(client, name) : rpc(client, name, '$1::jsonb', [JSON.stringify(data)]))
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const deny = (operation, expression = /ACCESS_DENIED|permission denied|row-level security|is not permitted/i) =>
      assert.rejects(operation, expression)

    const iso = (offsetDays) => {
      const d = new Date(`${today}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + offsetDays)
      return d.toISOString().slice(0, 10)
    }

    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `seasonal-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2,can_view_financials=$3 WHERE id=$4', [
        name === 'disabled' ? 'STAFF' : name.toUpperCase(),
        name !== 'disabled',
        name === 'owner',
        id
      ])
    }
    const today = (await row('SELECT private.today()::text AS day')).day

    // 1. Deploy default
    assert.equal((await call('staff', 'get_seasonal_theme')).mode, 'DEFAULT')
    assert.equal((await call('owner', 'get_seasonal_theme')).is_active, false)
    assert.equal((await call('owner', 'get_seasonal_theme')).cinematic_enabled, false)
    pass('Fresh deploy seeds DEFAULT with no seasonal layer and no cinematic')

    // 2 + 3. Read fan-out and write boundary
    for (const user of ['owner', 'manager', 'staff']) assert.equal((await call(user, 'get_seasonal_theme')).mode, 'DEFAULT')
    pass('OWNER, MANAGER and STAFF all read the same shared configuration')
    for (const user of ['manager', 'staff']) await deny(() => call(user, 'save_seasonal_theme', { mode: 'TET_2027' }))
    await deny(() => asUser(db, null, (client) => rpc(client, 'save_seasonal_theme', '$1::jsonb', ['{"mode":"TET_2027"}']), 'anon'), /does not exist|permission denied|ACCESS_DENIED/i)
    await deny(() => asUser(db, null, (client) => rpc(client, 'get_seasonal_theme'), 'anon'), /does not exist|permission denied|ACCESS_DENIED/i)
    pass('Only OWNER may change the system-wide theme; MANAGER/STAFF/anon are denied')
    await deny(() => call('disabled', 'get_seasonal_theme'))
    pass('A disabled account cannot read the configuration either')

    // 4. Table privileges
    await deny(() => run('owner', (client) => client.query("UPDATE public.seasonal_theme_config SET mode='TET_2027'")))
    await deny(() => run('owner', (client) => client.query('DELETE FROM public.seasonal_theme_config')))
    await deny(() => run('staff', (client) => client.query('INSERT INTO public.seasonal_theme_config(id) VALUES(true)')))
    assert.equal((await run('staff', (client) => client.query('SELECT mode FROM public.seasonal_theme_config'))).rows.length, 1)
    pass('Clients get SELECT only — writes are reachable through the OWNER RPC alone')

    // 5. TET_2027 on, DEFAULT off
    const on = await call('owner', 'save_seasonal_theme', { mode: 'TET_2027' })
    assert.equal(on.mode, 'TET_2027')
    assert.equal(on.is_active, true)
    for (const user of ['owner', 'manager', 'staff']) assert.equal((await call(user, 'get_seasonal_theme')).is_active, true)
    pass('OWNER turning TET_2027 on activates the theme for every role')
    const off = await call('owner', 'save_seasonal_theme', { mode: 'DEFAULT' })
    assert.equal(off.is_active, false)
    pass('OWNER turning it off returns every account to the default interface')

    // 6. AUTO window
    await call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: iso(-5), tet_end: iso(5) })
    assert.equal((await call('staff', 'get_seasonal_theme')).is_active, true)
    pass('AUTO inside the configured window is active')
    await call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: today, tet_end: today })
    assert.equal((await call('staff', 'get_seasonal_theme')).is_active, true)
    pass('AUTO window bounds are inclusive on both days')
    await call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: iso(1), tet_end: iso(30) })
    assert.equal((await call('staff', 'get_seasonal_theme')).is_active, false)
    await call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: iso(-30), tet_end: iso(-1) })
    assert.equal((await call('staff', 'get_seasonal_theme')).is_active, false)
    pass('AUTO is inactive before the window opens and after it closes')

    // 7. Validation
    await deny(() => call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: null, tet_end: null }), /SEASONAL_WINDOW_REQUIRED/)
    await deny(() => call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: iso(10), tet_end: iso(1) }), /SEASONAL_WINDOW_REVERSED/)
    await deny(() => call('owner', 'save_seasonal_theme', { tet_start: iso(10), tet_end: iso(1) }), /SEASONAL_WINDOW_REVERSED/)
    await deny(() => call('owner', 'save_seasonal_theme', { mode: 'TET_2026' }), /SEASONAL_MODE_INVALID/)
    await deny(() => call('owner', 'save_seasonal_theme', { mode: 'tet' }), /SEASONAL_MODE_INVALID/)
    await deny(() => call('owner', 'save_seasonal_theme', { tet_start: '11/10/2026' }), /INVALID_DATE/)
    await deny(() => call('owner', 'save_seasonal_theme', { tet_start: 20261011 }), /INVALID_DATE/)
    await deny(() => call('owner', 'save_seasonal_theme', { store_name: 'not mine' }), /INVALID_INPUT/)
    await deny(() => call('owner', 'save_seasonal_theme', { cinematic_enabled: 'true' }), /INVALID_INPUT/)
    pass('Invalid mode, malformed date, unknown key and bad type are all rejected')

    // 8. Partial payload keeps the schedule
    await call('owner', 'save_seasonal_theme', { mode: 'AUTO', tet_start: iso(-1), tet_end: iso(20) })
    const parked = await call('owner', 'save_seasonal_theme', { mode: 'DEFAULT' })
    assert.equal(parked.mode, 'DEFAULT')
    assert.equal(parked.is_active, false)
    assert.equal(parked.tet_start, iso(-1))
    assert.equal(parked.tet_end, iso(20))
    pass('Switching to DEFAULT keeps the schedule so next year is not re-typed')

    // 9. Cinematic is independent
    const cine = await call('owner', 'save_seasonal_theme', { cinematic_enabled: true })
    assert.equal(cine.cinematic_enabled, true)
    assert.equal(cine.mode, 'DEFAULT')
    assert.equal(cine.is_active, false)
    assert.equal((await call('owner', 'save_seasonal_theme', { cinematic_enabled: false })).cinematic_enabled, false)
    pass('The cinematic opening toggles independently of the theme mode')

    // 10. Audit
    const audits = (await db.query("SELECT * FROM public.audit_logs WHERE entity_type='seasonal_theme_config' ORDER BY created_at")).rows
    assert.ok(audits.length >= 10)
    assert.ok(audits.every((entry) => entry.action === 'SEASONAL_THEME_CHANGED'))
    assert.ok(audits.every((entry) => entry.user_id === users.owner))
    const parkedAudit = audits.find((entry) => entry.old_data.mode === 'AUTO' && entry.new_data.mode === 'DEFAULT')
    assert.ok(parkedAudit, 'the AUTO to DEFAULT switch must be audited')
    assert.equal(parkedAudit.new_data.tet_end, iso(20))
    pass('Every change is audited as SEASONAL_THEME_CHANGED with before/after data')
    await deny(() => call('staff', 'list_audit', {}))
    pass('STAFF cannot read the audit trail that records the theme changes')

    // 11. Isolation from business configuration
    await call('owner', 'save_settings', { store_name: 'Cà Rem kiểm thử giao diện' })
    const settings = await call('owner', 'get_settings')
    assert.equal(settings.store_name, 'Cà Rem kiểm thử giao diện')
    assert.equal(Object.hasOwn(settings, 'mode'), false)
    assert.equal(Object.hasOwn(settings, 'seasonal'), false)
    assert.equal(Object.hasOwn(settings, 'tet_start'), false)
    // count(*) comes back as bigint (a string) on embedded postgres, so compare
    // the number rather than the driver's text form.
    const counts = await row('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.sales) AS sales')
    assert.equal(Number(counts.vehicles), 0)
    assert.equal(Number(counts.sales), 0)
    pass('The seasonal layer stays out of get_settings and never touches business data')

    console.log(`\n${passed} seasonal theme checks passed on ${engine}.`)
  } finally {
    if (!externalDb) await db.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('seasonal-theme-tet2027.test.mjs')) {
  const engine = process.argv.includes('--pglite') ? 'pglite' : 'postgres'
  console.log(`Seasonal theme suite: ${engine}`)
  runSeasonalThemeTetTests(null, { engine }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
