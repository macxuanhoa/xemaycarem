// Actual Deno + pinned Supabase SDK HTTP transport + native disposable PostgreSQL.
// Auth transport is synthetic, not hosted GoTrue/JWT verification. MOCK has no external send.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createReservation } from 'node:net';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase, asUser, rpc } from './db-harness.mjs';

const binary = process.env.DENO_BINARY || 'deno';
const temporaryRoot = await realpath(tmpdir());
const configurationRoot = await mkdtemp(join(temporaryRoot, 'carem-worker-native-'));
const configuration = join(configurationRoot, 'deno.json');
await writeFile(configuration, '{"compilerOptions":{"strict":true},"nodeModulesDir":"none","lock":false}');
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|DENO_DIR)$/i.test(name)));
const db = await createDatabase({ engine: 'postgres' });
const owner = randomUUID();
const call = (name, data) => asUser(db, owner, client => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]));
let fault = null, worker = null, passed = 0, failed = false;
const check = async (name, action) => { await action(); console.log(`PASS native worker ${++passed}. ${name}`); };
const gateway = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Content-Type', 'application/json');
    if (path === '/auth/v1/user') {
      response.end(JSON.stringify({ id: owner, aud: 'authenticated', role: 'authenticated', email: 'synthetic-worker@example.test', app_metadata: {}, user_metadata: {} }));
      return;
    }
    const name = path.split('/').at(-1);
    const contracts = {
      claim_message: [['p_message_id', 'uuid'], ['p_provider_mode', 'text']],
      finish_mock_message: [['p_message_id', 'uuid'], ['p_provider_message_id', 'text'], ['p_lease_token', 'uuid']],
      skip_message: [['p_message_id', 'uuid'], ['p_error_code', 'text'], ['p_safe_message', 'text'], ['p_lease_token', 'uuid']],
      fail_message: [['p_message_id', 'uuid'], ['p_error_code', 'text'], ['p_safe_message', 'text'], ['p_permanent', 'boolean'], ['p_lease_token', 'uuid']],
    };
    if (!path.startsWith('/rest/v1/rpc/') || !contracts[name]) { response.writeHead(404).end('{}'); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const contract = contracts[name];
    assert.deepEqual(Object.keys(body).sort(), contract.map(([key]) => key).sort(), 'Native SDK must send exactly the new RPC arguments');
    const connection = await db.connection();
    let result;
    try {
      result = await asUser(connection, owner, client => rpc(client, name, contract.map(([, type], index) => `$${index + 1}::${type}`).join(','), contract.map(([key]) => body[key])));
    } finally { await connection.close(); }
    if (fault?.id === body.p_message_id && fault.kind === 'hold_claim' && name === 'claim_message') {
      fault.arrive(result);
      await new Promise(done => response.once('close', done));
      return;
    }
    if (fault?.id === body.p_message_id && fault.kind === 'drop_finish' && name === 'finish_mock_message') {
      fault.dropped = (fault.dropped || 0) + 1;
      response.destroy();
      return;
    }
    response.end(JSON.stringify(result));
  } catch (error) {
    if (!response.headersSent) response.writeHead(400);
    response.end(JSON.stringify({ code: error.code || 'LOCAL_TEST_ERROR', message: error.message }));
  }
});
await new Promise(listen => gateway.listen(0, '127.0.0.1', listen));

async function stopWorker() {
  if (!worker) return;
  const target = worker;
  worker = null;
  if (target.exitCode === null) {
    const stopped = new Promise(done => target.once('exit', done));
    target.kill();
    await stopped;
  }
}
async function startWorker() {
  const reservation = createReservation();
  await new Promise((listen, reject) => { reservation.once('error', reject); reservation.listen(8000, '0.0.0.0', listen); });
  await new Promise(close => reservation.close(close));
  const gatewayPort = gateway.address().port;
  worker = spawn(binary, ['run', '--cached-only', '--config', configuration, '--no-lock', `--allow-net=0.0.0.0:8000,127.0.0.1:${gatewayPort}`, '--allow-env', resolve('supabase/functions/process-message/index.ts')], {
    env: { ...environment, SUPABASE_URL: `http://127.0.0.1:${gatewayPort}`, SUPABASE_ANON_KEY: 'synthetic-public-key', MESSAGE_PROVIDER_MODE: 'MOCK' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startup = '';
  worker.stdout.on('data', chunk => { startup += chunk; });
  worker.stderr.on('data', chunk => { startup += chunk; });
  worker.on('error', error => { startup += error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error(`Native worker startup failed: ${startup}`);
    try { await fetch('http://127.0.0.1:8000', { method: 'OPTIONS', signal: AbortSignal.timeout(500) }); return; }
    catch { await delay(50); }
  }
  throw new Error(`Native worker failed to become ready: ${startup}`);
}
const execute = id => fetch('http://127.0.0.1:8000', {
  method: 'POST', headers: { Authorization: 'Bearer synthetic-local-token', 'Content-Type': 'application/json' },
  body: JSON.stringify({ message_id: id }), signal: AbortSignal.timeout(30000),
});
const job = async id => (await db.query('SELECT to_jsonb(o) AS value FROM public.message_outbox o WHERE id=$1', [id])).rows[0].value;
const sentAudits = async id => Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='MESSAGE_SENT'", [id])).rows[0].n);
let day;
async function createJob() {
  const vehicle = await call('save_vehicle', { request_id: randomUUID(), model: 'Synthetic native worker', brand: 'Honda', purchase_date: day, purchase_price: 100, asking_price: 1000 });
  const sale = await call('sell_vehicle', { request_id: randomUUID(), vehicle_id: vehicle, customer_name: 'Synthetic native worker', customer_phone: '0912345678', sale_date: day, sale_price: 1000, initial_payment: 0 });
  return asUser(db, owner, client => rpc(client, 'get_sale_communication', '$1::uuid', [sale]));
}

try {
  await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [owner, `${owner}@example.test`, '{"full_name":"Synthetic native worker"}']);
  await db.query("UPDATE public.profiles SET role='OWNER',active=true,must_change_password=false WHERE id=$1", [owner]);
  day = (await db.query('SELECT private.today()::text AS day')).rows[0].day;
  await call('save_settings', { customer_messaging_enabled: true, sale_thank_you_enabled: true, primary_message_channel: 'SMS' });
  await startWorker();
  await check('authenticated malformedJSON shapes failwith400 beforeclaim insteadof crashingruntime', async () => {
    const before = Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action='MESSAGE_CLAIMED'")).rows[0].n);
    for (const body of ['null', '[]', '{"message_id":1}', '{"message_id":"invalid"}']) {
      const response = await fetch('http://127.0.0.1:8000', { method: 'POST', headers: { Authorization: 'Bearer synthetic-local-token', 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'INVALID_INPUT');
    }
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action='MESSAGE_CLAIMED'")).rows[0].n), before);
  });
  await check('actual native SDK roundtrip sends leased RPC contracts and persists deterministicMOCK outcome', async () => {
    const created = await createJob();
    const response = await execute(created.id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'SENT', provider: 'MOCK', provider_message_id: `mock_${created.id}` });
    assert.equal((await job(created.id)).status, 'SENT');
    assert.equal(await sentAudits(created.id), 1);
  });
  await check('two concurrent native HTTP requests yield one persisted delivery andoneclaim', async () => {
    const created = await createJob();
    const responses = await Promise.all([execute(created.id), execute(created.id)]);
    assert.ok(responses.every(response => response.status === 200));
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.equal(bodies.filter(body => body.status === 'SENT').length, 1);
    assert.equal(bodies.filter(body => body.status === 'NOT_QUEUED').length, 1);
    assert.equal((await job(created.id)).total_attempt_count, 1);
    assert.equal(await sentAudits(created.id), 1);
  });
  await check('worker process killed afterclaimcommit canrecover afterleaseexpiry withnewfencingtoken', async () => {
    const created = await createJob();
    let arrive;
    const arrived = new Promise(done => { arrive = done; });
    fault = { kind: 'hold_claim', id: created.id, arrive };
    const pending = execute(created.id).catch(() => null);
    const claimed = await Promise.race([arrived, delay(8000).then(() => { throw new Error('Claim commit barrier did not arrive'); })]);
    assert.equal((await job(created.id)).status, 'PROCESSING');
    await stopWorker();
    await pending;
    fault = null;
    await db.query("UPDATE public.message_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [created.id]);
    await startWorker();
    const response = await execute(created.id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'SENT');
    const current = await job(created.id);
    assert.notEqual(current.lease_token, claimed.lease_token);
    assert.equal(current.total_attempt_count, 2);
    assert.equal(current.provider_message_id, `mock_${created.id}`);
    assert.equal(await sentAudits(created.id), 1);
  });
  await check('finishcommit followedbylostHTTPresponse remains SENT andretrydoesnotredeliver', async () => {
    const created = await createJob();
    fault = { kind: 'drop_finish', id: created.id };
    const response = await execute(created.id);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, 'MESSAGE_STATE_UPDATE_FAILED');
    assert.ok(fault.dropped >= 1, 'At least one actual committed finish response must be lost');
    fault = null;
    assert.equal((await job(created.id)).status, 'SENT');
    const retry = await execute(created.id);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).status, 'NOT_QUEUED');
    assert.equal((await job(created.id)).total_attempt_count, 1);
    assert.equal(await sentAudits(created.id), 1);
  });
  // Messaging crash/retry must not mutate the underlying financial transaction.
  const ledger = (await db.query(`SELECT
    (SELECT count(*)::int FROM public.sales WHERE status='COMPLETED') AS sales,
    (SELECT count(*)::int FROM public.vehicles WHERE status='SOLD') AS sold,
    (SELECT count(*)::int FROM public.sale_financials) AS snapshots,
    (SELECT count(*)::int FROM public.payments) AS payments,
    (SELECT sum(sale_price)::int FROM public.sales) AS sales_total`)).rows[0];
  assert.deepEqual(ledger, { sales: 4, sold: 4, snapshots: 4, payments: 0, sales_total: 4000 });
  console.log(`Native worker: ${passed} PASS. ActualDeno/SDK/HTTP/nativeSQL process-crash andcommitlostresponse verified; syntheticAuth isnot hostedGoTrue; externaldelivery NOT VERIFIED.`);
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  await stopWorker();
  await new Promise(close => gateway.close(close));
  await db.close();
  assert.equal(dirname(await realpath(configurationRoot)), temporaryRoot);
  await rm(configurationRoot, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
