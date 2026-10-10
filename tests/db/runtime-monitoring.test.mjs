import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'
const event = { source: 'rpc', code: 'RPC_SERVER_ERROR', operation: 'get_vehicle', route: '/vehicles/:id', release: '1.0.0', environment: 'production' }

export async function runRuntimeMonitoringTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = Object.fromEntries(['owner', 'manager', 'staff', 'disabled'].map((name) => [name, randomUUID()]))
  let passed = 0
  const test = async (name, check) => { await check(); console.log(`PASS ${++passed}. ${name}`) }
  const run = (name, fn) => asUser(db, users[name], fn)
  const report = (name, data = event) => run(name, (client) => rpc(client, 'report_client_issue', '$1::jsonb', [JSON.stringify(data)]))
  const list = (name, days = 7) => run(name, (client) => rpc(client, 'list_client_issues', '$1::integer', [days]))
  const deny = (fn) => assert.rejects(fn, /ACCESS_DENIED|ACCOUNT_DISABLED|permission denied/i)
  try {
    console.log('\n--- Running privacy-safe runtime monitoring suite ---')
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `runtime-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=$2 WHERE id=$3', [name === 'owner' ? 'OWNER' : name === 'manager' ? 'MANAGER' : 'STAFF', name !== 'disabled', id])
    }
    await test('active roles report diagnostics and duplicates aggregate without business writes', async () => {
      const before = (await db.query('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.audit_logs) AS audits')).rows[0]
      for (const name of ['owner', 'manager', 'staff']) assert.deepEqual(await report(name), { recorded: true })
      const digest = await list('owner')
      assert.equal(digest.total_occurrences, 3)
      assert.equal(digest.items.length, 1)
      assert.equal(digest.items[0].occurrences, 3)
      assert.deepEqual(Object.keys(digest.items[0]).sort(), ['code', 'environment', 'first_seen', 'last_seen', 'occurrences', 'operation', 'release', 'route', 'source'])
      assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM public.vehicles) AS vehicles,(SELECT count(*) FROM public.audit_logs) AS audits')).rows[0], before)
    })
    await test('only OWNER can read diagnostics; no browser role reads or writes tables', async () => {
      for (const name of ['manager', 'staff', 'disabled']) await deny(() => list(name))
      for (const name of ['owner', 'manager', 'staff']) {
        await deny(() => run(name, (client) => client.query('SELECT * FROM public.client_issues')))
        await deny(() => run(name, (client) => client.query("UPDATE public.client_issues SET occurrences=999")))
        await deny(() => run(name, (client) => client.query('SELECT * FROM private.client_issue_rates')))
      }
      await deny(() => report('disabled'))
      await deny(() => asUser(db, null, (client) => rpc(client, 'report_client_issue', '$1::jsonb', [JSON.stringify(event)]), 'anon'))
      await deny(() => asUser(db, null, (client) => rpc(client, 'list_client_issues'), 'anon'))
    })
    await test('unknown fields and PII-bearing values are rejected before storage', async () => {
      const bad = [
        { ...event, message: 'PRIVATE' }, { ...event, stack: 'PRIVATE' }, { ...event, payload: { CCCD: '079123456789' } },
        { ...event, route: '/vehicles/079123456789' }, { ...event, operation: '079123456789' },
        { ...event, code: 'PRIVATE_ERROR' }, { ...event, release: 'customer@example.test' }, { ...event, release: '079123456789' },
        { ...event, environment: 'PRIVATE' }, { ...event, source: 'PRIVATE' }, { ...event, code: null }, {}, [], null,
      ]
      for (const data of bad) await assert.rejects(() => report('staff', data), /INVALID_CLIENT_ISSUE/)
      assert.equal((await list('owner')).total_occurrences, 3)
    })
    await test('server caps reports per actor at 30 per minute and reopens the next window', async () => {
      await db.query('UPDATE private.client_issue_rates SET hits=0 WHERE actor=$1', [users.staff])
      for (let i = 0; i < 30; i++) assert.deepEqual(await report('staff'), { recorded: true })
      assert.deepEqual(await report('staff'), { recorded: false, reason: 'rate_limited' })
      await db.query("UPDATE private.client_issue_rates SET window_start=now()-interval '2 minutes' WHERE actor=$1", [users.staff])
      assert.deepEqual(await report('staff'), { recorded: true })
    })
    await test('old diagnostics expire after 90 days and digest ranges stay bounded', async () => {
      await db.query("INSERT INTO public.client_issues(issue_day,source,code,operation,route,release,environment,first_seen,last_seen) VALUES((now()-interval '91 days')::date,'global','JS_ERROR','global','/other','unknown','production',now()-interval '91 days',now()-interval '91 days')")
      await report('owner', { ...event, release: '1.0.1' })
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.client_issues WHERE last_seen<now()-interval '90 days'")).rows[0].n), 0)
      assert.equal((await list('owner', 9999)).days, 90)
      assert.equal((await list('owner', 0)).days, 1)
    })
    await test('daily aggregate capacity is bounded without dropping updates to existing groups', async () => {
      const count = Number((await db.query("SELECT count(*) AS n FROM public.client_issues WHERE issue_day=(now() AT TIME ZONE 'UTC')::date")).rows[0].n)
      await db.query("INSERT INTO public.client_issues(issue_day,source,code,operation,route,release,environment) SELECT (now() AT TIME ZONE 'UTC')::date,'rpc','RPC_SERVER_ERROR','get_vehicle','/vehicles/:id','99.1.'||i,'production' FROM generate_series(1,$1::integer) i", [1000 - count])
      assert.deepEqual(await report('owner', { ...event, release: '99.2.1' }), { recorded: false, reason: 'capacity' })
      assert.deepEqual(await report('owner', event), { recorded: true })
      const digest = await list('owner')
      assert.equal(digest.items.length, 50)
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.client_issues WHERE issue_day=(now() AT TIME ZONE 'UTC')::date")).rows[0].n), 1000)
    })
    if (db.connection) await test('a report never waits on another actor stale rate counter', async () => {
      await db.query("UPDATE private.client_issue_rates SET window_start=now()-interval '2 days',hits=0 WHERE actor IN ($1,$2)", [users.manager, users.staff])
      const reporting = await db.connection(), holding = await db.connection()
      let pending, timer
      try {
        await holding.exec('BEGIN')
        await holding.query('SELECT actor FROM private.client_issue_rates WHERE actor=$1 FOR UPDATE', [users.staff])
        pending = asUser(reporting, users.manager, (client) => rpc(client, 'report_client_issue', '$1::jsonb', [JSON.stringify(event)]))
        const result = await Promise.race([
          pending,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reporter blocked on another actor rate counter')), 2000) }),
        ])
        assert.deepEqual(result, { recorded: true })
      } finally {
        clearTimeout(timer)
        await holding.exec('ROLLBACK')
        if (pending) await pending.catch(() => {})
        await reporting.close(); await holding.close()
      }
    })
    console.log(`--- Runtime monitoring: ${passed} checks passed ---`)
    return passed
  } finally { if (!externalDb) await db.close() }
}
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tests/db/runtime-monitoring.test.mjs')) {
  try { await runRuntimeMonitoringTests(null, { engine: process.argv.includes('--pglite') ? 'pglite' : 'postgres' }) }
  catch (error) { console.error(error); process.exitCode = 1 }
}
