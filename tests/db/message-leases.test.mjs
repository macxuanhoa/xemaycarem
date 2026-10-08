import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Real separate PostgreSQL connections; all identities/jobs are disposable synthetic data.
export async function runMessageLeaseTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = { owner: randomUUID(), manager: randomUUID(), staff: randomUUID(), other: randomUUID() }
  let passed = 0, day
  const check = async (name, action) => { await action(); passed++; console.log(`PASS message-leases ${passed}. ${name}`) }
  const call = (actor, name, sql, args, connection = db) => asUser(connection, users[actor], c => rpc(c, name, sql, args))
  const claim = (id, actor = 'staff', connection = db, mode = 'MOCK') => call(actor, 'claim_message', '$1::uuid,$2::text', [id, mode], connection)
  const finish = (job, actor = 'staff', connection = db) => call(actor, 'finish_mock_message', '$1::uuid,$2::text,$3::uuid', [job.id, `mock_${job.id}`, job.lease_token], connection)
  const fail = job => call('staff', 'fail_message', '$1::uuid,$2::text,$3::text,$4::boolean,$5::uuid', [job.id, 'SYNTHETIC_TIMEOUT', 'Lỗi thử nghiệm.', false, job.lease_token])
  const skip = job => call('staff', 'skip_message', '$1::uuid,$2::text,$3::text,$4::uuid', [job.id, 'PROVIDER_NOT_CONFIGURED', 'Chưa cấu hình nhà cung cấp.', job.lease_token])
  const current = async id => (await db.query('SELECT to_jsonb(o) AS job FROM public.message_outbox o WHERE id=$1', [id])).rows[0].job
  const expire = id => db.query("UPDATE public.message_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id])
  const createJob = async () => {
    const vehicle = await call('owner', 'save_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), vehicle_type: 'Xe tay ga', purchase_date: day, purchase_price: 100 })])
    const sale = await call('staff', 'sell_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), vehicle_id: vehicle, customer_name: 'Synthetic', customer_phone: '0912345678', sale_date: day, sale_price: 1000, initial_payment: 0 })])
    return call('staff', 'get_sale_communication', '$1::uuid', [sale])
  }
  const sentAudits = async id => Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='MESSAGE_SENT'", [id])).rows[0].n)
  try {
    await db.exec("SET statement_timeout='15s'")
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `lease-${id}@example.test`, JSON.stringify({ full_name: `Synthetic ${name}` })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name === 'other' ? 'STAFF' : name.toUpperCase(), id])
    }
    day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    await call('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: true, sale_thank_you_enabled: true, primary_message_channel: 'SMS' })])

    await check('legacy worker claim/finish/fail/skip fail closed without changing the queued job', async () => {
      const job = await createJob()
      for (const [name, sql, args] of [
        ['claim_message', '$1::uuid', [job.id]],
        ['finish_mock_message', '$1::uuid,$2::text', [job.id, 'mock_legacy']],
        ['fail_message', '$1::uuid,$2::text,$3::text,$4::boolean', [job.id, 'TIMEOUT', 'Synthetic', false]],
        ['skip_message', '$1::uuid,$2::text,$3::text', [job.id, 'DISABLED', 'Synthetic']],
      ]) await assert.rejects(() => call('staff', name, sql, args), /CLIENT_UPGRADE_REQUIRED/)
      assert.equal((await current(job.id)).status, 'QUEUED')
      assert.equal((await current(job.id)).attempt_count, 0)
      const upgraded = await claim(job.id)
      assert.equal(upgraded.status, 'PROCESSING')
    })

    if (db.connection) await check('overlapping claimers wait on a real row lock and only one acquires a lease', async () => {
      const job = await createJob()
      const clients = [await db.connection(), await db.connection()]
      let pending
      try {
        await Promise.all(clients.map(c => c.exec("SET statement_timeout='15s'")))
        await clients[0].exec('BEGIN')
        const first = await claim(job.id, 'staff', clients[0])
        pending = claim(job.id, 'other', clients[1])
        let blocked = false
        for (let i = 0; i < 150; i++) {
          const count = Number((await db.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n)
          if (count >= 1) { blocked = true; break }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(blocked, true, 'The second independent claimer must wait on the first transaction')
        await clients[0].exec('COMMIT')
        const results = [first, await pending]
        assert.equal(results.filter(result => result.id).length, 1)
        assert.equal((await current(job.id)).total_attempt_count, 1)
      } finally {
        await clients[0].exec('ROLLBACK').catch(() => {})
        if (pending) await pending
        await Promise.all(clients.map(c => c.close()))
      }
    })
    else console.log('NOT VERIFIED message lease actual concurrency: PGlite has one session')

    await check('live lease cannot be stolen; crash after claim is recovered after expiry with a fresh token', async () => {
      const job = await createJob(), first = await claim(job.id)
      assert.deepEqual(await claim(job.id, 'other'), {})
      await expire(job.id)
      const second = await claim(job.id, 'other')
      assert.equal(second.id, first.id)
      assert.notEqual(second.lease_token, first.lease_token)
      assert.equal(second.attempt_count, 2)
      assert.equal(second.total_attempt_count, 2)
      assert.equal((await finish(second, 'other')).status, 'SENT')
    })

    await check('expired/stale/different-actor workers cannot finish/fail/skip/renew a newer lease', async () => {
      const first = await claim((await createJob()).id)
      await assert.rejects(() => finish(first, 'other'), /MESSAGE_LEASE_CONFLICT/)
      await expire(first.id)
      await assert.rejects(() => finish(first), /MESSAGE_LEASE_EXPIRED/)
      await claim(first.id, 'other')
      for (const mutation of [() => finish(first), () => fail(first), () => skip(first),
        () => call('staff', 'renew_message_lease', '$1::uuid,$2::uuid', [first.id, first.lease_token])]) {
        await assert.rejects(mutation, /MESSAGE_LEASE_CONFLICT/)
      }
      assert.equal((await current(first.id)).status, 'PROCESSING')
      assert.equal(await sentAudits(first.id), 0)
    })

    await check('crash after MOCK send replays the same durable delivery identity, not a second send result', async () => {
      const first = await claim((await createJob()).id)
      const deliveredIdentity = `mock_${first.id}` // actual provider deterministic identity is unit tested
      await expire(first.id) // worker dies after provider returned but before completion RPC
      const second = await claim(first.id, 'other')
      assert.equal(`mock_${second.id}`, deliveredIdentity)
      const sent = await finish(second, 'other')
      assert.equal(sent.provider_message_id, deliveredIdentity)
      assert.equal(await sentAudits(first.id), 1)
    })

    await check('completion timeout-after-commit replay returns the result and emits one SENT audit/history', async () => {
      const job = await claim((await createJob()).id)
      await finish(job) // successful commit whose response is deliberately discarded
      const replay = await finish(job)
      assert.equal(replay.status, 'SENT')
      assert.equal(await sentAudits(job.id), 1)
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.customer_communications WHERE sale_id=$1 AND status='SENT'", [job.sale_id])).rows[0].n), 1)
      assert.deepEqual(await claim(job.id, 'other'), {})
    })

    await check('valid heartbeat renews; unsupported provider or changed mode fails before any delivery', async () => {
      const job = await claim((await createJob()).id)
      const renewed = await call('staff', 'renew_message_lease', '$1::uuid,$2::uuid', [job.id, job.lease_token])
      assert.ok(new Date(renewed.lease_expires_at) >= new Date(job.lease_expires_at))
      await assert.rejects(() => claim(job.id, 'staff', db, 'SMS'), /MESSAGE_PROVIDER_NOT_SUPPORTED/)
      await expire(job.id)
      await assert.rejects(() => claim(job.id, 'other', db, 'DISABLED'), /MESSAGE_PROVIDER_MODE_CONFLICT/)
      assert.equal((await current(job.id)).total_attempt_count, 1)
      await db.query("UPDATE public.message_outbox SET lease_provider_mode=NULL,lease_expires_at=clock_timestamp()+interval '120 seconds' WHERE id=$1", [job.id])
      await assert.rejects(() => finish(job), /INVALID_PROVIDER_MESSAGE_ID/)
    })

    await check('repeated worker crashes reach terminal FAILED; manual retry retains lifetime attempt count', async () => {
      const job = await createJob()
      for (let attempt = 1; attempt <= 3; attempt++) {
        assert.equal((await claim(job.id)).attempt_count, attempt)
        await expire(job.id)
      }
      assert.deepEqual(await claim(job.id), {})
      assert.equal((await current(job.id)).status, 'FAILED')
      assert.equal((await current(job.id)).last_error_code, 'ATTEMPTS_EXHAUSTED')
      await assert.rejects(() => call('staff', 'retry_sale_thank_you', '$1::uuid', [job.sale_id]), /ACCESS_DENIED/)
      const retried = await call('manager', 'retry_sale_thank_you', '$1::uuid', [job.sale_id])
      assert.equal(retried.attempt_count, 0)
      assert.equal(retried.total_attempt_count, 3)
      assert.equal((await claim(job.id)).total_attempt_count, 4)
    })

    await check('unknown legacy outcome is quarantined; neither retry nor claim bypasses manual evidence review', async () => {
      const job = await createJob()
      await db.query("UPDATE public.message_outbox SET status='PROCESSING',attempt_count=1,total_attempt_count=1,lease_token=NULL,lease_provider_mode=NULL WHERE id=$1", [job.id])
      assert.deepEqual(await claim(job.id), {})
      assert.equal((await current(job.id)).delivery_review_required, true)
      assert.equal((await current(job.id)).status, 'FAILED')
      await assert.rejects(() => call('owner', 'retry_sale_thank_you', '$1::uuid', [job.sale_id]), /MESSAGE_DELIVERY_REVIEW_REQUIRED/)
      await assert.rejects(() => call('owner', 'resolve_message_delivery', '$1::uuid,$2::text,$3::text', [job.id, 'CONFIRMED_NOT_SENT', '']), /MESSAGE_DELIVERY_EVIDENCE_REQUIRED/)
      await assert.rejects(() => call('staff', 'resolve_message_delivery', '$1::uuid,$2::text,$3::text', [job.id, 'CONFIRMED_NOT_SENT', 'CASE-TEST-0001']), /ACCESS_DENIED/)
      const reviewed = await call('manager', 'resolve_message_delivery', '$1::uuid,$2::text,$3::text', [job.id, 'CONFIRMED_NOT_SENT', 'CASE-TEST-0001'])
      assert.equal(reviewed.delivery_review_required, false)
      assert.equal(reviewed.status, 'FAILED') // explicit separate retry, never send during reconciliation
      await call('manager', 'retry_sale_thank_you', '$1::uuid', [job.sale_id])
      assert.equal((await claim(job.id)).status, 'PROCESSING')
    })

    await check('verified already-sent outcome records evidence and cannot be sent again', async () => {
      const job = await createJob()
      await db.query("UPDATE public.message_outbox SET status='FAILED',delivery_review_required=true,last_error_code='DELIVERY_OUTCOME_UNKNOWN' WHERE id=$1", [job.id])
      const reviewed = await call('owner', 'resolve_message_delivery', '$1::uuid,$2::text,$3::text', [job.id, 'CONFIRMED_SENT', 'PROVIDER-TEST-0001'])
      assert.equal(reviewed.status, 'SENT')
      assert.equal(reviewed.provider_message_id, 'PROVIDER-TEST-0001')
      assert.deepEqual(await claim(job.id), {})
      await assert.rejects(() => call('owner', 'retry_sale_thank_you', '$1::uuid', [job.sale_id]), /MESSAGE_NOT_RETRYABLE/)
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='MESSAGE_DELIVERY_RECONCILED'", [job.id])).rows[0].n), 1)
    })

    await check('disabled provider is skipped safely; bounded error backoff retains deterministic mode', async () => {
      const disabled = await claim((await createJob()).id, 'staff', db, 'DISABLED')
      assert.equal((await skip(disabled)).status, 'SKIPPED')
      const job = await claim((await createJob()).id)
      const failed = await fail(job)
      assert.equal(failed.status, 'QUEUED')
      assert.equal(failed.lease_token, null)
      assert.ok(new Date(failed.next_attempt_at) > new Date())
      assert.deepEqual(await claim(job.id), {})
    })

    await check('worker processing does not alter sale/inventory/debt/snapshot/financial audit; RLS stays RPC only', async () => {
      const job = await createJob()
      const before = await call('owner', 'get_sale', '$1::uuid', [job.sale_id])
      const financeAudits = async () => (await db.query("SELECT id,action,new_data FROM public.audit_logs WHERE entity_id=$1 AND action='CREATE_SALE'", [job.sale_id])).rows
      const beforeAudits = await financeAudits()
      await finish(await claim(job.id))
      const screen = await call('staff', 'get_sale_communication', '$1::uuid', [job.sale_id])
      assert.equal(Object.hasOwn(screen, 'lease_token'), false)
      assert.equal(Object.hasOwn(screen, 'lease_actor'), false)
      assert.deepEqual(await call('owner', 'get_sale', '$1::uuid', [job.sale_id]), before)
      assert.deepEqual(await financeAudits(), beforeAudits)
      await assert.rejects(() => asUser(db, users.staff, c => c.query("UPDATE public.message_outbox SET status='QUEUED' WHERE id=$1", [job.id])), /permission denied|row-level security/i)
      await assert.rejects(() => asUser(db, null, c => rpc(c, 'claim_message', '$1::uuid,$2::text', [job.id, 'MOCK']), 'anon'), /permission denied|ACCESS_DENIED/i)
      await assert.rejects(() => asUser(db, users.staff, c => c.query('SELECT private.lock_message_lease($1,$2)', [job.id, job.lease_token])), /permission denied/i)
    })
    console.log(`${passed} message lease checks passed on ${engine}.`)
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let status = 0
  try { await runMessageLeaseTests() } catch (error) { console.error(error); status = 1 }
  process.exit(status)
}
