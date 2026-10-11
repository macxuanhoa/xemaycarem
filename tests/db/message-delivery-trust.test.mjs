import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

// Real disposable PostgreSQL verification; no provider API, secrets or delivery.
export async function runMessageDeliveryTrustTests(externalDb, { engine = 'postgres' } = {}) {
  const db = externalDb ?? await createDatabase({ engine })
  const users = { owner: randomUUID(), staff: randomUUID() }
  let passed = 0
  const check = async (name, action) => { await action(); passed++; console.log('PASS message-delivery-trust ' + passed + '. ' + name) }
  const call = (actor, name, sql, args) => asUser(db, users[actor], client => rpc(client, name, sql, args))
  const svc = (name, sql, args) => asUser(db, null, client => rpc(client, name, sql, args), 'service_role')
  const current = async id => (await db.query('SELECT to_jsonb(o) AS job FROM public.message_outbox o WHERE id=$1', [id])).rows[0].job
  const claim = (id, mode = 'SMS') => call('staff', 'claim_message', '$1::uuid,$2::text', [id, mode])
  const finish = (job, id = 'provider-real-id') => svc('finish_message', '$1::uuid,$2::text,$3::uuid', [job.id, id, job.lease_token])
  const delivered = (job, id = 'provider-real-id') => svc('mark_message_delivered', '$1::uuid,$2::text,$3::uuid', [job.id, id, job.lease_token])
  let day
  const createJob = async () => {
    const vehicle = await call('staff', 'save_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), vehicle_type: 'Xe tay ga', purchase_date: day, purchase_price: 100 })])
    const sale = await call('staff', 'sell_vehicle', '$1::jsonb', [JSON.stringify({ request_id: randomUUID(), vehicle_id: vehicle,
      customer_name: 'Synthetic Trust', customer_phone: '0912345678', sale_date: day, sale_price: 1000, initial_payment: 0 })])
    return call('staff', 'get_sale_communication', '$1::uuid', [sale])
  }
  try {
    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, 'trust-' + id + '@example.test', JSON.stringify({ full_name: 'Synthetic ' + name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [name.toUpperCase(), id])
    }
    day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    await call('owner', 'save_settings', '$1::jsonb', [JSON.stringify({ customer_messaging_enabled: true, sale_thank_you_enabled: true, primary_message_channel: 'SMS' })])

    await check('browsers cannot fabricate official SENT or DELIVERED outcomes', async () => {
      const job = await claim((await createJob()).id)
      for (const actor of ['owner', 'staff']) for (const name of ['finish_message', 'mark_message_delivered']) {
        await assert.rejects(() => call(actor, name, '$1::uuid,$2::text,$3::uuid', [job.id, 'fabricated-id', job.lease_token]), /permission denied|ACCESS_DENIED/i)
      }
      assert.equal((await current(job.id)).status, 'PROCESSING')
      assert.equal((await current(job.id)).provider_message_id, null)
    })

    await check('trusted service records real ID once and refuses changed replay identity', async () => {
      const job = await claim((await createJob()).id)
      assert.equal((await finish(job)).status, 'SENT')
      assert.equal((await finish(job)).status, 'SENT')
      await assert.rejects(() => finish(job, 'different-real-id'), /INVALID_PROVIDER_MESSAGE_ID/)
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='MESSAGE_SENT'", [job.id])).rows[0].n), 1)
    })

    await check('trusted delivery requires the same actual provider ID and supports callback replay', async () => {
      const job = await claim((await createJob()).id)
      await finish(job)
      await assert.rejects(() => delivered(job, 'wrong-delivery-id'), /INVALID_PROVIDER_MESSAGE_ID/)
      assert.equal((await delivered(job)).status, 'DELIVERED')
      assert.equal((await delivered(job)).status, 'DELIVERED')
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='MESSAGE_DELIVERED'", [job.id])).rows[0].n), 1)
    })

    await check('expired official lease becomes manual review without resending', async () => {
      const job = await claim((await createJob()).id)
      await db.query("UPDATE public.message_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
      await assert.rejects(() => finish(job), /MESSAGE_LEASE_EXPIRED/)
      assert.deepEqual(await claim(job.id), {})
      const failed = await current(job.id)
      assert.equal(failed.status, 'FAILED')
      assert.equal(failed.delivery_review_required, true)
      assert.equal(failed.last_error_code, 'DELIVERY_OUTCOME_UNKNOWN')
      assert.equal(failed.total_attempt_count, 1)
      await assert.rejects(() => call('owner', 'retry_sale_thank_you', '$1::uuid', [job.sale_id]), /MESSAGE_DELIVERY_REVIEW_REQUIRED/)
    })

    await check('official ambiguous failure cannot be auto-requeued even if caller requests retry', async () => {
      const job = await claim((await createJob()).id)
      const failed = await call('staff', 'fail_message', '$1::uuid,$2::text,$3::text,$4::boolean,$5::uuid',
        [job.id, 'NETWORK_FAILURE', 'Synthetic timeout', false, job.lease_token])
      assert.equal(failed.status, 'FAILED')
      assert.equal(failed.delivery_review_required, true)
      assert.equal(failed.last_error_code, 'DELIVERY_OUTCOME_UNKNOWN')
      assert.equal(failed.next_attempt_at, null)
      assert.deepEqual(await claim(job.id), {})
    })

    await check('official provider/channel mismatch cannot acquire a worker lease', async () => {
      const job = await createJob()
      await assert.rejects(() => claim(job.id, 'ZALO_OA'), /MESSAGE_PROVIDER_MODE_CONFLICT/)
      assert.equal((await current(job.id)).status, 'QUEUED')
      assert.equal((await current(job.id)).total_attempt_count, 0)
    })

    await check('MOCK deterministic replay and fenced completion stay supported', async () => {
      const first = await claim((await createJob()).id, 'MOCK')
      await db.query("UPDATE public.message_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id])
      const second = await claim(first.id, 'MOCK')
      assert.notEqual(second.lease_token, first.lease_token)
      assert.equal(second.delivery_review_required, false)
      const result = await call('staff', 'finish_mock_message', '$1::uuid,$2::text,$3::uuid', [second.id, 'mock_' + second.id, second.lease_token])
      assert.equal(result.status, 'SENT')
    })
    return passed
  } finally { if (!externalDb) await db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('PASS ' + await runMessageDeliveryTrustTests() + ' trusted messaging database checks (provider delivery NOT VERIFIED)')
}

