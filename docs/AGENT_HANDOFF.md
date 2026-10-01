# Release handoff — Xe CRM

Last reviewed: 2026-10-01 (Asia/Saigon)

## Phase 1 customer communication handoff — 2026-10-01

Phase 1 is implemented locally in migration `20261001002600_customer_communications.sql`, `supabase/functions/process-message`, and the sales/customer/settings UI. Sale creation adds one thank-you outbox event in the normal `sell_vehicle` transaction; a nested exception boundary ensures an outbox/config write fault cannot roll back the sale. Provider work is attempted only after the sale commits. Messaging defaults OFF. The only worker mode implemented is MOCK; missing provider is recorded as `SKIPPED / PROVIDER_NOT_CONFIGURED`. No provider secret is present in frontend or tracked source. Do not claim production delivery or deploy to hosted Supabase from this workspace: live target identity, migration ledger, and backup/recovery remain unverified per the release blockers below.

At phase start, the repository search found no communication/outbox/history implementation. Existing `sell_vehicle`, settings RPC, customer history and private phone normalization were reused. Local checks: typecheck, lint, 176 unit tests, 26 migration replay / 77 DB integration tests, 34/34 E2E tests, build, PWA check, and local Edge TypeScript check. These are not hosted/production checks. There is no hosted scheduler; a transient job stays queued with a backoff timestamp until another trusted worker invocation. Real provider activation and hosted migration/function deployment remain blocked by release-readiness requirements below.

## UI feedback + system announcement handoff — 2026-10-01

This turn adds a client feedback layer and a persistent store-wide announcement feature without touching core business workflows (sales, acquisitions, inventory, payments, profit, auth, roles, existing RPC safety). No toast/dialog library was installed: toasts (`src/lib/toast.ts`, rendered by `src/components/ui/Toaster.tsx`) and a single reusable confirm dialog (`src/components/ui/ConfirmDialog.tsx` exposing `confirmAction()`) are hand-built and mounted in `src/App.tsx`. The only native `window.confirm` in the codebase (the `useFormDraft` unsaved-draft navigation guard) now uses `confirmAction()` and re-fires the link click after confirmation; the `beforeunload` handler is untouched. The PWA install `prompt.prompt()` in Settings is a browser API, not a native dialog, and was left as-is.

Backend: migration `20261001002700_system_announcements.sql` creates `public.system_announcements` (with `announcement_type`, `announcement_display`, `announcement_audience` enums), five SECURITY DEFINER RPCs, `private.audit` on every mutation, RLS enabled, and direct table/function access revoked from `public`/`anon`/`authenticated` (only `authenticated` gets EXECUTE). OWNER-only writes are enforced server-side, not just by hiding buttons. `list_active_announcements` filters by `is_active`, the Asia/Ho_Chi_Minh time window, and audience role, ordered by priority. The app-shell `AnnouncementBar` polls active announcements, shows one primary banner (static or CSS-scrolling ticker that pauses on hover and freezes under `prefers-reduced-motion`), supports "Xem thêm" overflow, and per-device dismissal via `localStorage` keyed by id+`updated_at`. The OWNER manager lives under Cài đặt → Thông báo hệ thống.

Local checks only: `npm run typecheck` passes; `tests/unit/feedback-notifications.test.ts` (3 tests) passes; the standalone operational DB suite reports 33 passing checks including 5 new announcement tests. Do not deploy this migration to hosted Supabase: it is not in the release checkpoint, and target identity/ledger/backup remain unverified per the blockers below.

## Release state

The local implementation phase is complete according to `docs/IMPLEMENTATION_REPORT.md` and `docs/VERIFICATION.md`. The local gates recorded there are green; the production build was rerun during this release audit and completed successfully. These results do not verify hosted Supabase, production Auth, Edge Functions, physical devices, printers, or production performance.

No production database, Auth configuration, Edge Function, backup, or business record has been changed or verified during this release-readiness turn.

## Repository checkpoint

- Starting branch: `main`, tracking `origin/main`; history contained only `b5b21df` (`Initial commit: Quản lý Cửa Hàng Xe Máy Cà Rem`).
- The worktree was already dirty at the start, with staged/unstaged edits and new implementation files. There is no earlier snapshot that can reliably separate pre-existing work from the latest implementation. Nothing was reset or discarded.
- Local checkpoint branch: `codex/xe-crm-release-checkpoint`.
- A hardcoded default owner password was found in historical migration `20260930001800_reset_owner_password_default.sql`. That file also emits the value in migration notices. It is preserved in the worktree but intentionally excluded from the release checkpoint; do not apply it. Treat the value as exposed if it was ever used and rotate it through the approved account process.
- `docs/AUTH_BACKUP_METADATA.md` is preserved locally but excluded from the checkpoint because it contains personal account metadata.
- `supabase/.temp/` is ignored and excluded. `.env` was absent and no Supabase CLI/access token was available.
- No push is planned.
- Checkpoint commit hash: c3bfe1db87fba48595a46dde0a47bd4398a9f4ad.

## Target, migration ledger, and recovery

- The cached Supabase link reference matches the reference recorded in `docs/AUTH_RECOVERY_AUDIT.md`; this only checks local cached metadata against a local note. The live target project identity is **not verified**.
- Supabase CLI is unavailable and `SUPABASE_ACCESS_TOKEN` is not configured, so the linked production migration history could not be queried.
- The worktree now has 27 migration files, versions `20260930000100` through `20261001002700` (the newest, `20261001002700_system_announcements.sql`, and the customer-communications migration are not in the checkpoint). The safe checkpoint intentionally omits version `20260930001800`; the checkpoint therefore must not be used for `db push` or represented as a reconciled deploy set.
- Production status for every version is `UNVERIFIED`. The disposable PostgreSQL suite replay is local testing, not production-ledger evidence.
- Production backup/PITR availability, a restore point, and a recovery path have not been verified. The general plan in `docs/OPERATIONS.md` is guidance, not proof of a production backup.
- All production database apply operations are blocked until target identity, complete remote ledger reconciliation, migration review, and backup/recovery evidence are available.

## Functions and optional integrations

- `manage-users`: local account-management function; requires Supabase runtime configuration, a server-side administrative key, and allowed-origin configuration. Not confirmed deployed or production-tested.
  - Extended with OWNER-only server-side actions: `CHANGE_ROLE`, `PROMOTE_TO_OWNER`, `DEMOTE_OWNER`, `ENABLE_USER`, `FORCE_PASSWORD_CHANGE`
  - All privileged actions are audited to `audit_logs` table (actor_user_id, target_user_id, old/new role/state, timestamp)
  - Protection against demoting/disabling the final active OWNER (system must always have >=1 active OWNER)
  - UI: "Nâng thành Chủ cửa hàng" special button (not in normal role dropdown) for current OWNER to promote staff
  - Role changes now go through `manage-users` edge function instead of direct `update_profile` RPC
  - Reuses existing architecture; no second user-management system created
  - `profiles.role` remains protected from direct authenticated UPDATE (no RLS grants loosened)
- `ai-assist`: optional local authenticated/read-only assistant; requires `AI_ENABLED`, `AI_PROVIDER_API_KEY`, and `AI_MODEL` server-side. Provider configuration is absent; AI remains disabled and is not a CRM release dependency.
- `reset-owner`: retired local endpoint returns HTTP 410. Do not deploy it.

## User management architecture

All account administration after initial OWNER bootstrap is possible from the Nhân sự UI without SQL Editor:

**Flow:** Browser authenticated user → `manage-users` Edge Function → verify caller identity → load caller profile → require `caller.role === OWNER` for privileged actions → server-side service-role Supabase client → Auth/profile mutation → audit_logs → response

**OWNER-only server-side actions:**
- `CREATE_USER`: Create Auth user + activate profile with rollback on failure
- `CHANGE_ROLE`: Change user role (STAFF/MANAGER only via normal dropdown)
- `PROMOTE_TO_OWNER`: Promote active user to OWNER (special UI button)
- `DEMOTE_OWNER`: Demote OWNER to lower role (requires >=2 active owners)
- `ENABLE_USER`: Re-enable disabled user
- `DISABLE_USER`: Soft deactivate (preserves history)
- `TEMP_LOCK_USER`: Temporary lock with expiry
- `UPDATE_ACCESS_SCHEDULE`: Update working hours/days
- `RESET_TEMP_PASSWORD`: Set temporary password + force change on next login
- `FORCE_PASSWORD_CHANGE`: Require password change without setting new password
- `RESTORE`: Reactivate deleted account
- `HARD_DELETE`: Complete deletion (only if no business history)

**Security guarantees:**
- `SUPABASE_SERVICE_ROLE_KEY` never exposed to frontend
- `public.profiles.role` not directly writable by ordinary authenticated clients
- OWNER role verification happens server-side before any privileged action
- Final active OWNER cannot be demoted, disabled, or deleted
- Multiple OWNER accounts supported
- All privileged actions audited (never logs passwords)
- Passwords handled via Supabase Admin API (no raw SQL password writes)

**UI behavior:**
- OWNER role not shown in normal role dropdown (prevents casual selection)
- Special "Nâng thành Chủ cửa hàng" button with Crown icon for OWNER to promote staff
- Button only visible to current OWNER, only for non-OWNER active users
- Role changes trigger session/profile refresh for permission updates

**Test coverage:**
- All 238 tests pass including new OWNER-only security tests
- STAFF/MANAGER cannot promote or change roles
- OWNER can promote STAFF to OWNER
- OWNER can demote another OWNER when >=2 active owners exist
- Final active OWNER cannot be demoted, disabled, or deleted
- User cannot self-promote through direct client call
- Audit logs verified for privileged actions

## Local camera and bundle verification

A fresh `npm run build` passed. The HTML entry loads a 736.97 kB JavaScript entry (220.67 kB gzip), which triggers Vite's 500 kB warning. This is not the camera bundle. The Capture route is a 3.62 kB dynamic chunk, and `html5-qrcode` is in a separate 375.14 kB (110.56 kB gzip) chunk requested only after the camera action. Thus the camera library is lazy-loaded and absent from initial JavaScript. Production network/performance metrics remain unmeasured.

## Release validation still outstanding

1. Make the Supabase CLI available and authenticate using the approved local flow; never paste credentials into chat or commit them.
2. Verify the live project ref against an authoritative project record and inspect the linked migration ledger read-only. Reconcile remote-only/manual versions and the checkpoint's intentionally omitted version 018 before deciding any migration action.
3. Verify backup/PITR and a usable recovery checkpoint in the Supabase project.
4. Review exact pending SQL against live schema/data; only then consider applying reviewed forward migrations and structurally verify tables, views, indexes, RPCs, RLS, and constraints.
5. Deploy only required non-AI functions after environment/auth checks, then test CORS, authentication, OWNER authorization, STAFF rejection, and error handling in production.
6. Hosted Auth/business/UX/CSV/QR/receipt/PWA and observability smoke tests remain unverified. Use controlled disposable accounts/records only.
7. Android/iPhone/desktop device matrix and physical printer tests remain `NOT TESTED — DEVICE REQUIRED`.
8. Keep AI isolated; do not deploy/configure it without approved server-side secrets and production authorization review.

See `docs/PRODUCTION_RELEASE.md` for the migration inventory and release matrix.

