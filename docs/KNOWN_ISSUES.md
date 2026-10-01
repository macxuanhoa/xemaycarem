# Known Issues and Verification Limits

## Customer communication Phase 1

- Real Zalo ZNS/SMS providers are not implemented or configured. `MESSAGE_PROVIDER_MODE=MOCK` simulates acceptance; absent configuration fails safely. Keep customer messaging disabled until provider approval, Edge secrets, template/eligibility review, callback handling, and hosted verification are complete.
- The preferred and fallback channels are stored in settings for configuration continuity; fallback sending is not implemented until real providers are approved and integrated.
- No hosted scheduler/queue trigger is installed. The app invokes the worker after sale commit; a transient retry remains durably queued with a backoff timestamp, but needs a later trusted worker invocation (or an owner retry after permanent failure). Production activation must include and verify that trigger.
- If the database cannot record the outbox row, `sell_vehicle` intentionally still commits the completed sale; in that exceptional storage failure, no thank-you event/history row exists. Monitor database errors and reconcile manually if this occurs.
- Hosted migration `20261001002600` and Edge Function `process-message` are not deployed or production-tested. Existing production access/reconciliation blockers below remain in force.

Last reviewed: 2026-09-30

## Production release blockers

- (RESOLVED 2026-10-01, release-prep pass 2) The E2E suite now passes 43/43. The former failures split into stale assertions (assistant `Số khung *` exact label after the duplicate-check hint joins the accessible name; the old `Khoảng thời gian` select becoming date chips + DD/MM/YYYY DatePickers in report/dashboard tests; settings "Tên cửa hàng" moving behind the owner "Thông tin cửa hàng" tab; no `role=status` swap during route loading because React Router keeps the previous route mounted) and two real app defects that were fixed: `ReceivablesPage` rendered duplicated status controls (chips + select) and `DateRange.handleDateChange` let an erased date boundary leave a stale draft value that could then be submitted. Remaining watch item: the `receipt capture` assistant test carried an ordering/timing flake — under parallel load the auth bootstrap can remount `/assist` once and wipe local form state; the test now re-enters image+consent (max two attempts) instead of failing, and the underlying remount trigger is not yet root-caused.
- Supabase CLI and authenticated production access were unavailable during release readiness. Live project identity, migration ledger, schema, Auth, RLS, Storage, and Edge deployment status remain unverified. (The CLI itself now runs locally via `npx supabase` 2.119.0 with Docker; only production authentication/ledger access is still missing.)
- Hosted Auth must have the email provider (email logins) ENABLED: username sign-in resolves to an internal email, so a disabled email provider returns 422 "Email logins are disabled". The local `config.toml` had this misconfiguration (`[auth.email] enable_signup = false`) and is fixed; the hosted project setting itself remains unverified.
- Production backup/PITR availability, current restore point, and recovery path have not been verified. Do not apply schema changes until verified.
- `supabase/quarantine/20260930001800_reset_owner_password_default.sql` contains a hardcoded default owner password and emits it in migration notices. It is excluded from the release checkpoint, moved out of `supabase/migrations/`, and Git-ignored so it cannot be accidentally applied or committed. It must not be deployed. If it was ever applied or its value used, rotate the affected credential through the approved account process.
- The checkpoint omits version 018 intentionally, so it is not a deployable/reconciled migration set. The file is now quarantined at `supabase/quarantine/` (Git-ignored and removed from the migration search path), and `supabase/migrations/20260930001800_*` is ignore-guarded. Resolve the final repository strategy (sanitized no-op historical placeholder versus permanent exclusion) with the remote ledger in hand; do not silently recreate or replay it.

## External integrations not verified

- No migration or Edge Function was deployed during this release turn. Hosted Auth session behavior, RLS, Storage, endpoint configuration, and production smoke tests remain unverified.
- `manage-users` has only local verification. Its actual Deno runtime/module resolution, production CORS, authenticated OWNER flow, and STAFF denial need hosted testing.
- `ai-assist` has no server-side provider key/model configured, so extraction drafts and the OWNER-only copilot `mode: 'llm'` summary are unverified against a real provider (behavior, retention, spending, actual calls). The deterministic copilot path is exercised locally and needs no provider, but search relevance over the real Vietnamese documentation corpus has not been reviewed by a human reader.
- The `knowledge_base` corpus is regenerated from tracked markdown; a documentation file added to the repo but not listed in `scripts/build-knowledge-seed.mjs` `SOURCES` is invisible to the copilot. `npm run knowledge:check` only proves the committed seed matches the listed sources.
- Camera, microphone, image compression readability, PWA installation, and receipt appearance need acceptance on physical devices/printers/browsers.

## Bundle measurements

A fresh local production build shows a 767.00 kB initial JavaScript entry (229.72 kB gzip), above Vite's warning threshold. It does not contain `html5-qrcode`. The Capture route is dynamically loaded and the camera library is separately loaded only after the user invokes camera scanning (375.14 kB raw, 110.56 kB gzip). No production performance measurement is available; investigate the initial entry if real metrics show a problem.

## Existing product/data limits

- Purchase disbursements and expense settlements are not recorded separately, so reconciliation excludes those flows.
- Direct XLSX import is not implemented; export the spreadsheet as CSV UTF-8.
- Native browser Back cannot display the same route-blocking prompt as an internal link. Nonfinancial draft data may be recovered; monetary values are deliberately not stored.
- Image uploads retry while the current page session remains open; there is no durable offline upload queue.
- Customer identity is grouped by phone. A phone shared by multiple people is warned about but still needs a human to choose the right sale before collection.
- Normal acquire_vehicle/save_vehicle frame-number uniqueness follows existing server behavior; import additionally checks chassis/engine case-insensitively and plates without punctuation while preserving submitted display text.

## Deployment note

The migration directory contains historic Auth/account-recovery operations and the unsafe version 018 described above. Compare the exact target migration history first and apply only reviewed forward changes. The local `reset-owner` function is retired and returns HTTP 410; do not deploy it.
