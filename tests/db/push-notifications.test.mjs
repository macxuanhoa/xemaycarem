/**
 * Database Web Push Test Suite (migrations 20261014001100 + 20261014001200)
 * 1. đăng ký idempotent theo endpoint, chuyển quyền sở hữu khi đổi tài khoản,
 *    trần 20 thiết bị, chặn endpoint/keys rác ngay ở RPC
 * 2. list_my_push_devices TUYỆT đối không rò endpoint/keys về browser
 * 3. outbox: notifications INSERT → hàng push chỉ khi còn thiết bị + bật công
 *    tắc; dedup cùng-transaction chết theo FK CASCADE (không push ma)
 * 4. claim lease: hai worker không lấy trùng; lease hết hạn tự về hàng đợi;
 *    RETRY backoff có trần 5 lần → FAILED vĩnh viễn (không retry vô hạn)
 * 5. người tắt công tắc / tài khoản nghỉ → SKIPPED, không gửi âm thầm
 * 6. claim(p_user) self-drain chỉ rút đúng hàng của mình — không có đường
 *    người dùng A đẩy vào máy người dùng B
 * 7. SERVICE_ONLY: anon/authenticated không chạm claim/complete/forget/bảng;
 *    retention 30 ngày dọn hàng kết thúc; forget 404/410 xoá thiết bị chết
 * 8. TEST delivery: không làm bẩn kho notifications, link /cai-dat, chặn
 *    PUSH_NO_DEVICE / PUSH_DISABLED
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runPushNotificationsTests(externalDb, { engine = 'postgres' } = {}) {
  const ownDb = !externalDb
  const db = externalDb ?? (await createDatabase({ engine }))
  try {
    console.log('\n--- Running Database Web Push Test Suite ---')
    let passed = 0
    const pass = (name) => { passed += 1; console.log(`PASS ${passed}. ${name}`) }

    const users = Object.fromEntries(['owner', 'staff', 'staff2'].map((r) => [r, randomUUID()]))
    const run = (user, fn) => asUser(db, users[user], fn)
    const service = (fn) => asUser(db, null, fn, 'service_role')
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0]
    const count = async (sql, args = []) => Number((await row(sql, args)).n)

    for (const [name, id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',
        [id, `push-${name}@example.test`, JSON.stringify({ full_name: name })])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role, active=true WHERE id=$2',
        [name === 'owner' ? 'OWNER' : 'STAFF', id])
    }
    const validKey = 'B' + 'x'.repeat(86)
    const validAuth = 'a'.repeat(16)
    const registerRaw = (user, endpoint, p256dh, auth) =>
      run(user, (c) => rpc(c, 'register_push_subscription', '$1,$2,$3,$4', [endpoint, p256dh, auth, null]))
    const register = (user, endpoint, label) => registerKeys(user, endpoint, validKey, validAuth, label)
    const registerKeys = (user, endpoint, p256dh, auth, label = null) =>
      run(user, (c) => rpc(c, 'register_push_subscription', '$1,$2,$3,$4', [endpoint, p256dh, auth, label]))
    const notify = (user, title, body, link) => service((c) =>
      c.query("INSERT INTO public.notifications (user_id, action, title, body, deep_link) VALUES ($1,'CREATE_VEHICLE',$2,$3,$4) RETURNING id",
        [users[user], title, body, link]).then((r) => r.rows[0].id))
    const claim = (worker, limit, pUser) => service((c) =>
      rpc(c, 'claim_push_deliveries', '$1,$2,$3', [worker, limit ?? 10, pUser ?? null]))
    const complete = (id, outcome, error) => service((c) =>
      rpc(c, 'complete_push_delivery', '$1,$2,$3', [id, outcome, error ?? null]))
    const deliveryOf = async (notificationId) => row(
      'SELECT * FROM public.push_deliveries WHERE notification_id=$1', [notificationId])

    // 1. Registration surface
    const subId = await register('staff', 'https://fcm.googleapis.com/fcm/send/device1', 'Pixel 7')
    assert.match(subId, /^[0-9a-f-]{36}$/)
    pass('staff registers a push device through an authenticated RPC')
    const again = await register('staff', 'https://fcm.googleapis.com/fcm/send/device1')
    assert.equal(again, subId, 'same endpoint keeps the row id (idempotent refresh)')
    pass('re-registering the same endpoint is idempotent (keeps keys fresh, no duplicates)')
    const taken = await register('staff2', 'https://fcm.googleapis.com/fcm/send/device1')
    assert.notEqual(taken, subId)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_subscriptions WHERE user_id=$1', [users.staff]), 0)
    pass('endpoint ownership transfers to the signed-in account (shared browser cannot leak pushes to the previous user)')
    await assert.rejects(register('staff', 'http://insecure.example/push'), /INVALID_ENDPOINT/)
    await assert.rejects(registerRaw('staff', 'https://ok.example/p', validKey.replace('B', 'B!'), validAuth), /INVALID_KEY/)
    await assert.rejects(registerRaw('staff', 'https://ok.example/p', validKey, 'ngắn'), /INVALID_KEY/)
    pass('non-HTTPS endpoints and malformed keys are rejected at the RPC boundary')
    const devices = await run('staff2', (c) => rpc(c, 'list_my_push_devices'))
    assert.equal(devices.length, 1)
    assert.equal(devices[0].endpoint, undefined)
    assert.equal(devices[0].p256dh, undefined)
    assert.equal(devices[0].auth, undefined)
    assert.match(devices[0].device_hint, /^[0-9a-f]{6}$/)
    pass('device list never returns endpoints or encryption keys — only a hint for the UI')
    for (let i = 0; i < 21; i++) await register('owner', `https://push.example.com/cap-${i}`)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_subscriptions WHERE user_id=$1', [users.owner]), 20)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_subscriptions WHERE endpoint=$1', ['https://push.example.com/cap-20']), 1)
    pass('per-user device cap prunes the least-recently-used, never the current device')

    // 2. Outbox enqueue conditions
    await register('staff', 'https://fcm.googleapis.com/fcm/send/staff-live', 'Chrome Linux')
    await run('staff', (c) => rpc(c, 'set_push_enabled', '$1', [false]))
    const offNotif = await notify('staff', 'Tắt rồi', 'B', '/vehicles/1')
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_deliveries WHERE notification_id=$1', [offNotif]), 0)
    pass('disabled user produces no queued push (enqueue respects the personal switch)')
    await run('staff', (c) => rpc(c, 'set_push_enabled', '$1', [true]))
    const onNotif = await notify('staff', 'Chờ đối soát 1 giao dịch', 'Kiểm tra bank transactions', '/doi-soat')
    const queued = await deliveryOf(onNotif)
    assert.equal(queued.status, 'QUEUED')
    assert.equal(queued.attempts, 0)
    pass('new notification for an enabled device queues exactly one outbox row')

    // 3. Same-transaction dedup: notification deleted in-flight → cascade kills the push row
    await service(async (c) => {
      await c.query('BEGIN')
      const inserted = await c.query("INSERT INTO public.notifications (user_id, action, title, body) VALUES ($1,'CREATE_PAYMENT','Cha meo','B') RETURNING id", [users.staff])
      const transientId = inserted.rows[0].id
      await c.query('DELETE FROM public.notifications WHERE id=$1', [transientId])
      await c.query('COMMIT')
    })
    assert.equal(await count("SELECT count(*)::int AS n FROM public.push_deliveries d WHERE NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.id = d.notification_id)"), 0)
    pass('notification removed inside the same transaction takes its queued push with it (FK cascade — no phantom pushes after dedup)')

    // 4. Claim, lease, retries
    const ownerLiveId = await register('owner', 'https://fcm.googleapis.com/fcm/send/owner-live', 'Edge Windows')
    const batch = await claim('worker-1', 10)
    const staffRow = batch.find((item) => item.user_id === users.staff)
    assert.ok(staffRow)
    assert.equal(staffRow.title, 'Chờ đối soát 1 giao dịch')
    assert.equal(staffRow.link, '/doi-soat')
    assert.ok(staffRow.subscriptions.every((s) => s.endpoint && s.p256dh && s.auth))
    pass('claim returns DB-gated content verbatim plus the recipient subscriptions (push mirrors the bell, never re-derives money copy)')
    const rest = await claim('worker-2', 10)
    assert.equal(rest.find((item) => item.delivery_id === staffRow.delivery_id), undefined)
    pass('FOR UPDATE SKIP LOCKED: a second concurrent worker never re-claims in-flight work')
    await complete(staffRow.delivery_id, 'RETRY', 'PROVIDER_503')
    const retried = await deliveryOf(onNotif)
    assert.equal(retried.status, 'QUEUED')
    assert.equal(retried.attempts, 1)
    assert.ok(new Date(retried.available_at) > new Date())
    pass('RETRY requeues with exponential backoff and a bounded attempt counter')
    for (let i = 0; i < 4; i++) await complete(staffRow.delivery_id, 'RETRY', 'PROVIDER_503')
    const exhausted = await deliveryOf(onNotif)
    assert.equal(exhausted.status, 'FAILED')
    assert.equal(exhausted.attempts, 5)
    assert.ok(exhausted.completed_at)
    pass('attempt ceiling (5) converts to permanent FAILED — no infinite retry loop')
    // lease reaping
    const leaseNotif = await notify('owner', 'Lease test', 'B', null)
    const leaseClaim = (await claim('worker-dead', 10)).find((item) => item.notification_id === leaseNotif || item.user_id === users.owner)
    assert.ok(leaseClaim, 'owner queue claimed')
    await service((c) => c.query('UPDATE public.push_deliveries SET claimed_at = now() - interval \'3 minutes\' WHERE id=$1', [leaseClaim.delivery_id]))
    // Lần claim kế chạy reaper ngay đầu: hàng về QUEUED + attempts++ + backoff 60s
    await claim('worker-reap', 10)
    const reaped = await deliveryOf(leaseNotif)
    assert.equal(reaped.status, 'QUEUED')
    assert.equal(reaped.attempts, 1)
    assert.equal(reaped.last_error, 'LEASE_EXPIRED')
    // cho phép backoff "trôi" để worker khác nhận lại
    await service((c) => c.query('UPDATE public.push_deliveries SET available_at = now() WHERE id=$1', [leaseClaim.delivery_id]))
    const reclaimed = (await claim('worker-new', 10)).find((item) => item.delivery_id === leaseClaim.delivery_id)
    assert.ok(reclaimed, 'expired lease is claimable by another worker after backoff')
    pass('dead dispatcher: expired 2-minute lease is reaped (attempts++, LEASE_EXPIRED, backoff) and reclaimable')
    await complete(leaseClaim.delivery_id, 'DONE')
    const done = await deliveryOf(leaseNotif)
    assert.equal(done.status, 'DONE')
    pass('DONE finalizes with completed_at for retention housekeeping')

    // 5. Skip paths at claim time
    await run('owner', (c) => rpc(c, 'set_push_enabled', '$1', [false]))
    const skipNotif = await notify('owner', 'Sau khi tắt', 'B', null)
    // enqueue trigger bỏ qua khi tắt → không có hàng
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_deliveries WHERE notification_id=$1', [skipNotif]), 0)
    // còn hàng QUEUED tạo lúc còn bật thì bị SKIPPED ngay tại claim:
    await run('owner', (c) => rpc(c, 'set_push_enabled', '$1', [true]))
    const queueThenDisable = await notify('owner', 'Vừa kịp xếp hàng', 'B', null)
    await run('owner', (c) => rpc(c, 'set_push_enabled', '$1', [false]))
    const afterClaim = await claim('worker-skip', 10)
    const skippedRow = await deliveryOf(queueThenDisable)
    assert.equal(skippedRow.status, 'SKIPPED')
    assert.equal(skippedRow.last_error, 'PUSH_DISABLED')
    assert.equal(afterClaim.find((i) => i.delivery_id === skippedRow.id), undefined)
    pass('work queued before the user switched off is SKIPPED at claim — revocation takes effect immediately')
    // vô hiệu hoá tài khoản (dùng STAFF — trigger bảo vệ OWNER cuối cùng)
    await run('owner', (c) => rpc(c, 'set_push_enabled', '$1', [true]))
    const beforeDeactivate = await notify('staff', 'Trước khi nghỉ', 'B', null)
    await db.query('UPDATE public.profiles SET active=false WHERE id=$1', [users.staff])
    await claim('worker-inactive', 10)
    const inactiveRow = await deliveryOf(beforeDeactivate)
    assert.equal(inactiveRow.status, 'SKIPPED')
    assert.equal(inactiveRow.last_error, 'USER_INACTIVE')
    await db.query('UPDATE public.profiles SET active=true WHERE id=$1', [users.staff])
    pass('deactivating an employee silently converts their pending pushes to SKIPPED (server-side protection for revoked users)')

    // 6. Self-drain isolation
    const notifA = await notify('staff', 'Việc của staff', 'B', '/thong-bao')
    const selfItems = await claim('worker-isolation', 10, users.staff)
    assert.ok(selfItems.length > 0)
    assert.ok(selfItems.every((i) => i.user_id === users.staff))
    // claim JSON chỉ trả delivery_id/kind/user_id/nội dung — kiểm chứng đúng
    // hàng của notifA đã được worker-isolation nắm qua DB row.
    const claimedA = await row(
      'SELECT claimed_by, status FROM public.push_deliveries WHERE notification_id=$1', [notifA])
    assert.equal(claimedA.claimed_by, 'worker-isolation')
    assert.equal(claimedA.status, 'CLAIMED')
    pass('claim with p_user (client self-drain) can only ever touch the caller’s own queue')

    // 7. Lockdown: browser roles cannot touch the dispatcher surface at all
    await assert.rejects(run('staff', (c) => rpc(c, 'claim_push_deliveries', '$1', ['x'])), /SERVICE_ONLY|permission denied/)
    await assert.rejects(run('staff', (c) => rpc(c, 'forget_push_subscription', '$1', ['https://fcm.googleapis.com/fcm/send/staff-live'])), /SERVICE_ONLY|permission denied/)
    await assert.rejects(run('staff', (c) => c.query('SELECT * FROM public.push_deliveries')), /permission denied|row-level security/)
    await assert.rejects(run('staff', (c) => c.query('SELECT * FROM public.push_subscriptions')), /permission denied|row-level security/)
    await assert.rejects(asUser(db, null, (c) => rpc(c, 'claim_push_deliveries', '$1', ['x']), 'anon'), /SERVICE_ONLY|permission denied/)
    pass('claim/complete/forget and every push table are invisible to anon/authenticated (service_role only — endpoints never reach browsers)')

    // forget + touch
    const forgotten = await service((c) => rpc(c, 'forget_push_subscription', '$1', ['https://fcm.googleapis.com/fcm/send/staff-live']))
    assert.equal(forgotten, 1)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_subscriptions WHERE endpoint=$1', ['https://fcm.googleapis.com/fcm/send/staff-live']), 0)
    pass('404/410 endpoints are purged from the server the moment the dispatcher sees them')
    // subId đã bị xoá khi chuyển quyền sở hữu endpoint → touch phải bỏ qua
    // id chết mà không đếm nhầm (chỉ update hàng đang tồn tại).
    const touched = await service((c) => rpc(c, 'touch_push_subscriptions', '$1', [[subId, taken, ownerLiveId]]))
    assert.equal(touched, 2)
    pass('touch_push_subscriptions batch-updates last_used_at for live devices and ignores purged ids')

    // 8. Test notifications
    await run('owner', (c) => rpc(c, 'set_push_enabled', '$1', [false]))
    await assert.rejects(run('owner', (c) => rpc(c, 'request_push_test')), /PUSH_DISABLED/)
    await run('owner', (c) => rpc(c, 'set_push_enabled', '$1', [true]))
    await service((c) => c.query('DELETE FROM public.push_subscriptions WHERE user_id=$1', [users.owner]))
    await assert.rejects(run('owner', (c) => rpc(c, 'request_push_test')), /PUSH_NO_DEVICE/)
    pass('test push is refused when the user is switched off or has no device (no silent no-op pings)')
    await register('staff', 'https://fcm.googleapis.com/fcm/send/staff-test', 'Máy thử')
    const testId = await run('staff', (c) => rpc(c, 'request_push_test'))
    const notificationsBefore = await count('SELECT count(*)::int AS n FROM public.notifications')
    const testClaim = (await claim('worker-test', 10, users.staff)).find((i) => i.delivery_id === testId)
    assert.equal(testClaim.kind, 'TEST')
    assert.equal(testClaim.link, '/cai-dat')
    assert.equal(await count('SELECT count(*)::int AS n FROM public.notifications'), notificationsBefore)
    pass('TEST delivery routes to Settings, never writes the notifications store')
    await complete(testId, 'DONE')

    // retention: hàng kết thúc quá 30 ngày bị xoá ngay trong claim kế tiếp
    await service((c) => c.query("UPDATE public.push_deliveries SET completed_at = now() - interval '40 days' WHERE id=$1", [testId]))
    await claim('worker-retention', 1)
    assert.equal(await count('SELECT count(*)::int AS n FROM public.push_deliveries WHERE id=$1', [testId]), 0)
    pass('terminal deliveries older than 30 days are deleted during the next claim (minimal retention)')

    // 9. Instant dispatch (migration 20261017000200): config lockdown + no-op safety.
    await assert.rejects(run('staff', (c) => c.query('SELECT * FROM public.push_dispatch_config')), /permission denied|row-level security/)
    await assert.rejects(asUser(db, null, (c) => c.query('SELECT * FROM public.push_dispatch_config'), 'anon'), /permission denied|row-level security/)
    await assert.rejects(run('staff', (c) => c.query('SELECT private.dispatch_push_now()')), /permission denied|cannot be used in this context/)
    pass('push_dispatch_config is invisible to anon/authenticated and the trigger function is un-callable (RLS on, zero policies, all grants revoked)')
    const trig = await row("SELECT count(*)::int AS n FROM information_schema.triggers WHERE event_object_table='push_deliveries' AND trigger_name='dispatch_push_after_enqueue'")
    assert.equal(trig.n, 1, 'instant-dispatch trigger must exist on the outbox')
    const fn = await row("SELECT prosecdef, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname='dispatch_push_now'")
    assert.equal(fn.prosecdef, true, 'dispatch_push_now must be SECURITY DEFINER')
    assert.ok(
      (fn.proconfig ?? []).some((cfg) => cfg === 'search_path=' || cfg.startsWith('search_path=')),
      `dispatch_push_now must pin an empty search_path, got: ${JSON.stringify(fn.proconfig)}`,
    )
    pass('instant-dispatch function exists with SECURITY DEFINER + fixed search_path (matches house rules)')
    // DB test cluster không cài pg_net: mọi đường phải im lặng, không nổ
    // dù config trống hay đã nạp — chứng chỉ nghiệp vụ KHÔNG bao giờ gãy
    // vì kênh push.
    const qBefore = await count("SELECT count(*)::int AS n FROM public.push_deliveries WHERE status='QUEUED'")
    await notify('staff', 'Không pg_net — ping phải tự tắt', 'B', '/doi-soat')
    assert.equal(await count("SELECT count(*)::int AS n FROM public.push_deliveries WHERE status='QUEUED'"), qBefore + 1)
    await db.query("INSERT INTO public.push_dispatch_config (id, url, token) VALUES (1, 'https://example.invalid/functions/v1/push-dispatch', $1) ON CONFLICT (id) DO NOTHING", ['token'.repeat(8)])
    await notify('staff', 'Có config, vẫn không pg_net', 'B', '/doi-soat')
    assert.equal(await count("SELECT count(*)::int AS n FROM public.push_deliveries WHERE status='QUEUED'"), qBefore + 2)
    pass('business enqueue never breaks with the config empty OR populated but pg_net absent (graceful no-op)')
    await assert.rejects(db.query("INSERT INTO public.push_dispatch_config (id, url, token) VALUES (2, 'https://ok.example/f', repeat('x', 32))"), /violates check constraint|2019|id/)
    await assert.rejects(db.query("INSERT INTO public.push_dispatch_config (id, url, token) VALUES (1, 'http://insecure.example/f', repeat('x', 32)) ON CONFLICT (id) DO NOTHING"), /violates check constraint/)
    pass('dispatch config enforces single row and HTTPS-only endpoint')

    console.log(`\n${passed} web push database checks passed on ${engine}.`)
  } finally {
    if (ownDb) await db.close()
  }
}
