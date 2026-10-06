# Release handoff — Xe CRM

Last reviewed: 2026-10-06 (Asia/Saigon)

## Copilot answering + draft-to-save and release-candidate commit — 2026-10-06

Two Copilot capability batches plus supporting migrations were developed by a concurrent agent (Copilot) that is now confirmed stopped by process ownership (zero Codex/node/deno writer processes; newest dirty write frozen 17:31:13; Git drift 0). Both are COMPLETE and integrated and were reviewed as part of the final snapshot, not deleted for being off-roadmap:
- **Answering upgrade** — `supabase/functions/ai-assist/copilot.ts` broadens keyword intents and adds four read-only intents (Tổng quan, Đơn bán gần đây, Đối soát trong ngày, Khách hàng) reusing existing server-gated RPCs, a grounded `global_search` entity fallback, and Asia/Ho_Chi_Minh period parsing; a new `customer` citation type is wired through `src/types/index.ts` + `src/features/copilot/CitationLinks.tsx`, with suggested-question chips on `CopilotPage`. No write path, no provider needed.
- **Draft-to-save handoff** — `src/lib/shorthand/draftActions.ts` (deterministic parser) + `src/features/copilot/DraftActionCard.tsx` prefill existing secure forms only (`QuickExpenseModal`, `SellVehiclePage`, `ShorthandIntakePage`); no RPC fires without the human pressing save. One documented incomplete path: an unresolved expense plate navigates to `/expenses` with `location.state.aiDraft`, but `ExpensePages` does not yet consume that state (graceful degradation — see `docs/KNOWN_ISSUES.md`).

**Commit decision (validated necessity):** the 119-file tree was landed as a **single atomic commit**, not the earlier C1–C4 split. `npm run knowledge:check` is a whole-tree generated-artifact gate (SYSTEM_REFERENCE regenerated from every public RPC across migrations; the `20261006001400` reseed byte-compared against the markdown corpus), so any migration-only intermediate commit is provably red and intermediate reseeds would corrupt the real 42-applied/15-pending ledger. Combining into one always-green commit is the authorized alternative to knowingly-broken intermediates; it also makes `src/types/index.ts` hunk-splitting moot (types + `CitationLinks` + `CopilotPage` land together).

**Verification:** full green gate suite on the final tree (lint, typecheck, 372 unit, knowledge:check, test:db 30, core 16, ext 22, build, e2e 112, pwa + pwa-upgrade). Ledger re-confirmed LIVE read-only: 42 applied / 15 pending / 0 divergent. External secret-free byte-exact checkpoint retained at `carem-checkpoint-20261006` (0 restore mismatches). **No migration applied, no production write, no push, no deploy performed.** The 15 pending migrations remain LOCAL and require the backup → dry-run → push → verify protocol plus explicit authorization; the `20261006001400` reseed must only be deployed after the docs corpus it reflects is live.

## Business notification bell handoff — 2026-10-04

Adds a store-wide activity bell for OWNER / MANAGER / STAFF across desktop and mobile without touching any business RPC. Backend: forward migration `20261004003900_business_notifications.sql` creates `public.notifications` (recipient-scoped RLS, `read_at` transition-only update policy, direct access revoked for every browser role), `private.money_text`/`vehicle_label_text` helpers, an `AFTER INSERT ON public.audit_logs` trigger `notify_after_audit` that whitelists 8 actions and fans out per role tier, three SECURITY DEFINER RPCs (`list_notifications`, `mark_notifications_read`, `mark_all_notifications_read`) gated by `private.require_role`, and idempotent registration on `supabase_realtime`. Money/PII copy is chosen per recipient inside the trigger using the same `can_view_financials` rule as `private.can_financials()` — non-finance STAFF receive the money-free variant. Same-transaction noise is deduped by removing the child notification when the parent event lands (`CREATE_VEHICLE` skipped under `CREATE_ACQUISITION`; `CREATE_PAYMENT` under `CREATE_SALE`; `VOID_PAYMENT` under `CANCEL_SALE`), relying on `now()` being constant inside a transaction and matching `deep_link`. Frontend: `src/types` grows `NotificationAction`/`NotificationItem`/`NotificationList`/`NotificationGroup`; `src/lib/api.ts` exposes the three RPCs; `src/lib/notifications.ts` holds pure formatting helpers (`badgeLabel` with 99-cap, `groupLabel` Facebook-style Nãy/Hôm nay/Hôm qua/dd/MM(/yyyy), `relativeTime`, `groupNotifications` — all evaluated in `Asia/Ho_Chi_Minh` via `Intl` parts, no `toLocaleDateString` locale drift); `src/lib/useNotifications.ts` runs a single react-query list keyed by `limit`, subscribes to `postgres_changes` filtered by `user_id=eq.<uid>`, falls back to a 60s poll while the socket is not SUBSCRIBED, refetches on `window.online`, and marks read optimistically via `setQueriesData`; `src/components/NotificationBell.tsx` mounts in `AppLayout` topbar-right between the user chip and the theme toggle, uses `createPortal(document.body)` with `position: fixed` (overlay z=62 / panel z=63) so the topbar stacking context can never clip it, and renders the panel as a right-anchored 384px popover on desktop and a full-width sheet under the 66px topbar on mobile with a dimmed backdrop. Bell shows on every breakpoint (matching `.header-theme-toggle`). All styling lives at the tail of `src/styles.css` including `[data-theme="dark"]` overrides and `prefers-reduced-motion` gating for the ring/panel-in animations.

Local gates (all green, run 2026-10-04): `npm run lint`, `npm run typecheck`, `npm run test` (320 unit tests / 27 files, incl. new `business-notifications.test.ts` 9 checks), `npm run test:db` (full multi-suite replay + 11 new notification checks in `tests/db/notifications.test.mjs` covering fan-out tiers, same-txn dedup, list/mark scoping, and null-actor audit attribution), `npm run build`, `npm run test:e2e` (87/87 including 4 new bell specs in `tests/e2e/notification-bell.spec.mjs` — desktop+mobile visibility, badge count, click→mark-read+deep-link, mark-all clears badge, empty state), `npm run test:pwa`. `npm run knowledge:check` intentionally reports stale until the reseed migration is regenerated as part of the release phase; the bell itself does not touch RPC surface, so no other generator output drifted. Realtime publication is guarded by a `pg_publication` existence check so disposable test engines (PGlite/embedded-postgres) skip it cleanly while hosted Supabase picks it up on `db push`.

Release procedure (executed in the next step, not yet done in this workspace): manual pre-write backup → `npx supabase db push --dry-run` → `--yes` → verify ledger + anon 401/permission-denied (not 404) on the three new RPCs + `notifications` present in `pg_publication_tables` → regenerate `docs/SYSTEM_REFERENCE.md` (`npm run knowledge:system`) and cut a new forward `knowledge_reseed` migration carrying the updated corpus → commit + Vercel deploy + smoke test (create sale via STAFF session, verify OWNER bell receives notification within 60s).

## Behavioral defects A1–A7 handoff — 2026-10-02

The post-audit defect phase fixed A1–A7 only; the deferred technical-debt list (manage-users dispatch factory, StaffSettingsModal mutation factory, AuthProvider polling, money-formatter consolidation, theme tokens, prefetch abstractions, expense cancellation duplication) was deliberately untouched and remains the next phase.

Frontend: new `src/lib/debt.ts`, `src/lib/urlParams.ts`, `src/lib/vehicleFilters.ts`, `src/features/showroom/showroomLead.ts`; `ShowroomPage` rewritten to real inventory + persisted leads (fake `FEATURED_BIKES` deleted); `ReceivablesPage` shares one debt resolver across desktop/mobile, blocks silent due-date deletion, and updates URL params functionally; `InventoryPage`/`SellVehiclePage`/`ExpensePages` consume the canonical status-filter constants; `CustomersPage` gained the NEW-lead triage panel. Database (APPLIED on production per the 2026-10-03 ledger verification): `20261002003200_showroom_public_inventory.sql` (anon `list_showroom_vehicles`, IN_STOCK-only safe projection) and `20261002003300_showroom_leads.sql` (`showroom_leads` table, anon `create_showroom_lead` with validation/normalization/throttle, staff `list_showroom_leads`/`update_showroom_lead_status` with audit). Neither touched any previously applied migration.

Local gates (all green, run 2026-10-02): `npm run lint`, `npm run typecheck`, `npm run test` (304 unit tests / 26 files, incl. new `debt-status`, `url-params`, `showroom-lead`, `showroom-source-contract`, `inventory-status`, `shorthandIntake` suites and extended `inventory-filters`), `npm run test:db` (full multi-suite replay incl. 10 new showroom checks in `tests/db/showroom.test.mjs`, copilot-gap checks and boundary inventory-indicator checks), `npm run build`, `npm run test:e2e` (74/74), `npm run test:pwa`, `npm run knowledge:check` (green). Hosted deployment was initially blocked by the release blockers below; superseded the same evening — `003200`–`003400` were pushed after a fresh pre-write dump (`carem-prod-20261002-live2-*`) and the ledger was verified read-only on 2026-10-03 (see "Release state").

Same-batch extensions beyond A1–A7 (shipped together, each with its own coverage): dashboard inventory-indicator badge + Settings threshold wording (`src/lib/inventory-status.ts`, `tests/unit/inventory-status.test.ts`); shorthand vehicle intake `/intake` (`src/features/intake/`, `src/lib/shorthand/`, reusing the server `validate_import_vehicles`/`import_vehicles` RPCs); copilot question-gap feedback loop (migration `20261002003400_copilot_question_gaps.sql`, `ai-assist` hook, OWNER digest on `/docs`); documentation tooling (`scripts/build-system-docs.mjs` generates `docs/SYSTEM_REFERENCE.md` from code; `docs/INTERNAL_SOPS.md` added; both feed `knowledge:seed`). The batch also carries dark-theme completion for existing and new surfaces (`[data-theme="dark"]` blocks in `styles.css`, header theme-toggle restyle, `--chart-grid`/`--chart-point-ring` used by `DashboardPage`); it shares `styles.css`/`DashboardPage.tsx`/`AppLayout.tsx` with the verified feature code, so it travels in the same snapshot rather than being split per hunk. The doc edits were initially propagated by re-running the generator over `20261001002900_knowledge_seed.sql` in place — which turned out to be a governance violation because 029 had already been applied to production. Corrected forward on 2026-10-03 per this file's own contingency: 029 is restored to its committed at-apply form and the corpus now travels in the new forward migration `20261002003800_knowledge_reseed.sql` (kept LOCAL/PENDING; production already holds the equivalent 175 rows), and the generator targets the latest reseed migration instead of rewriting 029.

## Phase 1 customer communication handoff — 2026-10-01

Phase 1 is implemented locally in migration `20261001002600_customer_communications.sql`, `supabase/functions/process-message`, and the sales/customer/settings UI. Sale creation adds one thank-you outbox event in the normal `sell_vehicle` transaction; a nested exception boundary ensures an outbox/config write fault cannot roll back the sale. Provider work is attempted only after the sale commits. Messaging defaults OFF. The only worker mode implemented is MOCK; missing provider is recorded as `SKIPPED / PROVIDER_NOT_CONFIGURED`. No provider secret is present in frontend or tracked source. Do not claim production delivery or deploy to hosted Supabase from this workspace: live target identity, migration ledger, and backup/recovery remain unverified per the release blockers below.

At phase start, the repository search found no communication/outbox/history implementation. Existing `sell_vehicle`, settings RPC, customer history and private phone normalization were reused. Local checks: typecheck, lint, 176 unit tests, 26 migration replay / 77 DB integration tests, 34/34 E2E tests, build, PWA check, and local Edge TypeScript check. These are not hosted/production checks. There is no hosted scheduler; a transient job stays queued with a backoff timestamp until another trusted worker invocation. Real provider activation and hosted migration/function deployment remain blocked by release-readiness requirements below.

## UI feedback + system announcement handoff — 2026-10-01

This turn adds a client feedback layer and a persistent store-wide announcement feature without touching core business workflows (sales, acquisitions, inventory, payments, profit, auth, roles, existing RPC safety). No toast/dialog library was installed: toasts (`src/lib/toast.ts`, rendered by `src/components/ui/Toaster.tsx`) and a single reusable confirm dialog (`src/components/ui/ConfirmDialog.tsx` exposing `confirmAction()`) are hand-built and mounted in `src/App.tsx`. The only native `window.confirm` in the codebase (the `useFormDraft` unsaved-draft navigation guard) now uses `confirmAction()` and re-fires the link click after confirmation; the `beforeunload` handler is untouched. The PWA install `prompt.prompt()` in Settings is a browser API, not a native dialog, and was left as-is.

Backend: migration `20261001002700_system_announcements.sql` creates `public.system_announcements` (with `announcement_type`, `announcement_display`, `announcement_audience` enums), five SECURITY DEFINER RPCs, `private.audit` on every mutation, RLS enabled, and direct table/function access revoked from `public`/`anon`/`authenticated` (only `authenticated` gets EXECUTE). OWNER-only writes are enforced server-side, not just by hiding buttons. `list_active_announcements` filters by `is_active`, the Asia/Ho_Chi_Minh time window, and audience role, ordered by priority. The app-shell `AnnouncementBar` polls active announcements, shows one primary banner (static or CSS-scrolling ticker that pauses on hover and freezes under `prefers-reduced-motion`), supports "Xem thêm" overflow, and per-device dismissal via `localStorage` keyed by id+`updated_at`. The OWNER manager lives under Cài đặt → Thông báo hệ thống.

Local checks: `npm run typecheck` passes; `tests/unit/feedback-notifications.test.ts` (3 tests) passes; the standalone operational DB suite reports 33 passing checks including 5 new announcement tests. Migration `20261001002700_system_announcements.sql` is APPLIED on production per the 2026-10-03 verified ledger (001–037 all applied).

## Release state

The local implementation phase is complete according to `docs/IMPLEMENTATION_REPORT.md` and `docs/VERIFICATION.md`. The local gates recorded there are green; the production build was rerun during this release audit and completed successfully. These results do not verify physical devices, printers, or production performance.

Production state verified read-only 2026-10-03 (single writer, no mutations this turn): project `atsgqtarxhmxrsugulva` (xemaycarem); migration ledger 001–037 applied on both sides and `db push --dry-run` reports up to date (035 no-forced-first-password, 036 shared-schedule/single-owner, and 037 vehicle-hard-delete are APPLIED, having gone through backup → dry-run → push → verify with dump `carem-prod-2026-10-03-083109-*`); hosted `knowledge_base` contains 175 rows matching the current corpus; Edge Functions ACTIVE: `manage-users` v10, `process-message` v1, `ai-assist` v3 (`reset-owner` correctly not deployed); hosted Auth config matches `config.toml` via `config diff`; Vercel production `xemaycarem.vercel.app` passes the live smoke script. Plan is FREE — no PITR or scheduled backups; manual pre-write dumps are the recovery procedure. Pending locally only: `20261002003800_knowledge_reseed.sql` (do not deploy — content already live). Deployed `manage-users` parity with the post-refactor committed source is UNVERIFIED and is the top hosted-testing item.

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

- The cached Supabase link reference was verified against the live account on 2026-10-02/03: CLI-authenticated `projects list` confirms `atsgqtarxhmxrsugulva` (xemaycarem) is the linked production target; live identity is VERIFIED, not just cached.
- Supabase CLI runs and is authenticated. The linked production migration history is queryable and was read: versions 001–037 applied.
- The worktree now carries migrations `20260930000100` through `20261002003800`; 001–037 are applied on production, `038_knowledge_reseed` is local/pending. Version `20260930001800` is applied on the ledger as the neutralized no-op placeholder; the credential-bearing original stays in `supabase/quarantine/` (Git-ignored) and must never be applied.
- Production backup/PITR: FREE plan — none. The enforced procedure is a fresh manual logical dump with manifest before any write; three dated sets exist under `backups/` (see KNOWN_ISSUES "Production release blockers").
- Production apply operations are no longer categorically blocked; each future write still requires target re-verification, ledger reconciliation, reviewed forward SQL, a same-day dump, and explicit authorization.

## Functions and optional integrations

- `manage-users`: DEPLOYED ACTIVE v10 (2026-10-02). Requires Supabase runtime configuration, a server-side administrative key, and allowed-origin configuration. Parity of the deployed build with the post-refactor committed source (`4cc3ff9`) is UNVERIFIED — hosted testing pending; do not claim its behavior healthy yet.
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

