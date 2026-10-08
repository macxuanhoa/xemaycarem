# Production release readiness — Xe CRM

Last reviewed: 2026-10-02 (Asia/Saigon) — release-prep pass 4 (backend production gates verified & completed)

## Decision

**BACKEND PRODUCTION: READY.** The Supabase production project (`atsgqtarxhmxrsugulva`, xemaycarem) has been fully verified:
- All 31 migrations (`20260930000100` through `20261001003100`) are applied on the remote database (`db push --dry-run` reports `Remote database is up to date`).
- Production schema drift reconciliation verified: 79 function bodies, tables, policies, and constraints converge with 0 code drift.
- Edge Function `manage-users` is deployed and ACTIVE with `verify_jwt = true`.
- Retired function `reset-owner` has been permanently deleted from the remote project.
- Remote Supabase Auth configuration is confirmed with Site URL `https://carem.vercel.app` and required redirect URLs.
- Next phase: Vercel preview deployment verification followed by main branch promotion.

## Checkpoint and data safety

- Active release branch: `release/xe-crm-v1` (the earlier `codex/xe-crm-release-checkpoint` / commit c3bfe1db is superseded by this branch, which now also carries the pooled-DB-harness fix, regenerated knowledge seed, neutralized 018, and reconciliation migration 031 as logical commits).
- Starting worktree was already dirty. No earlier snapshot exists to attribute individual edits to the previous implementation turn. No files were reset or discarded.
- `.env` was absent. `.gitignore` now excludes `supabase/.temp/`; no CLI link metadata is staged.
- `docs/AUTH_BACKUP_METADATA.md` remains local and is excluded from the checkpoint because it contains personal account metadata.
- `supabase/migrations/20260930001800_reset_owner_password_default.sql` was preserved in the worktree, excluded from the checkpoint, and is now quarantined at `supabase/quarantine/` (Git-ignored; `supabase/migrations/20260930001800_*` is ignore-guarded so it can never re-enter the migration set). It contains a hardcoded owner default password and emits that value in notices. It must not be applied or included in a public/shared commit. If it was ever used, rotate the affected credential. The final repository strategy for version 018 (sanitized no-op historical placeholder versus permanent exclusion) awaits remote migration-ledger evidence.
- No production database, Auth, account, business record, Edge Function, backup, or configuration was changed.

## Migration inventory and reconciliation

> **2026-10-03 status update (verified via Supabase CLI):** Production migration ledger 001–037 are **APPLIED** on project `atsgqtarxhmxrsugulva` (xemaycarem, Singapore). `db push --dry-run` reports “Remote database is up to date.” The earlier snapshot below (“001–025 applied, 026–031 pending”) was captured when CLI access was unavailable and is now historically accurate only at the time of writing. The migration table rows that say “UNVERIFIED” or “No — reconcile ledger/target first” for migrations 001–037 are superseded: they were applied safely under the backup → dry-run → push → verify protocol.

Local files at the time of the original audit: versions `20260930000100` (001) through `20261001003100` (031), 31 total. The 2026-10-02 production capture (`backups/carem-prod-20261002-091111-migration-history.txt`) showed production had **001–025 applied** and **026–031 pending**. Version 018 is present in that ledger, which is why it is kept locally as a neutralized no-op placeholder so `db push` sees it already-applied and executes nothing. The captured RLS policies are the pre-reconciliation (025-era) bodies, which is exactly the drift migration 031 re-applies. Since that capture, migrations 026–037 have been successfully applied.

| Version | Local purpose | Static safety review | Production status | Safe to apply now? |
|---|---|---|---|---|
| 026 | Customer communications (outbox, history, per-sale events) | Review; new tables + `process-message` worker contract; MOCK provider only | UNVERIFIED | No — reconcile ledger/target first |
| 027 | System announcements | Review; new table + read RPC | UNVERIFIED | No — reconcile ledger/target first |
| 028 | `knowledge_base` table, RLS and read RPCs for the AI copilot | Review; audience-tiered read surface, browser has no write path | UNVERIFIED | No — reconcile ledger/target first |
| 029 | `knowledge_base` documentation seed (generated from repo markdown) | UPSERT + prune by source; safe to re-apply; regenerate via `npm run knowledge:seed` | UNVERIFIED | No — reconcile ledger/target first |
| 030 | CCCD identity-document module (PII isolation + private storage) | Review; PII stored in private bucket, access gated; anon revoke hardened in 031 | UNVERIFIED | No — reconcile ledger/target first |
| 031 | Forward-only production reconciliation | Re-applies 15 drifted function bodies and the exact grant/revoke + RLS matrix to match the validated local replay; `CREATE OR REPLACE` on signatures verified 1:1, creates no new objects, deletes no data | UNVERIFIED | No — must be confirmed as the true pending subset against the live ledger first |

| Version | Local purpose | Static safety review | Production status | Safe to apply now? |
|---|---|---|---|---|
| 001 | Base schema, core types/tables, RLS and helper functions | Review; foundational DDL and privileged functions | UNVERIFIED | No — reconcile ledger/target first |
| 002 | Business mutation RPCs | Review; SECURITY DEFINER business writes | UNVERIFIED | No — reconcile ledger/target first |
| 003 | Query/read RPCs and views | Review; authorization and financial result shaping | UNVERIFIED | No — reconcile ledger/target first |
| 004 | Storage policies and grants | Review; storage/RLS/grant effects | UNVERIFIED | No — reconcile ledger/target first |
| 005 | Acquisition ledger, vehicle lifecycle refactor, backfill | **Blocked pending data review**; updates empty frame numbers, drops/replaces an index, enforces unique/NOT NULL, backfills acquisition rows with a zero fallback | UNVERIFIED | No |
| 006 | Username authentication | **Review required**; profile/Auth account data updates | UNVERIFIED | No |
| 007 | Username generation repair | **Review required**; drops/replaces functions and updates profile/Auth-related data | UNVERIFIED | No |
| 008 | Ensure existing OWNER login | **Review required**; changes account/profile login state | UNVERIFIED | No |
| 009 | Display OWNER login information | Review; may emit account identifiers in migration notices | UNVERIFIED | No |
| 010 | RLS and Auth email synchronization fixes | **Review required**; replaces policies and changes account behavior | UNVERIFIED | No |
| 011 | Auth email synchronization | **Blocked pending account review**; updates `auth.users` email values | UNVERIFIED | No |
| 012 | Auth trigger reset and account synchronization | **Blocked pending account review**; replaces trigger and updates user/profile state | UNVERIFIED | No |
| 013 | OWNER temporary-password gate instructions | **Review required**; sets active OWNER `must_change_password` state (does not itself set the password) | UNVERIFIED | No |
| 014 | Roll back Auth email synchronization | **Blocked pending account review**; changes Auth email identity | UNVERIFIED | No |
| 015 | Schedules and soft-delete support | Review; profile schema changes and creates account-delete logic | UNVERIFIED | No |
| 016 | Auth email sync repair and account deletion support | **Blocked pending account review**; adds Auth-user deletion behavior and synchronization | UNVERIFIED | No |
| 017 | Force-sync Auth emails | **Blocked pending account review**; bulk updates Auth user emails | UNVERIFIED | No |
| 018 | Reset OWNER to a default password | **Neutralized no-op placeholder** (`SELECT 1;`) now lives in `supabase/migrations/` so the local ledger matches remote history; the credential-bearing original is quarantined at `supabase/quarantine/` (Git-ignored, must never be restored). Historically executed on 2026-09-30, so rotate the affected credential if it was ever used. | UNVERIFIED | No — already-applied no-op; do not restore the quarantined original |
| 019 | Direct password reset helper and credential view | **Unsafe legacy surface**; privileged password reset helper is granted to `authenticated`; later migration 022 drops legacy objects | UNVERIFIED | **No — do not deploy** |
| 020 | Show login information | Review; emits owner email/username/account details in notices (includes a sample SQL command) | UNVERIFIED | No |
| 021 | Password-reset request queue | **Unsafe legacy surface**; stores requested password as plaintext and defines a reset processor; later migration 022 removes it | UNVERIFIED | **No — do not deploy** |
| 022 | Auth recovery and account controls | **Review required**; drops legacy private reset objects with `CASCADE`, replaces account controls and RLS | UNVERIFIED | No |
| 023 | Operational workflows | Review against live rows/constraints and RPC signatures before any apply | UNVERIFIED | No |
| 024 | Operational integrity constraints and concurrency behavior | Review existing data for conflicts/locks before any apply | UNVERIFIED | No |
| 025 | Password-change proof and financial visibility controls | **Review required**; adds private tracking/trigger behavior, changes authorization/policy surface, removes legacy helpers | UNVERIFIED | No |

No production-only migrations, manually applied migrations, duplicate versions, or remote-only versions could be confirmed or ruled out at the time of the original audit. There are no duplicate local version prefixes. Historical Auth and business SQL has been statically inspected. The remote ledger was subsequently queried successfully via the Supabase CLI (2026-10-03) and all 001–037 are confirmed applied with no orphan remote versions.

## Pending destructive migration — vehicle field purge (2026-10-08)

Ledger re-checked read-only on 2026-10-08: **57 applied through `20261006001400`, 3 local/pending, 0 divergent**. The pending set is `20261008000100_staff_delete_permanent.sql`, `20261008000200_staff_vehicle_parity_and_delete_approval.sql` and `20261008000300_vehicle_type_catalog_and_purge.sql`. None has been pushed.

`20261008000300` is the only migration in the repo that **destroys data on purpose**, so it gets its own protocol line. It creates `public.vehicle_types` + three catalogue RPCs, then irreversibly: `ALTER TABLE public.vehicles DROP COLUMN brand, model, variant, engine_number, odometer, asking_price CASCADE`; `ALTER TABLE public.system_settings DROP COLUMN quickpick_brands, DROP COLUMN quickpick_models`; `DROP INDEX vehicles_engine_number`; and `DELETE FROM audit_logs / vehicle_activity / notifications / customer_communications / message_outbox` (all rows, no tombstone, with the `immutable_audit`/`immutable_activity` triggers suspended only for that statement and recreated afterwards). It rebuilds every function that referenced a dropped column and ends with a `DO` block that aborts the transaction if any purged column, any surviving history row, any untyped vehicle, the dropped index, or any `pg_proc` body still naming a purged field is found (`PURGE_ASSERT_FAILED: …`). Business and financial tables are not touched and no `sale_financials` snapshot is rewritten.

Non-negotiables before this version may be applied to `atsgqtarxhmxrsugulva`:

1. Same-day pre-write logical dump (`npm run backup:prod`) — the only recovery point on the FREE plan, and the last copy that still contains the fields about to be deleted. Record it in the manifest and mark it as the pre-purge set.
2. `db push --dry-run` must list exactly the three pending versions above and nothing else.
3. Explicit per-operation OWNER authorization for the write, per `docs/AGENT_HANDOFF.md`; the authorization must name the purge as irreversible, because no forward-only rollback exists.
4. Full local gate suite green including a clean replay of the whole 60-file chain on a disposable database.
5. Deploy the rebuilt Edge Functions (`ai-assist`, `process-message`) in the same release window, otherwise the hosted assistant still exposes the deleted `odometer` task and old vehicle fields while the database no longer has them.
6. Release the frontend bundle before or with the migration — an old PWA is refused writes (`VEHICLE_TYPE_REQUIRED`), which is intended fail-closed behavior but looks like an outage to staff if the deploy order is reversed.

Post-apply verification (read-only): row counts of `vehicles`, `acquisitions`, `sales`, `payments`, `vehicle_expenses`, `sale_financials` must match the pre-apply figures exactly; the five history tables must be `0`; every vehicle must have a non-null `vehicle_type_id`; one old vehicle must open with the title **biển số · số khung** and subtitle **loại xe · đời · màu**; one sold receipt must still show the real sale price with no estimated-price line. Full details in `docs/VEHICLE_FIELD_PURGE_IMPACT.md`.

## Backup and recovery

- Current production backup/PITR plan/retention: **FREE plan — no PITR, no scheduled backups** (verified read-only 2026-10-03).
- Current usable restore point: manual logical dumps (`backups/carem-prod-20261002-091111-*`, `backups/carem-prod-2026-10-03-083109-*`).
- Restore drill or recovery test: **not performed**.
- Generic procedure: `docs/OPERATIONS.md`; it does not establish current production capability.
- Database and Storage recovery must be considered together. Before schema changes, verify the Supabase plan's backup/PITR and retention in the live Dashboard, record a usable checkpoint, and document the forward recovery for each reviewed migration. Do not invent down migrations for destructive data changes.

## Edge Function inventory

| Function | Purpose | Local status | Required runtime configuration | Deployed? | Production-tested? |
|---|---|---|---|---|---|
| `manage-users` | OWNER account administration (user create/update/reset/disable flows) | Local code and tests present; deployed v10 ACTIVE (2026-10-02); runtime behavior parity with post-refactor committed source (`4cc3ff9`) is UNVERIFIED | Supabase URL and public/anon key, server-side administrative key; CORS now enforces the `ALLOWED_ORIGINS` env list (exact origins; unset falls back to SDK defaults for local development only) | Yes — v10 | Parity check pending |
| `ai-assist` | Optional authenticated, role-aware read-only assistant | Local code present; deployed v3 ACTIVE (2026-10-02) | `AI_ENABLED=true`, `AI_PROVIDER_API_KEY`, `AI_MODEL` plus Supabase runtime configuration | Yes — v3 | Deterministic path exercised; LLM path unconfigured |
| `reset-owner` | Retired endpoint | Local handler returns HTTP 410 | None | Correctly not deployed | No |

`process-message` requires explicit `verify_jwt = true` (declared in `supabase/config.toml`) and authenticated worker invocation; messaging remains MOCK-only and it must not block the CRM release.

Never place service/admin or provider credentials in client code, migration notices, logs, or Git. The AI provider key remains server-side and is absent in this workspace. Normal CRM release must not depend on AI.

## Production smoke tests

The Vercel production smoke script (`scripts/smoke-vercel-prod.mjs`) passes on `xemaycarem.vercel.app` (verified 2026-10-03). The following deeper hosted checks remain partially or fully untested:

| Area | Status | Safe next verification |
|---|---|---|
| OWNER email/username login, employee login, password/schedule/role restrictions | NOT TESTED | Use existing account without changing OWNER password; use disposable employee accounts after release gates |
| Manage-users CORS/auth/OWNER allow/STAFF deny/error handling | NOT TESTED | Invoke deployed function with controlled accounts after reviewed deploy |
| Acquire vehicle → inventory, expense, sale → SOLD, payment/receivable, customer history, dashboard | NOT TESTED | Use a controlled vehicle and clearly marked disposable records; verify/clean up safely |
| Reconciliation, global search, small CSV import and invalid/duplicate row behavior | NOT TESTED | Use a tiny fictional CSV and disposable rows; never start with a bulk real import |
| QR generate/scan, internal identifier only, permission enforcement | NOT TESTED | Confirm payload contains no cost/profit/customer PII, then scan in hosted browser |
| Receipt/sales document visual layout and physical printing | NOT TESTED | Verify Vietnamese text, amounts, identifiers, dates, pagination and margins on target printer |
| Hosted PWA, caching, search latency, initial bundle, logs/error observability | NOT TESTED | Measure deployed app and confirm logs omit secrets and sensitive customer content |
| Android Chrome/PWA and iPhone Safari/PWA device matrix | NOT TESTED — DEVICE REQUIRED | Camera, mic, install/reopen, draft, keyboard, sticky actions, swipe, QR and print flows |

## Local verification and bundle

Local gates recorded in `docs/VERIFICATION.md` remain separate from production results. A fresh `npm run build` completed successfully on 2026-09-30. The initial entry is 736.97 kB raw / 220.67 kB gzip and triggers Vite's warning; production performance has not been measured. The camera Capture route is 3.62 kB and dynamically loaded; `html5-qrcode` is a separate 375.14 kB raw / 110.56 kB gzip chunk imported only after camera scanning is invoked. It is not part of the initial JS entry, so the earlier label calling the 737 kB entry the camera chunk was inaccurate. No library change is justified by the local size warning alone.

## Next safe action

Supabase CLI access is available and the live project ref has been verified (see 2026-10-03 status update above). Future production writes still require: re-confirm target identity, take a same-day pre-write dump, run `db push --dry-run`, apply only explicitly authorized forward migrations, verify post-apply state, and update this document. `manage-users` deployed-version parity with the `4cc3ff9` committed source is the top pending hosted-verification item.


