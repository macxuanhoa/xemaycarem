// Local-only rollout rehearsal against a populated previous schema.
// Includes actual PostgreSQL transactional DDL rollback, never production.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs';
import { verifiedPayment } from './payment-fixtures.mjs';

// Read-only production ledger audit: applied through provenance privacy.
const prefix = '20261011000100';
const migrations = (await readdir('supabase/migrations')).filter(name => name.endsWith('.sql') && name.slice(0, 14) > prefix).sort();
assert.ok(migrations.some(name => name.startsWith('20261011000400')));
assert.ok(migrations.some(name => name.startsWith('20261014000100')));
assert.ok(migrations.some(name => name.startsWith('20261014000200')));
const db = await createDatabase({ engine: 'postgres', migrationFilter: name => name.slice(0, 14) <= prefix });
const owner = randomUUID(), staff = randomUUID();
const call = (name, data, user = owner) => asUser(db, user, client => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]));
let passed = 0, failed = false;
const check = async (name, action) => { await action(); console.log(`PASS release rehearsal ${++passed}. ${name}`); };

const schemaSnapshot = async () => (await db.query(`SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_schema,table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema IN ('public','private')),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',n.nspname||'.'||p.proname,'args',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private')),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',n.nspname||'.'||c.relname,'name',x.conname,'definition',pg_get_constraintdef(x.oid)) ORDER BY n.nspname,c.relname,x.conname) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')),
 'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY schemaname,tablename,indexname) FROM pg_indexes i WHERE schemaname IN ('public','private')),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p WHERE schemaname IN ('public','private')),
 'tables',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'rls',c.relrowsecurity,'acl',c.relacl) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') AND c.relkind='r')
) AS snapshot`)).rows[0].snapshot;
const financialTables = ['vehicles', 'vehicle_financials', 'acquisitions', 'sales', 'sale_financials', 'payments', 'vehicle_expenses', 'business_expenses', 'audit_logs', 'vehicle_activity'];
async function financialSnapshot() {
  const result = {};
  for (const table of financialTables) {
    result[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public.${table} t`)).rows[0].value;
  }
  return result;
}

try {
  for (const [id, role] of [[owner, 'OWNER'], [staff, 'STAFF']]) {
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${id}@example.test`, '{"full_name":"Synthetic release rehearsal"}']);
    await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2', [role, id]);
  }
  const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day;
  const keyedIntake = { request_id: randomUUID(), vehicle_type: 'Synthetic rollout', frame_number: 'RLHJC123456789012', purchase_price: 100, acquisition_date: day };
  const vehicle = await call('acquire_vehicle', keyedIntake);
  const sale = await call('sell_vehicle', { request_id: randomUUID(), vehicle_id: vehicle, sale_price: 1000, initial_payment: 100, payment_method: 'CASH', sale_date: day, customer_name: 'Synthetic rollout' });
  const expense = await asUser(db, owner, client => rpc(client, 'save_expense', '$1::text,$2::jsonb', ['business', JSON.stringify({ amount: 20, category: 'OTHER', description: 'Synthetic release expense', expense_date: day })]));
  const historicalPayment = await verifiedPayment(db, owner, owner, { request_id: randomUUID(), sale_id: sale, amount: 50, payment_method: 'CASH', payment_date: day });
  // An actual pre-lease PROCESSING row has an unknown outcome, not a proven unsent message.
  const outbox = (await db.query('SELECT id FROM public.message_outbox WHERE sale_id=$1', [sale])).rows[0]?.id;
  assert.ok(outbox, 'Synthetic sale must create an outbox row');
  await db.query("UPDATE public.message_outbox SET status='PROCESSING',attempt_count=1 WHERE id=$1", [outbox]);
  const privatePending = await call('save_vehicle', { request_id: randomUUID(), vehicle_type: 'Synthetic private rollout', frame_number: 'RLHJC923456781234', purchase_price: 77_770_000, purchase_date: day });
  await call('request_sale_below_cost', { request_id: randomUUID(), vehicle_id: privatePending, customer_name: 'Synthetic privacy rollout', sale_price: 40_000_000, sale_date: day, initial_payment: 0 }, staff);
  const legacyNotice = (await call('list_notifications', {}, staff)).items.find(n => n.vehicle_id === privatePending && n.action === 'REQUEST_SALE_BELOW_COST');
  assert.ok(legacyNotice && /37\.770\.000/.test(legacyNotice.body), 'baseline reproduces the stored private-shortfall leak');
  let baseline = await financialSnapshot();
  await check('production-applied prefix populated with real acquisition/sale/payments/expense/history', async () => {
    assert.equal(baseline.payments.length, 2);
    assert.ok(baseline.sale_financials.length === 1 && baseline.audit_logs.length > 0);
    assert.equal(baseline.payments.find(row => row.id === historicalPayment).amount, 50);
  });

  for (const name of migrations) {
    const source = await readFile(`supabase/migrations/${name}`, 'utf8');
    // A single-function historical script is also exercised in an explicit local
    // transaction. This rehearsal makes no claim about an unwrapped hosted runner.
    const explicit = /^\s*(?:--[^\n]*\n\s*)*BEGIN;/i.test(source);
    const sql = explicit ? source : `BEGIN;\n${source}\nCOMMIT;`;
    assert.match(sql.trim(), /COMMIT;$/i, `${name} must have a terminal commit`);
    await check(`${name} failure beforeCOMMIT rolls back DDL and existing financial history`, async () => {
      const beforeSchema = await schemaSnapshot();
      const beforeFinancial = await financialSnapshot();
      const injected = sql.replace(/COMMIT;\s*$/i, () => "DO $$ BEGIN RAISE EXCEPTION 'LOCAL_ROLLOUT_FAULT_INJECTION'; END $$;\nCOMMIT;");
      await assert.rejects(() => db.exec(injected), /LOCAL_ROLLOUT_FAULT_INJECTION/);
      await db.exec('ROLLBACK');
      assert.deepEqual(await schemaSnapshot(), beforeSchema);
      assert.deepEqual(await financialSnapshot(), beforeFinancial);
    });
    await db.exec(sql);
    await check(`${name} applies to populated previous schema without rewriting financial rows/audits`, async () => {
      assert.deepEqual(await financialSnapshot(), baseline);
    });
  }

  await check('existing private-price notifications are redacted without altering immutable business history', async () => {
    const projected = (await call('list_notifications', {}, staff)).items.find(n => n.id === legacyNotice.id);
    assert.ok(projected);
    assert.doesNotMatch(projected.body, /37\.770\.000|thiếu/);
    assert.deepEqual(await financialSnapshot(), baseline);
  });
  await check('legacyPROCESSING quarantined for manual evidence, not resent or silently markedSENT', async () => {
    assert.deepEqual(await asUser(db, owner, c => rpc(c, 'claim_message', '$1::uuid,$2::text', [outbox, 'MOCK'])), {});
    const job = (await db.query('SELECT status,delivery_review_required,last_error_code,total_attempt_count FROM public.message_outbox WHERE id=$1', [outbox])).rows[0];
    assert.deepEqual(job, { status: 'FAILED', delivery_review_required: true, last_error_code: 'DELIVERY_OUTCOME_UNKNOWN', total_attempt_count: 0 });
    assert.equal((await db.query("SELECT status FROM public.customer_communications WHERE sale_id=$1 AND message_type='THANK_YOU'", [sale])).rows[0].status, 'FAILED');
  });
  // Quarantine intentionally adds a review audit, while all financial records stay intact.
  baseline = await financialSnapshot();
  await check('newschema retains committed operation receipt for safe replay and lookup', async () => {
    assert.equal(await call('acquire_vehicle', keyedIntake), vehicle);
    const lookup = await asUser(db, owner, client => rpc(client, 'get_operation_result', '$1::text,$2::uuid', ['acquire_vehicle', keyedIntake.request_id]));
    assert.deepEqual(lookup, { confirmed: true, result: vehicle });
    assert.deepEqual(await financialSnapshot(), baseline);
  });
  await check('old callers failclosed for keyless intake/import/due/expense/payment with no financial sideeffects', async () => {
    await assert.rejects(() => call('acquire_vehicle', { ...keyedIntake, request_id: undefined }), /CLIENT_UPGRADE_REQUIRED/);
    await assert.rejects(() => call('import_vehicles', [{ model: 'Legacy synthetic', purchase_price: 100 }]), /CLIENT_UPGRADE_REQUIRED/);
    await assert.rejects(() => asUser(db, owner, client => rpc(client, 'update_sale_due_date', '$1::uuid,$2::date', [sale, day])), /CLIENT_UPGRADE_REQUIRED/);
    await assert.rejects(() => asUser(db, owner, client => rpc(client, 'save_expense', '$1::text,$2::jsonb,$3::uuid', ['business', '{"amount":30}', expense])), /CLIENT_UPGRADE_REQUIRED/);
    await assert.rejects(() => call('add_payment', { request_id: randomUUID(), sale_id: sale, amount: 50, payment_method: 'CASH', payment_date: day }), /CLIENT_UPGRADE_REQUIRED/);
    await assert.rejects(() => call('save_vehicle', { model: 'Legacy inventory route', frame_number: '', purchase_price: 50, purchase_date: day }), /CLIENT_UPGRADE_REQUIRED/);
    assert.deepEqual(await financialSnapshot(), baseline);
  });
  await check('current inventory creation is keyed and recovers exactlyonevehicle without manufacturing acquisition', async () => {
    const payload = { request_id: randomUUID(), vehicle_type: 'Xe tay ga', frame_number: '', purchase_price: 50, purchase_date: day };
    const before = (await db.query('SELECT (SELECT count(*) FROM public.vehicles)::int AS vehicles,(SELECT count(*) FROM public.acquisitions)::int AS acquisitions')).rows[0];
    const created = await call('save_vehicle', payload);
    assert.equal(await call('save_vehicle', payload), created);
    const after = (await db.query('SELECT (SELECT count(*) FROM public.vehicles)::int AS vehicles,(SELECT count(*) FROM public.acquisitions)::int AS acquisitions')).rows[0];
    assert.equal(after.vehicles, before.vehicles + 1);
    assert.equal(after.acquisitions, before.acquisitions);
    assert.deepEqual(await asUser(db, owner, client => rpc(client, 'get_operation_result', '$1::text,$2::uuid', ['create_vehicle', payload.request_id])), { confirmed: true, result: created });
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action='CREATE_VEHICLE'", [created])).rows[0].n), 1);
  });
  await check('newnamed RPC signatures resolve without overlapping optionalarguments and anonymouscannotwrite', async () => {
    const signatures = (await db.query("SELECT proname,proargnames,pronargs,pronargdefaults FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname IN ('update_sale_due_date','claim_message','prepare_payment_receipt') ORDER BY proname,pronargs")).rows;
    assert.ok(signatures.some(row => row.proname === 'update_sale_due_date' && row.proargnames.includes('p_expected_updated_at') && row.pronargdefaults === 0));
    assert.ok(signatures.some(row => row.proname === 'claim_message' && row.proargnames.includes('p_provider_mode') && row.pronargdefaults === 0));
    await assert.rejects(() => asUser(db, null, client => rpc(client, 'prepare_payment_receipt', '$1::jsonb', ['{}']), 'anon'), /permission denied/);
    await assert.rejects(() => asUser(db, staff, client => client.query('UPDATE public.payment_receipts SET amount=1')), /permission denied/);
  });
  await check('currentclient pending proposal has no money effect until verified; replay andsameevidence dedup survive upgrade', async () => {
    const beforeProposal = (await db.query('SELECT * FROM public.payments ORDER BY id')).rows;
    const payload = { request_id: randomUUID(), sale_id: sale, amount: 50, payment_method: 'CASH', payment_date: day, evidence_kind: 'CASH_VOUCHER', evidence_scope: 'SYNTHETIC_ROLLOUT_REGISTER', evidence_reference: 'SYNTHETIC_ROLLOUT_VOUCHER_001' };
    const receipt = await call('prepare_payment_receipt', payload, staff);
    assert.equal(receipt.status, 'PENDING');
    assert.deepEqual((await db.query('SELECT * FROM public.payments ORDER BY id')).rows, beforeProposal);
    assert.equal((await db.query('SELECT sum(amount)::int AS paid FROM public.payments WHERE sale_id=$1 AND status=\'ACTIVE\'', [sale])).rows[0].paid, 150);
    const request = { request_id: randomUUID(), receipt_id: receipt.id, verification_reference: 'Synthetic owner verified rollout voucher' };
    const payment = await call('add_payment', request);
    assert.equal(await call('add_payment', { ...request, request_id: randomUUID() }, staff), payment);
    const again = await call('prepare_payment_receipt', { ...payload, request_id: randomUUID() }, staff);
    assert.equal(again.id, receipt.id);
    assert.equal(again.payment_id, payment);
    assert.equal((await db.query('SELECT sum(amount)::int AS paid FROM public.payments WHERE sale_id=$1 AND status=\'ACTIVE\'', [sale])).rows[0].paid, 200);
    assert.deepEqual((await db.query('SELECT to_jsonb(p) AS row FROM public.payments p WHERE id=$1', [historicalPayment])).rows[0].row, baseline.payments.find(row => row.id === historicalPayment));
    assert.deepEqual((await db.query('SELECT to_jsonb(s) AS row FROM public.sale_financials s WHERE sale_id=$1', [sale])).rows[0].row, baseline.sale_financials[0]);
    assert.equal((await db.query('SELECT status FROM public.vehicles WHERE id=$1', [vehicle])).rows[0].status, 'SOLD');
  });
  console.log(`Release compatibility rehearsal: ${passed} PASS. NativeSQL caller compatibility andDDL failure rollback verified. Hosted PostgREST cache/GoTrue/production backup/full deployment rollback NOT VERIFIED.`);
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  await db.close();
}
process.exit(failed ? 1 : 0);
