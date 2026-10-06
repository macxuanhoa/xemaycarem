import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase, asUser, rpc } from '../../scripts/db-harness.mjs'

export async function runPaymentReceiptTests(externalDb) {
  const db = externalDb ?? await createDatabase({ engine: 'postgres' })
  const users = { owner: randomUUID(), staff: randomUUID(), other: randomUUID() }
  let passed = 0
  const call = (c, actor, name, data) => asUser(c, users[actor], conn => rpc(conn,name,'$1::jsonb',[JSON.stringify(data)]))
  const parallel = async operations => {
    const clients = await Promise.all(operations.map(() => db.connection()))
    try { return await Promise.allSettled(operations.map((op,i) => op(clients[i]))) }
    finally { await Promise.all(clients.map(c => c.close())) }
  }
  const check = async (name, operation) => { await operation(); console.log(`PASS receipt ${++passed}. ${name}`) }
  try {
    for (const [role,id] of Object.entries(users)) {
      await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)',[id,`${id}@example.test`,JSON.stringify({full_name:'Synthetic receipt'})])
      await db.query('UPDATE public.profiles SET role=$1::public.user_role,active=true,must_change_password=false WHERE id=$2',[role==='owner'?'OWNER':'STAFF',id])
    }
    const day = (await db.query('SELECT private.today()::text AS day')).rows[0].day
    const vehicle = await call(db,'owner','acquire_vehicle',{request_id:randomUUID(),brand:'Honda',model:'Synthetic receipt',frame_number:'',purchase_price:100,acquisition_date:day})
    const sale = await call(db,'staff','sell_vehicle',{request_id:randomUUID(),vehicle_id:vehicle,customer_name:'Synthetic receipt',sale_date:day,sale_price:10000,initial_payment:50,payment_method:'CASH'})
    const snapshot = (await db.query('SELECT * FROM public.sale_financials WHERE sale_id=$1',[sale])).rows
    const initial = (await db.query('SELECT * FROM public.payments WHERE sale_id=$1',[sale])).rows
    const payment = extra => ({request_id:randomUUID(),sale_id:sale,amount:100,payment_date:day,payment_method:'CASH',evidence_kind:'CASH_VOUCHER',evidence_scope:'SYNTHETIC STORE',evidence_reference:`VOUCHER-${randomUUID()}`,...extra})
    const record = (c, receipt, extra={}) => call(c,'owner','add_payment',{request_id:randomUUID(),receipt_id:receipt.id,verification_reference:'Synthetic manager checked physical receipt and ledger',...extra})
    let shared
    await check('evidence kinds cannot contradict the actual payment method', async () => {
      await assert.rejects(() => call(db,'staff','prepare_payment_receipt',payment({payment_method:'BANK_TRANSFER'})),/PAYMENT_EVIDENCE_REQUIRED/)
      await assert.rejects(() => call(db,'staff','prepare_payment_receipt',payment({evidence_kind:'BANK_TRANSACTION'})),/PAYMENT_EVIDENCE_REQUIRED/)
      const r=await call(db,'staff','prepare_payment_receipt',payment({evidence_kind:null}))
      await assert.rejects(() => record(db,r,{evidence_kind:'BANK_TRANSACTION',evidence_scope:'SYNTHETIC ACCOUNT',evidence_reference:randomUUID()}),/PAYMENT_EVIDENCE_REQUIRED/)
      await asUser(db,users.owner,c=>rpc(c,'reject_payment_receipt','$1::uuid,$2::text',[r.id,'Synthetic incompatible evidence fixture rejected']))
    })
    await check('legacy direct financial requests fail closed and preserve history', async () => {
      await assert.rejects(() => call(db,'staff','add_payment',payment()),/CLIENT_UPGRADE_REQUIRED/)
      assert.deepEqual((await db.query('SELECT * FROM public.payments WHERE sale_id=$1',[sale])).rows,initial)
    })
    await check('different actors and UUIDs sharing one physical evidence create one proposal', async () => {
      const input=payment()
      const results=await parallel([c=>call(c,'staff','prepare_payment_receipt',input),c=>call(c,'other','prepare_payment_receipt',{...input,request_id:randomUUID()})])
      assert.ok(results.every(r=>r.status==='fulfilled'))
      assert.equal(results[0].value.id,results[1].value.id)
      shared=results[0].value
      assert.equal(shared.status,'PENDING')
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.payments WHERE sale_id=$1',[sale])).rows[0].n),1)
    })
    await check('pending receipt cannot be recorded by staff or without explicit evidence verification', async () => {
      await assert.rejects(() => call(db,'staff','add_payment',{request_id:randomUUID(),receipt_id:shared.id,verification_reference:'claimed verified'}),/ACCESS_DENIED/)
      await assert.rejects(() => record(db,shared,{verification_reference:''}),/PAYMENT_VERIFICATION_REQUIRED/)
    })
    await check('real concurrent approvals with independent IDs record one payment and audit', async () => {
      const results=await parallel([c=>record(c,shared),c=>record(c,shared)])
      assert.ok(results.every(r=>r.status==='fulfilled'&&r.value===shared.id))
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action='CREATE_PAYMENT' AND entity_id=$1",[shared.id])).rows[0].n),1)
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE action='VERIFY_PAYMENT_RECEIPT' AND entity_id=$1",[shared.id])).rows[0].n),1)
    })
    await check('timeout after financial commit replays same physical receipt across users without another payment', async () => {
      const result=await call(db,'other','add_payment',{request_id:randomUUID(),receipt_id:shared.id})
      assert.equal(result,shared.id)
      await assert.rejects(() => record(db,shared,{amount:101}),/PAYMENT_RECEIPT_CONFLICT/)
    })
    await check('two legitimate same-amount same-date receipts remain independent', async () => {
      const receipts=await Promise.all([payment(),payment()].map(p=>call(db,'staff','prepare_payment_receipt',p)))
      const results=await parallel(receipts.map(r=>c=>record(c,r)))
      assert.ok(results.every(r=>r.status==='fulfilled'))
      assert.notEqual(results[0].value,results[1].value)
    })
    await check('no evidence: duplicate proposals have no financial effects until manager reconciles/rejects', async () => {
      const input=payment({evidence_kind:null,evidence_scope:'',evidence_reference:''})
      const a=await call(db,'staff','prepare_payment_receipt',input)
      const b=await call(db,'other','prepare_payment_receipt',{...input,request_id:randomUUID()})
      const before=(await db.query('SELECT * FROM public.payments WHERE sale_id=$1 ORDER BY id',[sale])).rows
      await assert.rejects(() => record(db,a),/PAYMENT_EVIDENCE_REQUIRED/)
      assert.deepEqual((await db.query('SELECT * FROM public.payments WHERE sale_id=$1 ORDER BY id',[sale])).rows,before)
      const evidence={evidence_kind:'MANUAL_RECONCILIATION',evidence_scope:'SYNTHETIC REGISTER',evidence_reference:`REVIEW-${randomUUID()}`}
      await record(db,a,evidence)
      await assert.rejects(() => record(db,b,evidence),/PAYMENT_RECEIPT_CONFLICT/)
      await asUser(db,users.owner,c=>rpc(c,'reject_payment_receipt','$1::uuid,$2::text',[b.id,'Same physical receipt found by manager during ledger review']))
      await assert.rejects(() => record(db,b),/PAYMENT_RECEIPT_REJECTED/)
    })
    await check('trigger failure after ledger insert rolls back payment, verification and audit then retries safely', async () => {
      const r=await call(db,'staff','prepare_payment_receipt',payment())
      await db.exec(`CREATE FUNCTION private.receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='RECORDED' THEN RAISE EXCEPTION 'SYNTHETIC_RECEIPT_FAULT'; END IF; RETURN NEW; END $$; CREATE TRIGGER receipt_fault BEFORE UPDATE ON public.payment_receipts FOR EACH ROW EXECUTE FUNCTION private.receipt_fault()`)
      try {
        await assert.rejects(() => record(db,r),/SYNTHETIC_RECEIPT_FAULT/)
        assert.equal((await db.query('SELECT status FROM public.payment_receipts WHERE id=$1',[r.id])).rows[0].status,'PENDING')
        assert.equal(Number((await db.query('SELECT count(*) AS n FROM public.payments WHERE id=$1',[r.id])).rows[0].n),0)
        assert.equal(Number((await db.query("SELECT count(*) AS n FROM public.audit_logs WHERE entity_id=$1 AND action IN ('CREATE_PAYMENT','VERIFY_PAYMENT_RECEIPT')",[r.id])).rows[0].n),0)
      } finally { await db.exec('DROP TRIGGER receipt_fault ON public.payment_receipts; DROP FUNCTION private.receipt_fault()') }
      assert.equal(await record(db,r),r.id)
    })
    await check('registry/direct financial/private implementation writes remain inaccessible and snapshots unchanged', async () => {
      await assert.rejects(() => asUser(db,users.staff,c=>c.query('SELECT * FROM public.payment_receipts')),/permission denied/)
      await assert.rejects(() => asUser(db,users.owner,c=>c.query('UPDATE public.payment_receipts SET status=\'RECORDED\'')),/permission denied/)
      await assert.rejects(() => asUser(db,users.owner,c=>c.query('SELECT private.add_payment_verified_impl($1::jsonb)',[JSON.stringify(payment())])),/permission denied/)
      assert.deepEqual((await db.query('SELECT * FROM public.sale_financials WHERE sale_id=$1',[sale])).rows,snapshot)
      assert.deepEqual((await db.query('SELECT * FROM public.payments WHERE id=$1',[initial[0].id])).rows,initial)
      const total=Number((await db.query("SELECT sum(amount) AS n FROM public.payments WHERE sale_id=$1 AND status='ACTIVE'",[sale])).rows[0].n)
      assert.equal(total,550)
    })
    return passed
  } finally { if (!externalDb) await db.close() }
}
if (process.argv[1]?.replace(/\\/g,'/').endsWith('/payment-receipts.test.mjs')) {
  let failed=false
  try { await runPaymentReceiptTests() } catch(error) { console.error(error.stack); failed=true }
  process.exit(failed?1:0)
}
