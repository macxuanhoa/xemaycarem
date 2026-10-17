import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, asUser, rpc } from "../../scripts/db-harness.mjs";

const migration = "20261016000300_vietqr_compact_vehicle_memo.sql";

export async function runVietQrCompactMemoTests({ engine = "postgres" } = {}) {
  const db = await createDatabase({ engine, migrationFilter: (name) => name < migration });
  const owner = randomUUID();
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const call = (name, data) => asUser(db, owner, (client) =>
    rpc(client, name, "$1::jsonb", [JSON.stringify(data)]));
  const ingest = (q, content = q.transfer_content) => asUser(db, null, (client) =>
    rpc(client, "ingest_bank_transaction", "$1::jsonb", [JSON.stringify({
      provider: "SEPAY", provider_txn_id: randomUUID(), direction: "in",
      account_number: q.bank_account_no, amount: q.amount,
      transfer_at: new Date().toISOString(), transfer_content: content,
    })]), "service_role");
  let count = 0;
  const check = async (name, run) => {
    await run();
    console.log(`PASS compact VietQR memo ${++count}. ${name}`);
  };
  try {
    await db.query("INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)",
      [owner, `compact-qr-${owner}@example.test`, JSON.stringify({ full_name: "Owner" })]);
    await db.query("UPDATE public.profiles SET role='OWNER',active=true WHERE id=$1", [owner]);
    await call("save_settings", { bank_bin: "970422", bank_name: "MBBank",
      bank_account_no: "123456789", bank_account_name: "TRAN VAN REM", vietqr_enabled: true,
      bank_provider: "SEPAY", bank_webhook_enabled: true, bank_auto_match_enabled: true });
    const day = (await row("SELECT private.today()::text AS day")).day;
    const qr = async (name = "Honda Vision", sold = false) => {
      const vehicle_id = await call("save_vehicle", { request_id: randomUUID(),
        vehicle_type: name, license_plate: `QR${randomUUID().slice(0, 8)}`,
        purchase_date: day, purchase_price: 100 });
      const sale_id = sold ? await call("sell_vehicle", { request_id: randomUUID(), vehicle_id,
        customer_name: "Payer kept in agreement", sale_price: 1000, initial_payment: 0,
        payment_method: "CASH", sale_date: day }) : undefined;
      return call("create_vietqr_payment_request", { vehicle_id, sale_id,
        payer_name: "Payer kept in agreement", amount: 100 });
    };
    const pending = await qr(), expired = await qr(), cancelled = await qr(), alreadyCompact = await qr();
    const received = await qr(), confirmed = await qr("Honda Vision", true);
    await db.query("UPDATE public.vietqr_requests SET status='EXPIRED',created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '5 minutes',replace_available_at=clock_timestamp()-interval '19 minutes' WHERE id=$1", [expired.id]);
    await call("cancel_vietqr_payment_request", { id: cancelled.id, reason: "History fixture" });
    assert.equal((await ingest(received)).status, "RECEIVED");
    assert.equal((await ingest(confirmed)).status, "RECORDED");
    await db.query("UPDATE public.vietqr_requests SET transfer_content=qr_reference||' (Honda Vision)' WHERE id=$1", [alreadyCompact.id]);
    await db.query("UPDATE public.vietqr_requests SET qr_payload='historic cached payload' WHERE id=ANY($1::uuid[])",
      [[pending.id, expired.id, alreadyCompact.id, cancelled.id, received.id, confirmed.id]]);
    const before = (await db.query("SELECT * FROM public.vietqr_requests WHERE id=ANY($1::uuid[])",
      [[pending.id, expired.id, alreadyCompact.id, cancelled.id, received.id, confirmed.id]])).rows;
    const bankBefore = (await db.query("SELECT * FROM public.bank_transactions ORDER BY id")).rows;
    assert.ok(before.find((q) => q.id === pending.id).transfer_content.includes("Payer kept in agreement"));

    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));

    await check("upgrade refreshes open requests and stale payload without changing their identity or metadata", async () => {
      for (const id of [pending.id, expired.id, alreadyCompact.id]) {
        const old = before.find((q) => q.id === id);
        const next = await row("SELECT * FROM public.vietqr_requests WHERE id=$1", [id]);
        assert.equal(next.transfer_content, `${old.qr_reference} (Honda Vision)`);
        assert.equal(next.qr_payload, "");
        assert.deepEqual({ ...next, transfer_content: old.transfer_content, qr_payload: old.qr_payload }, old);
        const reopened = await call("create_vietqr_payment_request", { vehicle_id: old.vehicle_id,
          amount: old.amount, payer_name: old.payer_name });
        assert.equal(reopened.id, old.id);
        assert.equal(reopened.qr_reference, old.qr_reference);
        assert.equal(new Date(reopened.expires_at).getTime(), new Date(old.expires_at).getTime());
        assert.equal(reopened.transfer_content, next.transfer_content);
      }
    });
    await check("finalized QR records and original incoming bank content are untouched", async () => {
      for (const id of [cancelled.id, received.id, confirmed.id]) {
        assert.deepEqual(await row("SELECT * FROM public.vietqr_requests WHERE id=$1", [id]),
          before.find((q) => q.id === id));
      }
      assert.deepEqual((await db.query("SELECT * FROM public.bank_transactions ORDER BY id")).rows, bankBefore);
    });
    await check("new numeric type names match the original code and keep the incoming memo verbatim", async () => {
      for (const name of ["125cc", "67", "Honda Vision"]) {
        const q = await qr(name);
        assert.equal(q.transfer_content, `${q.qr_reference} (${name})`);
        assert.equal(q.payer_name, "Payer kept in agreement");
        assert.ok(q.agreement_text.includes(q.payer_name));
        const response = await ingest(q);
        assert.equal(response.status, "RECEIVED");
        const stored = await row("SELECT reference,transfer_content,qr_request_id FROM public.bank_transactions WHERE id=$1", [response.id]);
        assert.deepEqual(stored, { reference: q.qr_reference,
          transfer_content: q.transfer_content, qr_request_id: q.id });
      }
    });
    await check("long UTF8 type names trim only the name and preserve the closing parenthesis", async () => {
      const name = "Đ".repeat(60), q = await qr(name);
      assert.ok(q.transfer_content.startsWith(`${q.qr_reference} (`));
      assert.ok(q.transfer_content.endsWith(")"));
      const clipped = q.transfer_content.slice(q.qr_reference.length + 2, -1);
      assert.ok(clipped.length > 0 && clipped.length < name.length && name.startsWith(clipped));
      assert.ok(Buffer.byteLength(q.transfer_content, "utf8") <= 95);
      assert.ok(q.transfer_content.length <= 130);
      assert.ok(q.agreement_text.includes(name));
      assert.equal((await ingest(q)).status, "RECEIVED");
    });
    await check("legacy wrapped codes and mixed separators still work with numeric labels", async () => {
      const q = await qr();
      const code = q.qr_reference.toLowerCase().replace("carem gd", "c-a.r/e(m) g(d)")
        .replace(/(\d{2})/, "$1(");
      assert.equal((await ingest(q, `(${code}) (125cc)`)).status, "RECEIVED");
    });
    await check("all references remain visible to ambiguity checks, including inside parentheses", async () => {
      const q = await qr(), other = await qr();
      for (const memo of [`${q.qr_reference} (125cc) (${other.qr_reference})`,
        `${q.qr_reference} (${q.qr_reference})`, q.qr_reference + other.qr_reference]) {
        const response = await ingest(q, memo);
        assert.equal(response.status, "MANUAL_REVIEW");
        const stored = await row("SELECT match_reason,qr_request_id FROM public.bank_transactions WHERE id=$1", [response.id]);
        assert.deepEqual(stored, { match_reason: "AMBIGUOUS_REFERENCE", qr_request_id: null });
      }
    });
    await check("six digit references retain every digit beside numeric names", async () => {
      await db.exec("SELECT setval('private.vietqr_ref_seq',199999,true)");
      const q = await qr("125cc");
      assert.equal(q.transfer_content, "CAREM GD200000 (125cc)");
      assert.equal((await ingest(q)).status, "RECEIVED");
      const extra = await ingest(q, `${q.qr_reference}1 (125cc)`);
      assert.equal(extra.status, "UNMATCHED");
      const missingPrefix = await ingest(q, "GD200000 (125cc)");
      assert.equal(missingPrefix.status, "UNMATCHED");
    });
    await check("ambiguous unspaced parentheses never credit an existing shorter or longer request", async () => {
      await db.exec("SELECT setval('private.vietqr_ref_seq',9999,true)");
      const short = await qr("125cc");
      assert.equal(short.qr_reference, "CAREM GD10000");
      await db.exec("SELECT setval('private.vietqr_ref_seq',99999,true)");
      const longer = await qr("125cc");
      assert.equal(longer.qr_reference, "CAREM GD100000");
      await db.exec("SELECT setval('private.vietqr_ref_seq',100000124,true)");
      const numericSuffix = await qr("125cc");
      assert.equal(numericSuffix.qr_reference, "CAREM GD100000125");
      for (const memo of ["CAREM GD10000(0) (125cc)",
        "CAREM GD100000(125cc)", "CAREM GD100000(67)",
        "CAREM GD10(0000)(125cc)"]) {
        const response = await ingest(longer, memo);
        assert.equal(response.status, "UNMATCHED");
        const stored = await row("SELECT qr_request_id FROM public.bank_transactions WHERE id=$1", [response.id]);
        assert.equal(stored.qr_request_id, null);
      }
      for (const q of [short, longer, numericSuffix]) {
        assert.equal((await row("SELECT status FROM public.vietqr_requests WHERE id=$1", [q.id])).status, "PENDING");
        assert.equal((await ingest(q)).status, "RECEIVED");
      }
    });
    console.log(`${count} compact VietQR memo checks passed on ${engine}`);
  } finally {
    await db.close();
  }
}

if (process.argv[1]?.endsWith("vietqr-compact-memo.test.mjs")) {
  await runVietQrCompactMemoTests({ engine: process.argv.includes("--pglite") ? "pglite" : "postgres" });
}
