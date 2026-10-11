import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs';
import { fileURLToPath } from 'node:url';
export async function runOperationReceiptTests(externalDb, { engine = 'postgres' } = {}) {
const db = externalDb ?? await createDatabase({ engine });
let passed = 0;
const owner = randomUUID(), staff = randomUUID();
const call = (c, user, name, data) => asUser(c, user, client => rpc(client, name, '$1::jsonb', [JSON.stringify(data)]));
const test = async (name, fn) => { await fn(); console.log(`PASS ${++passed}. ${name}`); };
try {
  for (const id of [owner,staff]) await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)', [id, `${id}@example.test`, '{"full_name":"Receipt test"}']);
  await db.query("UPDATE public.profiles SET role='OWNER', active=true WHERE id=$1", [owner]);
  await db.query("UPDATE public.profiles SET role='STAFF', active=true WHERE id=$1", [staff]);
  const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day;
  const intake = (extra={}) => ({ vehicle_type:'Xe tay ga', frame_number:'', purchase_price:100, acquisition_date:day, request_id:randomUUID(), ...extra });
  let vehicle, sale;
  await test('concurrent keyed intake without frame stores one acquisition and returns same vehicle', async () => {
    const data = intake(); const a = await db.connection(), b = await db.connection();
    try {
      const results = await Promise.all([call(a,owner,'acquire_vehicle',data),call(b,owner,'acquire_vehicle',data)]);
      assert.equal(results[0],results[1]); vehicle=results[0];
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=$1',[vehicle])).rows[0].n),1);
      await assert.rejects(() => call(db,owner,'acquire_vehicle',{...data,purchase_price:101}),/OPERATION_REQUEST_CONFLICT/);
    } finally { await a.close(); await b.close(); }
  });
  await test('concurrent keyed sale replay has one sale, snapshot, initial receipt and audit', async () => {
    const data = { request_id:randomUUID(), vehicle_id:vehicle, customer_name:'Synthetic', customer_phone:'', sale_price:1000, initial_payment:100, payment_method:'CASH', sale_date:day };
    const a=await db.connection(),b=await db.connection();
    try {
      const results=await Promise.all([call(a,owner,'sell_vehicle',data),call(b,owner,'sell_vehicle',data)]);
      assert.equal(results[0],results[1]); sale=results[0];
      const totals=(await db.query('SELECT (SELECT count(*) FROM public.sales WHERE vehicle_id=$1) AS s,(SELECT count(*) FROM public.payments WHERE sale_id=$2) AS p,(SELECT count(*) FROM public.audit_logs WHERE entity_id=$2 AND action=\'CREATE_SALE\') AS a',[vehicle,sale])).rows[0];
      assert.deepEqual(Object.values(totals).map(Number),[1,1,1]);
      await assert.rejects(() => call(db,owner,'sell_vehicle',{...data,sale_price:1001}),/OPERATION_REQUEST_CONFLICT/);
    } finally {await a.close();await b.close();}
  });
  await test('batch replay skips duplicate validation after committed import without repeating side effects', async () => {
    const rows=[intake({request_id:undefined}),intake({request_id:undefined})];
    const data={request_id:randomUUID(),rows};
    const a=await db.connection(),b=await db.connection();
    try {
      const results=await Promise.all([call(a,owner,'import_vehicles',data),call(b,owner,'import_vehicles',data)]);
      assert.deepEqual(results[0],results[1]); assert.equal(results[0].imported_count,2);
      const n=(await db.query('SELECT count(*) AS n FROM public.acquisitions WHERE vehicle_id=ANY($1::uuid[])',[results[0].vehicle_ids])).rows[0].n;
      assert.equal(Number(n),2);
      await assert.rejects(() => call(db,owner,'import_vehicles',{...data,rows:[rows[0]]}),/OPERATION_REQUEST_CONFLICT/);
    } finally {await a.close();await b.close();}
  });
  await test('receipt lookup is actor scoped and disabled actors cannot replay or read it', async () => {
    const data=intake(); const id=await call(db,owner,'acquire_vehicle',data);
    const lookup=user=>asUser(db,user,c=>rpc(c,'get_operation_result','$1::text,$2::uuid',['acquire_vehicle',data.request_id]));
    assert.deepEqual(await lookup(owner),{confirmed:true,result:id});
    assert.equal((await lookup(staff)).confirmed,false);
    await assert.rejects(() => asUser(db,staff,c=>c.query('SELECT * FROM private.operation_receipts')),/permission denied/);
    await assert.rejects(() => asUser(db,staff,c=>c.query('SELECT private.acquire_vehicle_impl($1::jsonb)',[JSON.stringify(data)])),/permission denied/);
    await db.query('UPDATE public.profiles SET active=false WHERE id=$1',[staff]);
    await assert.rejects(() => lookup(staff),/ACCESS_DENIED/);
    await db.query('UPDATE public.profiles SET active=true WHERE id=$1',[staff]);
  });
  await test('failed transaction leaves no receipt or partial vehicle and can retry same key', async () => {
    const data=intake({purchase_price:-1});
    await assert.rejects(() => call(db,owner,'acquire_vehicle',data),/INVALID_MONEY/);
    const n=(await db.query('SELECT count(*) AS n FROM private.operation_receipts WHERE request_id=$1',[data.request_id])).rows[0].n;
    assert.equal(Number(n),0);
    assert.ok(await call(db,owner,'acquire_vehicle',{...data,purchase_price:100}));
  });
  console.log(`Operation receipt tests: ${passed} PASS`);
  return passed;
} finally { if (!externalDb) await db.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failed = false;
  try { await runOperationReceiptTests(); }
  catch(error) { failed = true; console.error(error.message); }
  process.exit(failed ? 1 : 0);
}
