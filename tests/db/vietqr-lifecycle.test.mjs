import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, asUser, rpc } from "../../scripts/db-harness.mjs";

export async function runVietQrLifecycleTests(
  externalDb,
  { engine = "pglite" } = {},
) {
  const ownDb = !externalDb;
  const db = externalDb ?? (await createDatabase({ engine }));
  let passed = 0;
  const check = async (name, run) => {
    await run();
    console.log(`PASS VietQR lifecycle ${++passed}. ${name}`);
  };
  const users = { owner: randomUUID(), staff: randomUUID() };
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const call = (name, data, actor = users.owner) =>
    asUser(db, actor, (c) => rpc(c, name, "$1::jsonb", [JSON.stringify(data)]));
  const get = (id) =>
    asUser(db, users.owner, (c) =>
      rpc(c, "get_vietqr_payment_request", "$1::uuid", [id]),
    );
  const active = (id) =>
    asUser(db, users.owner, (c) =>
      rpc(c, "get_active_vietqr_request", "$1::uuid", [id]),
    );
  const ingest = (data) =>
    asUser(
      db,
      null,
      (c) =>
        rpc(c, "ingest_bank_transaction", "$1::jsonb", [JSON.stringify(data)]),
      "service_role",
    );
  const sender = (qr, changes = {}) => ({
    provider: "SEPAY",
    provider_txn_id: randomUUID(),
    amount: qr.amount,
    transfer_content: qr.transfer_content,
    transfer_at: new Date().toISOString(),
    account_number: qr.bank_account_no,
    direction: "in",
    ...changes,
  });
  let sequence = 0,
    day;
  const vehicle = () =>
    call("save_vehicle", {
      request_id: randomUUID(),
      vehicle_type: "Honda Vision",
      license_plate: `QR${++sequence}-${randomUUID().slice(0, 6)}`,
      purchase_date: day,
      purchase_price: 1000,
    });
  const qr = async (amount = 100, payer_name = "Nguyễn Văn An") =>
    call("create_vietqr_payment_request", {
      vehicle_id: await vehicle(),
      amount,
      payer_name,
    });
  const sale = (q, changes = {}) => ({
    request_id: randomUUID(),
    vehicle_id: q.vehicle_id,
    customer_name: q.payer_name,
    customer_phone: "0900000000",
    sale_price: 2000,
    initial_payment: q.amount,
    sale_date: day,
    payment_method: "BANK_TRANSFER",
    vietqr_request_id: q.id,
    ...changes,
  });
  try {
    day = (await row("SELECT private.today()::text AS day")).day;
    for (const [name, id] of Object.entries(users)) {
      await db.query(
        "INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3::jsonb)",
        [
          id,
          `qr-lifecycle-${name}@example.test`,
          JSON.stringify({ full_name: name }),
        ],
      );
      await db.query(
        "UPDATE public.profiles SET role=$1::public.user_role,active=true,can_view_financials=$2 WHERE id=$3",
        [name.toUpperCase(), name === "owner", id],
      );
    }
    await call("save_settings", {
      bank_bin: "970422",
      bank_name: "MBBank",
      bank_account_no: "123456789",
      bank_account_name: "TRAN VAN REM",
      vietqr_enabled: true,
      bank_provider: "SEPAY",
      bank_webhook_enabled: true,
      bank_auto_match_enabled: true,
    });

    await check(
      "server creates fixed fifteen minute window and reference-first bank memo with full agreement",
      async () => {
        const q = await qr();
        assert.equal(
          Date.parse(q.expires_at) - Date.parse(q.created_at),
          15 * 60_000,
        );
        assert.equal(
          Date.parse(q.replace_available_at) - Date.parse(q.created_at),
          60_000,
        );
        // Mã đối soát đứng ĐẦU để sống sót khi ngân hàng/SePay cắt memo, nhờ đó
        // webhook luôn trích được "CAREM GD<digits>" và UI tự hoàn tất.
        assert.match(
          q.transfer_content,
          /^CAREM GD\d+ Nguyễn Văn An thanh toán tiền xe Honda Vision - \S+$/,
        );
        assert.equal(
          q.transfer_content.split(q.qr_reference).length - 1,
          1,
        );
        assert.ok(q.transfer_content.length <= 130);
        assert.match(
          q.agreement_text,
          /Nguyễn Văn An đồng ý thanh toán cho TRAN VAN REM/,
        );
        assert.match(q.agreement_text, /Honda Vision/);
        assert.ok(q.contract_reference.startsWith("HD-XE-"));
        assert.equal(q.monitoring_available, true);
      },
    );
    await check(
      "close, reopen and repeated create preserve original QR and expiry",
      async () => {
        const q = await qr(),
          repeat = await call("create_vietqr_payment_request", {
            vehicle_id: q.vehicle_id,
            amount: q.amount,
            payer_name: q.payer_name,
          });
        assert.equal(repeat.id, q.id);
        assert.equal(repeat.expires_at, q.expires_at);
        assert.equal((await active(q.vehicle_id)).id, q.id);
      },
    );
    await check(
      "manual button, forged bank sale and unauthorized ingestion cannot create paid state",
      async () => {
        const q = await qr();
        await assert.rejects(
          () =>
            call("create_vietqr_payment_request", {
              vehicle_id: q.vehicle_id,
              amount: q.amount,
            }),
          /VIETQR_PAYER_REQUIRED/,
        );
        await assert.rejects(
          () => call("confirm_vietqr_payment", { qr_request_id: q.id }),
          /VIETQR_BANK_EVIDENCE_REQUIRED/,
        );
        await assert.rejects(
          () => call("sell_vehicle", sale(q, { vietqr_request_id: undefined })),
          /VIETQR_BANK_EVIDENCE_REQUIRED/,
        );
        await assert.rejects(
          () => call("sell_vehicle", sale(q)),
          /VIETQR_BANK_EVIDENCE_REQUIRED/,
        );
        await assert.rejects(
          () => call("ingest_bank_transaction", sender(q)),
          /permission denied|ACCESS_DENIED/,
        );
        assert.equal((await get(q.id)).status, "PENDING");
      },
    );
    await check(
      "changed amount requires explicit replace, cooldown persists across cancel/reopen",
      async () => {
        const q = await qr();
        await assert.rejects(
          () =>
            call("create_vietqr_payment_request", {
              vehicle_id: q.vehicle_id,
              amount: 101,
              payer_name: q.payer_name,
            }),
          /VIETQR_REPLACE_REQUIRED/,
        );
        await assert.rejects(
          () =>
            call("replace_vietqr_payment_request", {
              replace_request_id: q.id,
              amount: q.amount,
              payer_name: q.payer_name,
            }),
          /VIETQR_REPLACEMENT_COOLDOWN/,
        );
        await call("cancel_vietqr_payment_request", q.id);
        await assert.rejects(
          () =>
            call("create_vietqr_payment_request", {
              vehicle_id: q.vehicle_id,
              amount: q.amount,
              payer_name: q.payer_name,
            }),
          /VIETQR_REPLACEMENT_COOLDOWN/,
        );
      },
    );
    await check(
      "server expiry remains visible on reopen and requires explicit renewal",
      async () => {
        const q = await qr();
        await db.query(
          "UPDATE public.vietqr_requests SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute',replace_available_at=clock_timestamp()-interval '15 minutes' WHERE id=$1",
          [q.id],
        );
        const expired = await get(q.id);
        assert.equal(expired.status, "EXPIRED");
        assert.equal((await active(q.vehicle_id)).id, q.id);
        const repeat = await call("create_vietqr_payment_request", {
          vehicle_id: q.vehicle_id,
          amount: q.amount,
          payer_name: q.payer_name,
        });
        assert.equal(repeat.id, q.id);
        const fresh = await call("replace_vietqr_payment_request", {
          replace_request_id: q.id,
          amount: q.amount,
          payer_name: q.payer_name,
        });
        assert.notEqual(fresh.id, q.id);
        assert.equal((await get(q.id)).status, "CANCELLED");
        assert.equal(fresh.status, "PENDING");
      },
    );
    await check("wrong amount or direction never succeeds", async () => {
      const q = await qr();
      const wrong = await ingest(sender(q, { amount: q.amount + 1 }));
      assert.equal(wrong.status, "MANUAL_REVIEW");
      await assert.rejects(
        () => ingest(sender(q, { direction: "out" })),
        /INVALID_INPUT/,
      );
      assert.equal((await get(q.id)).status, "PENDING");
    });
    await check(
      "foreign receiving account is rejected before persistence",
      async () => {
        const q = await qr(),
          input = sender(q, { account_number: "999999" });
        await assert.rejects(() => ingest(input), /BANK_ACCOUNT_MISMATCH/);
        assert.equal(
          Number(
            (
              await row(
                "SELECT count(*) AS n FROM public.bank_transactions WHERE provider_txn_id=$1",
                [input.provider_txn_id],
              )
            ).n,
          ),
          0,
        );
      },
    );
    await check(
      "changed receiving account cannot credit old QR snapshot",
      async () => {
        const q = await qr();
        await call("save_settings", { bank_account_no: "222222" });
        const response = await ingest(sender(q, { account_number: "222222" }));
        assert.equal(response.status, "MANUAL_REVIEW");
        assert.equal(
          (
            await row(
              "SELECT match_reason FROM public.bank_transactions WHERE id=$1",
              [response.id],
            )
          ).match_reason,
          "ACCOUNT_SNAPSHOT_MISMATCH",
        );
        assert.equal((await get(q.id)).status, "PENDING");
        assert.equal((await get(q.id)).monitoring_available, false);
        await call("save_settings", { bank_account_no: "123456789" });
      },
    );
    await check(
      "transfer after expiry is retained for review and cannot trigger success",
      async () => {
        const q = await qr();
        await db.query(
          "UPDATE public.vietqr_requests SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
          [q.id],
        );
        const response = await ingest(sender(q));
        assert.equal(response.status, "MANUAL_REVIEW");
        assert.equal((await get(q.id)).status, "EXPIRED");
        await assert.rejects(
          () => call("confirm_bank_transaction", { id: response.id }),
          /VIETQR_BANK_EVIDENCE_REQUIRED/,
        );
      },
    );
    await check(
      "timely transfer with delayed webhook recovers original expired QR safely",
      async () => {
        const q = await qr();
        await db.query(
          "UPDATE public.vietqr_requests SET created_at=clock_timestamp()-interval '16 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
          [q.id],
        );
        const response = await ingest(
          sender(q, {
            transfer_at: new Date(Date.now() - 120_000).toISOString(),
          }),
        );
        assert.equal(response.status, "RECEIVED");
        assert.equal((await get(q.id)).status, "RECEIVED");
      },
    );
    await check(
      "old replaced QR can never credit replacement even if original transfer time was valid",
      async () => {
        const q = await qr();
        await db.query(
          "UPDATE public.vietqr_requests SET replace_available_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
          [q.id],
        );
        const replacement = await call("replace_vietqr_payment_request", {
          replace_request_id: q.id,
          amount: q.amount,
          payer_name: q.payer_name,
        });
        const old = await ingest(sender(q));
        assert.equal(old.status, "MANUAL_REVIEW");
        assert.equal((await get(replacement.id)).status, "PENDING");
      },
    );
    await check(
      "extra digits and multiple valid references never ambiguously match",
      async () => {
        const q = await qr(),
          other = await qr();
        assert.equal(
          (await ingest(sender(q, { transfer_content: q.qr_reference + "1" })))
            .status,
          "UNMATCHED",
        );
        const response = await ingest(
          sender(q, {
            transfer_content: q.qr_reference + " / " + other.qr_reference,
          }),
        );
        assert.equal(response.status, "MANUAL_REVIEW");
        const adjacent = await ingest(
          sender(q, { transfer_content: q.qr_reference + other.qr_reference }),
        );
        assert.equal(adjacent.status, "MANUAL_REVIEW");
        assert.equal((await get(q.id)).status, "PENDING");
      },
    );
    await check(
      "trusted pre-sale incoming funds remain RECEIVED with no fictitious ledger payment",
      async () => {
        const q = await qr(),
          input = sender(q),
          response = await ingest(input),
          state = await get(q.id);
        assert.equal(response.status, "RECEIVED");
        assert.equal(state.status, "RECEIVED");
        assert.equal(state.payment_id, null);
        assert.equal(state.bank_transaction_id, response.id);
        assert.equal((await active(q.vehicle_id)).id, q.id);
        assert.equal((await ingest(input)).duplicate, true);
        await assert.rejects(
          () =>
            call("replace_vietqr_payment_request", {
              replace_request_id: q.id,
              amount: q.amount,
              payer_name: q.payer_name,
            }),
          /VIETQR_FUNDS_ALREADY_RECEIVED/,
        );
        const second = await ingest(sender(q));
        assert.equal(second.status, "MANUAL_REVIEW");
        assert.equal((await get(q.id)).bank_transaction_id, response.id);
      },
    );
    await check(
      "pre-sale binding checks payer, vehicle and amount before recording",
      async () => {
        const q = await qr();
        await ingest(sender(q));
        await assert.rejects(
          () => call("sell_vehicle", sale(q, { customer_name: "Other payer" })),
          /VIETQR_SALE_BINDING_MISMATCH/,
        );
        await assert.rejects(
          () =>
            call("sell_vehicle", sale(q, { initial_payment: q.amount + 1 })),
          /VIETQR_SALE_BINDING_MISMATCH/,
        );
        const otherVehicle = await vehicle();
        await assert.rejects(
          () => call("sell_vehicle", sale(q, { vehicle_id: otherVehicle })),
          /VIETQR_SALE_BINDING_MISMATCH/,
        );
        assert.equal((await get(q.id)).status, "RECEIVED");
      },
    );
    await check(
      "verified pre-sale payment attaches one bank receipt and one payment atomically",
      async () => {
        const q = await qr();
        const event = sender(q);
        await ingest(event);
        const data = sale(q),
          saleId = await call("sell_vehicle", data),
          state = await get(q.id);
        assert.equal(state.status, "CONFIRMED");
        assert.ok(state.payment_id);
        assert.ok(state.receipt_id);
        assert.equal(await call("sell_vehicle", data), saleId);
        assert.equal((await ingest(event)).duplicate, true);
        const receipt = await row(
          "SELECT * FROM public.payment_receipts WHERE id=$1",
          [state.receipt_id],
        );
        assert.equal(receipt.evidence_kind, "BANK_TRANSACTION");
        assert.equal(receipt.status, "RECORDED");
        assert.ok(
          receipt.verification_reference.includes(event.provider_txn_id),
        );
        assert.equal(
          Number(
            (
              await row(
                "SELECT count(*) AS n,sum(amount) AS total FROM public.payments WHERE sale_id=$1",
                [saleId],
              )
            ).n,
          ),
          1,
        );
        assert.equal(
          Number(
            (
              await row(
                "SELECT sum(amount) AS total FROM public.payments WHERE sale_id=$1",
                [saleId],
              )
            ).total,
          ),
          q.amount,
        );
      },
    );
    await check(
      "sale debt bank incoming funds automatically record actual verified receipt once",
      async () => {
        const id = await vehicle();
        const saleId = await call("sell_vehicle", {
          request_id: randomUUID(),
          vehicle_id: id,
          customer_name: "Sale payer",
          sale_price: 2000,
          initial_payment: 0,
          payment_method: "CASH",
          sale_date: day,
        });
        const q = await call("create_vietqr_payment_request", {
          sale_id: saleId,
          amount: 500,
        });
        const event = sender(q),
          response = await ingest(event),
          state = await get(q.id);
        assert.equal(response.status, "RECORDED");
        assert.equal(state.status, "CONFIRMED");
        assert.equal(
          await call("confirm_vietqr_payment", { qr_request_id: q.id }),
          state.payment_id,
        );
        assert.equal(
          (await call("confirm_bank_transaction", { id: response.id }))
            .payment_id,
          state.payment_id,
        );
        assert.equal((await ingest(event)).duplicate, true);
        const matching = await asUser(db, users.owner, (c) =>
          rpc(c, "get_vietqr_matching_status", "$1::uuid", [q.id]),
        );
        assert.equal(matching.bank_received, true);
        assert.equal(matching.state, "RECORDED");
      },
    );
    await check(
      "reference sequence remains unique beyond five digits",
      async () => {
        await db.exec("SELECT setval('private.vietqr_ref_seq',99999,true)");
        const q = await qr();
        assert.equal(q.qr_reference, "CAREM GD100000");
        assert.equal((await ingest(sender(q))).status, "RECEIVED");
      },
    );
    if (db.connection) {
      const parallel = (operations) =>
        Promise.all(
          operations.map(async (operation) => {
            const connection = await db.connection();
            try {
              return await operation(connection);
            } finally {
              await connection.close();
            }
          }),
        );
      const concurrentCall = (c, name, data) =>
        asUser(c, users.owner, (client) =>
          rpc(client, name, "$1::jsonb", [JSON.stringify(data)]),
        );
      const concurrentIngest = (c, data) =>
        asUser(
          c,
          null,
          (client) =>
            rpc(client, "ingest_bank_transaction", "$1::jsonb", [
              JSON.stringify(data),
            ]),
          "service_role",
        );
      await check(
        "simultaneous opens issue one QR and one fifteen minute timer",
        async () => {
          const vehicleId = await vehicle(),
            data = {
              vehicle_id: vehicleId,
              amount: 100,
              payer_name: "Concurrent payer",
            };
          const results = await parallel([
            (c) => concurrentCall(c, "create_vietqr_payment_request", data),
            (c) => concurrentCall(c, "create_vietqr_payment_request", data),
          ]);
          assert.equal(results[0].id, results[1].id);
          assert.equal(results[0].expires_at, results[1].expires_at);
          assert.equal(
            Number(
              (
                await row(
                  "SELECT count(*) AS n FROM public.vietqr_requests WHERE vehicle_id=$1",
                  [vehicleId],
                )
              ).n,
            ),
            1,
          );
        },
      );
      await check(
        "simultaneous replace attempts cannot bypass cooldown or leave two active QR codes",
        async () => {
          const q = await qr();
          await db.query(
            "UPDATE public.vietqr_requests SET replace_available_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
            [q.id],
          );
          const data = {
            replace_request_id: q.id,
            amount: 100,
            payer_name: q.payer_name,
          };
          const results = await parallel(
            [0, 1].map(() => async (c) => {
              try {
                return {
                  value: await concurrentCall(
                    c,
                    "replace_vietqr_payment_request",
                    data,
                  ),
                };
              } catch (error) {
                return { error: error.message };
              }
            }),
          );
          assert.equal(results.filter((result) => result.value).length, 1);
          assert.match(
            results.find((result) => result.error).error,
            /VIETQR_REPLACEMENT_CONFLICT/,
          );
          assert.equal(
            Number(
              (
                await row(
                  "SELECT count(*) AS n FROM public.vietqr_requests WHERE vehicle_id=$1 AND status='PENDING'",
                  [q.vehicle_id],
                )
              ).n,
            ),
            1,
          );
        },
      );
      await check(
        "simultaneous duplicate webhooks acknowledge one bank identity and receipt",
        async () => {
          const q = await qr(),
            event = sender(q);
          const results = await parallel([
            (c) => concurrentIngest(c, event),
            (c) => concurrentIngest(c, event),
          ]);
          assert.equal(results[0].id, results[1].id);
          assert.equal(results.filter((result) => result.duplicate).length, 1);
          assert.equal((await get(q.id)).bank_transaction_id, results[0].id);
        },
      );
      await check(
        "two distinct simultaneous bank credits can only settle one QR",
        async () => {
          const id = await vehicle();
          const saleId = await call("sell_vehicle", {
            request_id: randomUUID(),
            vehicle_id: id,
            customer_name: "Concurrent sale",
            sale_price: 2000,
            initial_payment: 0,
            payment_method: "CASH",
            sale_date: day,
          });
          const q = await call("create_vietqr_payment_request", {
            sale_id: saleId,
            amount: 500,
          });
          const results = await parallel([
            (c) => concurrentIngest(c, sender(q)),
            (c) => concurrentIngest(c, sender(q)),
          ]);
          assert.equal(
            results.filter((result) => result.status === "RECORDED").length,
            1,
          );
          assert.equal(
            results.filter((result) => result.status === "MANUAL_REVIEW")
              .length,
            1,
          );
          assert.equal(
            Number(
              (
                await row(
                  "SELECT count(*) AS n FROM public.payments WHERE sale_id=$1",
                  [saleId],
                )
              ).n,
            ),
            1,
          );
          assert.equal(
            Number(
              (
                await row(
                  "SELECT count(*) AS n FROM public.payment_receipts WHERE sale_id=$1",
                  [saleId],
                )
              ).n,
            ),
            1,
          );
        },
      );
      await check(
        "global issuance cap is atomic across different vehicles",
        async () => {
          const fixture = await qr();
          const activeCount = Number(
            (
              await row(
                "SELECT count(*) AS n FROM public.vietqr_requests WHERE created_at>clock_timestamp()-interval '1 hour'",
              )
            ).n,
          );
          const remaining = 299 - activeCount;
          assert.ok(remaining > 0);
          const marker = `STORE-CAP-${randomUUID()}`;
          await db.query(
            "INSERT INTO public.vietqr_requests(qr_reference,vehicle_id,amount,bank_bin,bank_name,bank_account_no,bank_account_name,qr_payload,status,created_by) SELECT $1||'-'||n,$2,100,$3,$4,$5,$6,'','CANCELLED',$7 FROM generate_series(1,$8::integer) n",
            [
              marker,
              fixture.vehicle_id,
              fixture.bank_bin,
              fixture.bank_name,
              fixture.bank_account_no,
              fixture.bank_account_name,
              users.staff,
              remaining,
            ],
          );
          try {
            const vehicles = [await vehicle(), await vehicle()];
            const results = await parallel(
              vehicles.map((vehicleId) => async (c) => {
                try {
                  return {
                    value: await concurrentCall(
                      c,
                      "create_vietqr_payment_request",
                      {
                        vehicle_id: vehicleId,
                        amount: 100,
                        payer_name: "Global cap payer",
                      },
                    ),
                  };
                } catch (error) {
                  return { error: error.message };
                }
              }),
            );
            assert.equal(results.filter((result) => result.value).length, 1);
            assert.match(
              results.find((result) => result.error).error,
              /VIETQR_RATE_LIMITED/,
            );
          } finally {
            await db.query(
              "DELETE FROM public.vietqr_requests WHERE qr_reference LIKE $1",
              [`${marker}-%`],
            );
          }
        },
      );
    }
    await check(
      "per-vehicle hourly cap survives changing actor and cancellation",
      async () => {
        const q = await qr();
        for (let i = 0; i < 5; i++) {
          await db.query(
            "INSERT INTO public.vietqr_requests(qr_reference,vehicle_id,amount,bank_bin,bank_name,bank_account_no,bank_account_name,qr_payload,status,created_by) VALUES($1,$2,100,$3,$4,$5,$6,$7,$8,$9)",
            [
              `LIMIT ${randomUUID()}`,
              q.vehicle_id,
              q.bank_bin,
              q.bank_name,
              q.bank_account_no,
              q.bank_account_name,
              "",
              "CANCELLED",
              users.owner,
            ],
          );
        }
        await db.query(
          "UPDATE public.vietqr_requests SET replace_available_at=clock_timestamp()-interval '1 minute' WHERE vehicle_id=$1",
          [q.vehicle_id],
        );
        await assert.rejects(
          () =>
            call("create_vietqr_payment_request", {
              vehicle_id: q.vehicle_id,
              amount: q.amount,
              payer_name: q.payer_name,
            }),
          /VIETQR_RATE_LIMITED/,
        );
      },
    );
    console.log(
      `${passed} verified VietQR lifecycle checks passed on ${engine}`,
    );
  } finally {
    if (ownDb) await db.close();
  }
}

if (process.argv[1]?.endsWith("vietqr-lifecycle.test.mjs")) {
  await runVietQrLifecycleTests(null, {
    engine: process.argv.includes("--postgres") ? "postgres" : "pglite",
  });
}
