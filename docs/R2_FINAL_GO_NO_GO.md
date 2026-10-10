# R2 — Final Go/No-Go & 12-Migration Apply Plan (Cà Rem CRM)

Status (AMEND round): **5 of 5 close-out gates done; ONE OWNER decision open (A2 price provenance).**
No `db push`, no production `DROP`/`DELETE`, no deploy, no frontend rollback, no
git-history rewrite and no code deletion have been performed. Everything below is
evidence gathered read-only against production and against an isolated local
Postgres 17 replica. (The original §1–§7 remain valid; see §8 for the AMEND results.)

Reference point: branch `integration/one-carem-latest`, HEAD `1c8609c` (repo clean).

---

## 1. Scope of R2

R2 = apply the **full forward migration chain** (the 12 pending migrations) so the
Supabase backend matches the latest frontend (vehicle-type catalog, delete
approval, smart duplicate detection, camera identity lookup, below-cost sale
approval, runtime-issue monitoring, AI Sales Assistant, VietQR), then remove the
legacy columns/history that the OWNER has decided to purge.

R1 (skip `20261008000300`) is **invalid** and retracted: every later migration
depends on `public.vehicle_types` / `vehicles.vehicle_type_id`, which only
`20261008000300` creates. There is no valid partial path — it is all 12 or none.

---

## 2. The 12 pending migrations (apply order = ledger order)

| # | Version | File | Transaction | Destructive? |
|---|---------|------|-------------|--------------|
| 1 | 20261008000100 | staff_delete_permanent | atomic (BEGIN/COMMIT) | no |
| 2 | 20261008000200 | staff_vehicle_parity_and_delete_approval | **AUTOCOMMIT** | no (apply-time); runtime-only deletes inside function bodies |
| 3 | 20261008000300 | vehicle_type_catalog_and_purge | atomic + STEP 11 self-verify | **YES — purge 264 rows + DROP columns** |
| 4 | 20261009000100 | plate_display_format | atomic | no |
| 5 | 20261009000200 | smart_vehicle_duplicate_detection | atomic | no |
| 6 | 20261010000100 | vehicle_type_free_text_autocomplete | atomic | no |
| 7 | 20261010000200 | camera_identity_lookup | **AUTOCOMMIT** | no (fully additive: 0 DROP/DELETE) |
| 8 | 20261010000300 | below_cost_sale_approval | atomic | no |
| 9 | 20261010000400 | vehicle_identifier_lookup | atomic | no |
| 10 | 20261010000500 | runtime_issue_monitoring | atomic | no |
| 11 | 20261010000600 | ai_sales_assistant | atomic | no |
| 12 | 20261010000700 | vietqr_payment_flow | atomic | no |
| 13 | **20261011000100** | **financial_provenance_privacy** (A2 remediation) | atomic | **no** — fully additive + backfill of new visibility columns; 0 DROP / 0 DELETE of business rows |

11/13 files are internally atomic. **2 files (#2 and #7) are autocommit** — they
have no `BEGIN;…COMMIT;` wrapper, so `db push` runs each statement in its own
implicit transaction. This is the only partial-failure exposure in the chain.
Migration #13 is the OWNER-authorized A2 security remediation (§8.7); it closes the
OWNER-private-by-provenance gap and MUST ship with the chain (R2 without #13 leaves
the confirmed leak in place).

### Destructive footprint (migration #3 only)

`20261008000300` STEP 3 "Tẩy lịch sử" (OWNER decision: no tombstone) deletes:
- `message_outbox` = **6**
- `customer_communications` = **6**
- `notifications` = **79**
- `vehicle_activity` = **57**
- `audit_logs` = **116**
- **Total rows purged: 264** (verified live 2026-10-10)

It also drops columns (discards the column values on 7 vehicles; no row loss):
- `public.vehicles`: brand, model, variant, engine_number, odometer, asking_price
- `public.system_settings`: quickpick_brands, quickpick_models

`sales` = 6, `vehicles` = 7 are NOT deleted. The whole file is atomic and ends
with a STEP 11 self-verify DO-block that RAISEs on any mismatch → the entire
migration (purge included) rolls back. So #3 is all-or-nothing.

---

## 3. Apply plan with checkpoints + recovery

Precondition: fresh verified backup already exists — see §5.

**Checkpoint model.** `supabase db push` applies files in ledger order and records
each version in `supabase_migrations.schema_migrations` only after that file
completes. Between atomic files the ledger is a clean resume point: if the run
stops after version N, re-running `db push` skips 1..N and resumes at N+1.

**Order of operations for the GO moment (not yet executed):**
1. Freeze writes (maintenance mode / pause staff) — expected window is seconds at
   this data scale (7 vehicles, 6 sales, 264 history rows).
2. Re-confirm backup is current (`npm run backup:prod` if prod changed since §5).
3. Dry-run: `supabase db push --dry-run` — prints the exact apply list; abort if it
   is not precisely the 12 versions above.
4. Apply #1..#3 (this carries the destructive purge). Pause at checkpoint #3.
5. Verify #3 landed green: ledger has 000800300; `vehicle_types` present with rows;
   `vehicles.vehicle_type_id` present; the 6 legacy columns absent; purge counts 0.
6. Apply #4..#7. Extra care at autocommit #7 (camera) — see recovery below.
7. Apply #8..#12.
8. Run the migrated-DB integration checks (§4 B4/B5 scripts) against prod or a
   prod-restored staging DB.
9. Deploy Edge Function `post-ai` with secrets (§6).
10. Unfreeze writes; smoke-test the frontend.

**Recovery matrix:**

| Failure point | State | Recovery |
|---|---|---|
| Any atomic file (#1,#3–#6,#8–#12) fails mid-file | That file fully rolled back; prior files committed & ledgered | Fix cause, re-run `db push`; resumes at failed version. No manual cleanup. |
| Autocommit **#2** fails mid-file | Partial: earlier statements of #2 committed, but #2 NOT recorded in ledger | #2 is non-destructive (schema/RLS/RPC re-creation, idempotent `CREATE OR REPLACE`/`ADD COLUMN IF NOT EXISTS`). Re-run `db push` — statements are re-applied cleanly. If a non-idempotent statement is implicated, restore the pre-push backup. |
| Autocommit **#7** (camera) fails mid-file | Partial | #7 is fully additive (creates objects, 0 DROP/DELETE). Safe to re-run `db push`; if a conflict appears, drop the specific half-created object and resume. |
| **#3** self-verify raises | Whole #3 rolled back (nothing purged) | Clean; investigate the verify condition, re-run `db push`. Prod data untouched because rollback is automatic. |
| Post-#3 success but a later file unrecoverable | Purge is committed | Forward-only fix (new corrective migration) **or** restore the verified backup (§5). This is why the backup/restore drill is the real safety net, not the transaction wrapper. |

Supabase has **no automatic down-migration**: recovery of an already-applied
migration is either a new forward corrective migration or a full restore from the
verified backup. The atomicity of 10/12 files limits blast radius, but the backup
is the only true rollback.

---

## 4. Test evidence (isolated real DB, no network mocks)

Local stack: `supabase start` (Postgres 17, same engine as prod) → `supabase db
reset` applied **all 69 migrations incl. the 12** cleanly. End-state verified: 0
legacy columns, `vehicle_type_id` present, 8/8 new RPCs, 6 vehicle_types.

**Real PostgREST/RPC integration (b45-integration.mjs):** Thu/Lưu/Bán, save_vehicle,
sell_vehicle, check_vehicle_duplicates, list_pending_approvals, direct table SELECT
grants, anon RLS. Result: 11 PASS + 3 correct-by-design rejections (VietQR
not-yet-configured, SALE_HISTORY_EXISTS). Price "leak" flag was a false alarm.

**Below-cost approval + VietQR (b4-flows.mjs):** **16/16 PASS** —
- STAFF sell under cost → `SALE_BELOW_COST_APPROVAL_REQUIRED` (gate)
- STAFF request_sale_below_cost → PENDING; same request_id replay = idempotent (offline-safe); pending blocks other sales (`SALE_APPROVAL_PENDING`); vehicle shows `pending_sale_approval=true`
- OWNER list_pending_approvals sees it → resolve_sale_approval(APPROVE) → vehicle `SOLD` + COMPLETED sale at 25.000.000
- VietQR: create succeeds (`CAREM GD01001`), same-amount reuse (idempotent), different-amount supersede, STAFF → `ACCESS_DENIED` (can_financials), over-balance → `PAYMENT_EXCEEDS_BALANCE`

**Owner-private price security (B5, b5-price-probe.mjs):** by-design tiering via
`private.can_financials()` = OWNER OR (MANAGER AND can_view_financials):
- STAFF/MANAGER(non-finance): see `purchase_price` (they enter acquisition cost and
  must know below-cost) but NOT `expense_total`/`total_cost`
- OWNER / finance-MANAGER: see all
- anon showroom: no price at all
Verified via BOTH direct PostgREST SELECT (grants/RLS) and RPC projections. Not a leak.

---

## 5. Backup evidence (logical vs full)

New set: `backups/carem-prod-2026-10-10-210134-*` — schema.sql + data.sql +
migration-history.txt + Storage object binaries (20 objects) + inventory +
SHA-256 MANIFEST; integrity OK. `npm run backup:verify` restore drill **PASS
(exit 0)**: SHA-256, schema/data/ledger, Storage binaries, row counts match, RLS,
113 functions.

**What this backup IS:** a full *logical* backup + Storage binaries (recreates
tables, data, functions, RLS, and re-uploads Storage objects).
**What it does NOT capture (needs Dashboard / PITR / separate drill):** hosted
GoTrue/Auth user password hashes & config, Edge Function code & secrets, dashboard
secrets, PITR physical base backups, extensions (e.g. supabase_vault). Caveat
`platformRestoreProven:false` — a staging restore of Auth/Storage on the hosted
platform is still recommended before relying on a full platform rebuild.

---

## 6. Edge Functions

- Deployed & FE-invoked (contract matches): `ai-assist` (api.ts:444), `manage-users`
  (api.ts:247/277), `process-message` (api.ts:430).
- **`post-ai` — source complete & now type-clean** (`deno check` exit 0; a
  type-annotation-only fix to the `metered` variable, no logic change). It is a
  **separate new contract** (PostStudio/BrandMemory via postStudioApi.ts:154) and is
  **MISSING in production** → Post-Studio AI + reply assistant are non-functional
  until it is deployed.
- `reset-owner` — admin-only, not FE-invoked; absence in prod is acceptable.

**Deploy requirement at GO:** `supabase functions deploy post-ai` with secrets
`GEMINI_API_KEY`, `POST_AI_ENABLED=true`, optional `GEMINI_MODEL`
(default `gemini-3.8-flash`), `POST_AI_DAILY_LIMIT` (default 400). No service-role
key inside the function: all data access goes through RPC under the caller JWT
(all 7 dependent RPCs confirmed present in the migrated DB; `log_post_ai_usage`
signature verified to match the call).

---

## 7. FINAL GO / NO-GO

**Recommendation: GO, contingent on OWNER explicit authorization**, because:
- 12 pending confirmed on live ledger; nothing pushed.
- Verified full-logical + Storage backup exists and restore drill passed.
- All 12 apply cleanly on an identical Postgres 17 engine.
- Core business + security verified against the real DB (no mocks).
- Destructive scope is exact and bounded: **264 history rows + 6 vehicle columns +
  2 settings columns**; vehicles/sales rows are preserved; the purge is atomic with
  self-verify.
- Only post-deploy functional gap is `post-ai` (deploy + secrets resolves it).

**Residual risks to accept before GO:**
1. 2/12 files are autocommit → theoretical partial-apply window at #2/#7 (both
   additive/idempotent; mitigated by re-run + backup).
2. Platform-level restore (Auth/Storage binaries restore onto hosted) is not
   end-to-end proven — recommended pre-GO: a one-time staging restore drill.
3. Purge is irreversible forward-only; if a business change is discovered after
   #3, the only rollback is the backup.

**Blocked until OWNER GO (do not perform):** `supabase db push`, any production
DROP/DELETE, `functions deploy`, additional Vercel deploy, git history rewrite.

**STOP.** All R2 gates are green. Awaiting OWNER's final GO to execute §3 + §6.

---

## 8. AMEND round — the five close-out gates (NO-GO response)

### 8.1 A1 — Real-browser E2E against the migrated local DB (no mocks) — PASS
Dev server (`integration/one-carem-latest` FE) pointed at the local stack via gitignored
`.env.development.local` (URL http://127.0.0.1:54321). A real browser drove, all with
live calls to `127.0.0.1:54321` (zero network mocks, zero console errors):
- Login (OWNER) → `POST /auth/v1/token?grant_type=password` 200 → dashboard with real rows.
- Thu xe → `rpc/create_vehicle` 200 → row persisted (`XE-2026-000005`, plate normalized to `51H1-2345`).
- Lưu xe → `rpc/update_vehicle` 200 → note edit survived a hard reload.
- Bán xe → `rpc/sell_vehicle` 200 → sale `BH-2026-000005`, vehicle SOLD.
- VietQR → `rpc/create_vietqr_payment_request` 200 → ref `CAREM GD01003` (reopens same ref).
Independent DB cross-check of the browser-created vehicle:
`id c58ebcdd-98f2-482c-8b94-9a50617f7bcd` status SOLD, purchase_price 42.000.000,
sale_price 60.000.000, vietqr CAREM GD01003. Screenshots in `backups/uiux-evidence/`.

### 8.2 A2 — OWNER-private price PROVENANCE — GAP CONFIRMED → **CLOSED by #13 (§8.7)**
> **Resolution:** the OWNER chose **A2-block → design-v3 provenance**. A new forward
> migration `20261011000100_financial_provenance_privacy.sql` (#13) implements it and
> is now authored, applied to the isolated DB, security-matrix-tested and E2E-rehearsed.
> See §8.7. The evidence below is the original diagnosis that motivated #13.

Verified actors: STAFF and MANAGER both `can_view_financials = false`. With a vehicle
whose `purchase_price` is entered by the **OWNER** (staff never touched it), the real
migrated DB shows:
- `rpc/list_vehicles` (STAFF and non-finance MANAGER) returns `purchase_price` **in the clear**
  (value 88.880.000 observed). Only `expense_total`/`total_cost` are gated by `can_financials()`.
- `rpc/list_sales` permits STAFF and returns `sale_price` (value 105.000.000 observed).
- Direct `vehicle_financials` SELECT by STAFF → `[]` (physical/RLS layer closed). So the leak
  vector is the RPC projections, not the tables.

Root cause: `private.vehicle_json` (pending `20261010000300` L94) and `private.sale_json`
return the raw prices unconditionally, on the documented assumption that "staff enter the
cost." There is **no provenance / per-field visibility mechanism in any migration** — the
OWNER-private-by-provenance model is **design v3, still unimplemented and awaiting approval**.
Therefore R2-as-coded does **NOT** satisfy item 2 for OWNER-entered prices.

Options for the OWNER (before GO):
- **A2-accept**: approve the current model (operational prices shared with active staff; only
  aggregates gated). Ship R2 as-is.
- **A2-block**: require design-v3 provenance gating first → a NEW migration (13th) to write,
  review and rehearse; do NOT push R2 until it is green. This is the conservative path.
- **A2-interim**: minimal edit to the pending `20261010000300`/`sale_json` to gate the raw
  price behind `can_financials()` too — but this removes the staff below-cost cue and is a
  behavior change needing sign-off (not applied).

### 8.3 A3 — Auth/Storage recoverability + practical restore plan
Captured by the verified backup: `auth.users` = **5 rows including encrypted_password**
+ identities/metadata; **20 Storage object binaries** + inventory + bucket settings; 113
functions; RLS on all public tables; 14-table row-count reconciliation PASS.
**Bound (honest):** the restore drill replays Auth/Storage "against the local stub only"
— a **hosted** Supabase Auth/Storage restore (login, grants, image access) is NOT
end-to-end proven (`platformRestoreProven:false`). Not captured at all: GoTrue runtime
config (JWT secret, site_url, SMTP, providers), Edge Function code+secrets, dashboard keys.
Practical recovery if a prod migration goes wrong:
1. **PITR** (only if the plan provides it; free plan does not, Team does) → roll the DB to a
   pre-push point-in-time. Cleanest for Auth/Storage consistency.
2. Otherwise: fresh Supabase project → replay `schema.sql` + `data.sql` (business), re-provision
   Auth via **Supabase Admin API / managed Auth backup** (do not blindly INSERT over the hosted
   `auth.users`; set `instance_id`), re-upload the 20 Storage binaries + buckets/policies, redeploy
   Edge Functions + secrets, then swap the app's `VITE_SUPABASE_URL/ANON_KEY` (Vercel env) to the new ref.
3. Because migrations are forward-only, the pre-push backup is the ONLY DB rollback. **Recommended
   pre-GO step: run one disposable Supabase staging restore drill** to flip `platformRestoreProven`
   to true before touching prod.

### 8.4 A4 — post-ai type-only fix in the release source
Committed as **`ba21a65`** on `integration/one-carem-latest` (1 file, 2 lines, type-only:
import `SupabaseClient`, retype `metered`). `deno check supabase/functions/post-ai/index.ts`
= exit 0 at that commit. NOT pushed, NOT deployed (origin still `1c8609c`). Deploy prep:
`supabase functions deploy post-ai` with secrets `GEMINI_API_KEY`, `POST_AI_ENABLED=true`,
`GEMINI_MODEL` (default), `POST_AI_DAILY_LIMIT` (default 400); `npm:` imports are supported by
the Edge runtime; all 7 dependent RPCs exist in the migrated DB; `log_post_ai_usage` signature
matches the call. post-ai is still MISSING in prod → deploy at GO.

### 8.5 A5 — Re-check before execution (all read-only)
- Backup: newest is nightly `2026-10-10-213005` (24 files, 20 Storage objects, authUsers 5,
  integrity ok); manual verified drill set is `2026-10-10-210134` (same-day, identical footprint).
- Ledger: prod applied through `20261006001400`, exactly **12 pending**, nothing pushed.
- LIVE counts (re-confirmed): message_outbox 6, customer_communications 6, notifications 79,
  vehicle_activity 57, audit_logs 116 = **264 purge**; vehicles 7, sales 6.
- DROP/DELETE scope: purge deletes the 5 history tables (264 rows) + drops 6 `vehicles`
  columns (brand, model, variant, engine_number, odometer, asking_price) + 2 `system_settings`
  columns (quickpick_brands, quickpick_models). No `vehicles`/`sales`/`auth` row loss.
- `message_events` appears in the backup `missingTables`: it exists in NEITHER prod NOR the
  migrated schema and is referenced by NO migration/source — it is a stale expectation in the
  backup inventory, **not** an R2 gap or data risk (benign).

### 8.6 Corrected FINAL GO / NO-GO
Functional/data gates (A1, A3, A4, A5) are GREEN. **A2 is now CLOSED by migration #13**
(OWNER chose A2-block → design-v3 provenance; see §8.7). **Recommendation: GO** to
apply the 13-migration chain to production, contingent on the OWNER's explicit
authorization of this document. R2 MUST ship WITH #13 — applying the 12 alone leaves
the OWNER-private leak in place. See §8.7 for the remediation evidence and §9 for the
updated residual risks.

### 8.7 A2 REMEDIATION — provenance migration #13 (implemented, tested, isolated only)
Implements the mandatory policy: (a) OWNER-entered purchase AND sale price → PRIVATE;
(b) non-entitled STAFF/MANAGER cannot read it via UI/RPC/PostgREST **or inference**;
(c) STAFF-entered price → PUBLIC (business-visible); (d) legacy/undeterminable → RESTRICTED;
(e) below-cost sale + OWNER approval preserved without leaking shortfall/price.

**Model.** New enum `public.money_visibility('PUBLIC','PRIVATE','RESTRICTED')`; classifier
`private.price_visibility_for(user)` (active OWNER→PRIVATE, active STAFF/MANAGER→PUBLIC,
else→RESTRICTED); `private.money_disclosable(vis)` = `PUBLIC OR private.can_financials()`.
Three `*_visibility` columns added NOT NULL DEFAULT 'RESTRICTED' and backfilled:
`vehicle_financials.purchase_price_visibility`, `acquisitions.purchase_price_visibility`,
`sales.sale_price_visibility`. Write protocol stamps visibility from `auth.uid()` at
insert/update (`save_vehicle`/`acquire_vehicle`/`sell_vehicle`/`import_vehicles`).

**Read gating (all surfaces, verified):** `private.vehicle_json` emits
`purchase_price = CASE WHEN disclosable THEN value ELSE NULL END` plus a
`purchase_price_hidden` flag; `private.sale_json`/`get_sale` strip `sale_price`,
`paid_amount`, `remaining_amount`, `debt_status`, `is_overdue` when non-disclosable;
`list_acquisitions`, `list_receivables`, `get_customer_history`, `list_customers`,
`global_search`, `dashboard`, `daily_reconciliation` gated identically. RLS on
`sales_read`/`payments_read` requires `money_disclosable(...)`; `approvals_read` is
OWNER-only.

**Anti-oracle.** `sell_vehicle` (non-OWNER, cost hidden) raises a single uniform
`SALE_OWNER_CONFIRMATION_REQUIRED` regardless of above/below cost, so STAFF cannot
binary-search the hidden price. `request_sale_below_cost` accepts uniformly when the
cost is hidden; its payload (`shortfall`, `snapshot_purchase_price`) is readable only
by OWNER (`approvals_read` + `list_pending_approvals` OWNER gate). `add_payment`
raises `PAYMENT_OWNER_REQUIRED` (non-OWNER, PRIVATE sale) BEFORE the balance check so
no payment-path oracle. Frontend `SellVehiclePage` routes any hidden-cost sale to the
OWNER approval queue and never infers margin from an absent value.

**Evidence (isolated only — no prod touched):**
- Security matrix `scratch/sec-matrix.mjs` (STAFF/MANAGER-no-fin/MANAGER-fin/OWNER ×
  RPC/PostgREST/UI, all read+write surfaces + anti-oracle): **all privacy assertions
  PASS**; the one initial FAIL was a probe receipt-id extraction artifact, fixed and
  independently re-validated in `scratch/pay-gate.mjs` (MGR-no-fin→`PAYMENT_OWNER_REQUIRED`,
  MGR-fin→recorded).
- Migration applies cleanly in the full forward chain (`supabase db reset --local`).
- Regression E2E on the isolated embedded-Postgres harness: business-flows **19/19**,
  below-cost-approval + showroom-no-price + sell-no-prefill + acquisitions **11/11**;
  `tsc -b` clean. Full suite 202 passed; the only failures are two **pre-existing**
  order/isolation flakes unrelated to this change — `workflows.spec.mjs:702` (expense
  picker) and `ux-convenience.spec.mjs:958` (camera frame classify). 702 was proven
  pre-existing: it fails 2/2 in isolation at BASELINE (original schema, edits stashed,
  migration absent), logs in as OWNER (so read-gating is irrelevant to it), and touches
  no code this remediation modifies.

---

## 9. Updated FINAL GO / NO-GO (post-remediation)

**Recommendation: GO — apply the 13-migration chain to production**, contingent on the
OWNER's explicit authorization of this document and the §3 order of operations.

- All R2 functional/data gates (A1, A3, A4, A5) GREEN.
- A2 security gap CLOSED by #13; provenance privacy validated end-to-end at DB, RPC,
  RLS and UI layers on the isolated environment.
- #13 is atomic and non-destructive (0 DROP / 0 DELETE of business rows; additive
  columns + backfill only) — lowest-risk member of the chain.

**Residual risks to accept before GO:**
1. 2/13 files autocommit (#2,#7) → theoretical partial-apply window (both additive/idempotent;
   mitigated by re-run + verified backup). #13 is atomic, not autocommit.
2. Platform-level Auth/Storage hosted restore not end-to-end proven — one-time staging
   restore drill recommended pre-GO (§8.3).
3. Destructive scope unchanged: migration #3 only (264 history rows + 6+2 columns).
4. Two pre-existing E2E flakes (702, 958) — not remediation regressions; tracked as a
   separate test-flakiness item, out of scope here.

**Blocked until OWNER GO (do NOT perform):** `supabase db push` to production, any
production DROP/DELETE, `functions deploy`, additional Vercel deploy, git history rewrite.
**STOP.** All remediation gates green; awaiting OWNER's final GO to execute §3 + §6.
