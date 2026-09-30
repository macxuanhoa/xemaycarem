# Production release readiness — Xe CRM

Last reviewed: 2026-09-30 (Asia/Saigon)

## Decision

**BLOCKED — no production operation was performed.** The local Supabase CLI is unavailable and there is no configured Supabase access token. The target project and remote migration ledger could not be queried. Production backup/PITR and an actual recovery point are unverified. Do not run `db push`, deploy Edge Functions, or claim release completion from this state.

The cached link metadata matches the reference written in `docs/AUTH_RECOVERY_AUDIT.md`, but this is only a local-to-local comparison. It does not prove the currently selected/live Supabase project is the intended production project.

## Checkpoint and data safety

- Local branch: `codex/xe-crm-release-checkpoint`.
- Checkpoint commit: c3bfe1db87fba48595a46dde0a47bd4398a9f4ad.
- Starting worktree was already dirty. No earlier snapshot exists to attribute individual edits to the previous implementation turn. No files were reset or discarded.
- `.env` was absent. `.gitignore` now excludes `supabase/.temp/`; no CLI link metadata is staged.
- `docs/AUTH_BACKUP_METADATA.md` remains local and is excluded from the checkpoint because it contains personal account metadata.
- `supabase/migrations/20260930001800_reset_owner_password_default.sql` remains preserved in the worktree but is excluded from the checkpoint. It contains a hardcoded owner default password and emits that value in notices. It must not be applied or included in a public/shared commit. If it was ever used, rotate the affected credential. The checkpoint consequently has a migration-version gap and is **not a deployable migration set**.
- No production database, Auth, account, business record, Edge Function, backup, or configuration was changed.

## Migration inventory and reconciliation

Local files: versions `20260930000100` through `20260930002500`, 25 total. Each row is present locally. Production status is `UNVERIFIED` for every version because the remote ledger was not accessible. The disposable database replay (25 migrations) is a local test only.

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
| 018 | Reset OWNER to a default password | **Unsafe: hardcoded credential and credential emitted in notices. Excluded from checkpoint. Never apply.** | UNVERIFIED | **No — do not deploy** |
| 019 | Direct password reset helper and credential view | **Unsafe legacy surface**; privileged password reset helper is granted to `authenticated`; later migration 022 drops legacy objects | UNVERIFIED | **No — do not deploy** |
| 020 | Show login information | Review; emits owner email/username/account details in notices (includes a sample SQL command) | UNVERIFIED | No |
| 021 | Password-reset request queue | **Unsafe legacy surface**; stores requested password as plaintext and defines a reset processor; later migration 022 removes it | UNVERIFIED | **No — do not deploy** |
| 022 | Auth recovery and account controls | **Review required**; drops legacy private reset objects with `CASCADE`, replaces account controls and RLS | UNVERIFIED | No |
| 023 | Operational workflows | Review against live rows/constraints and RPC signatures before any apply | UNVERIFIED | No |
| 024 | Operational integrity constraints and concurrency behavior | Review existing data for conflicts/locks before any apply | UNVERIFIED | No |
| 025 | Password-change proof and financial visibility controls | **Review required**; adds private tracking/trigger behavior, changes authorization/policy surface, removes legacy helpers | UNVERIFIED | No |

No production-only migrations, manually applied migrations, duplicate versions, or remote-only versions could be confirmed or ruled out. There are no duplicate local version prefixes in the 25-file directory. Historical Auth and business SQL has been statically inspected; a missing remote ledger means we cannot identify the pending subset or certify any row safe to apply. Do not infer production state from file presence or local test replay.

## Backup and recovery

- Current production backup/PITR plan/retention: **not verified**.
- Current usable restore point: **not verified**.
- Restore drill or recovery test: **not performed**.
- Generic procedure: `docs/OPERATIONS.md`; it does not establish current production capability.
- Database and Storage recovery must be considered together. Before schema changes, verify the Supabase plan's backup/PITR and retention in the live Dashboard, record a usable checkpoint, and document the forward recovery for each reviewed migration. Do not invent down migrations for destructive data changes.

## Edge Function inventory

| Function | Purpose | Local status | Required runtime configuration | Deployed? | Production-tested? |
|---|---|---|---|---|---|
| `manage-users` | OWNER account administration (user create/update/reset/disable flows) | Local code and tests present; runtime CORS/auth/role flows not hosted-verified | Supabase URL and public/anon key, server-side administrative key; CORS currently uses the Supabase SDK defaults, so production origin policy requires review | Unknown / not verified | No |
| `ai-assist` | Optional authenticated, role-aware read-only assistant | Local code present; remains disabled | `AI_ENABLED=true`, `AI_PROVIDER_API_KEY`, `AI_MODEL` plus Supabase runtime configuration | Unknown / not verified; should remain undeployed until separately reviewed | No |
| `reset-owner` | Retired endpoint | Local handler returns HTTP 410 | None | Must not deploy | No |

Never place service/admin or provider credentials in client code, migration notices, logs, or Git. The AI provider key remains server-side and is absent in this workspace. Normal CRM release must not depend on AI.

## Production smoke tests

All hosted checks below are **NOT TESTED** because no authenticated production connection/deployment was available. No real records or users were created/modified.

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

Make Supabase CLI access available using the approved local authentication flow without sharing tokens in chat. Then verify the live project ref and query `migration list --linked` read-only. In parallel, verify backup/PITR and restore point in the Dashboard. Reconcile all local/remote versions, including the deliberately omitted unsafe version 018, and prepare an exact reviewed migration plan before considering any production mutation. Stop if identity, ledger, or recovery evidence does not match.


