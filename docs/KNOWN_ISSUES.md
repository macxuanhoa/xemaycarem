# Known Issues and Verification Limits

## Behavioral defect audit A1–A7 — 2026-10-02

All seven confirmed behavioral defects are FIXED locally with regression coverage; none is DEFERRED or BLOCKED.

- A1 Showroom (`/showroom`) now reads real stock through `list_showroom_vehicles` (migration `20261002003200`), an anon-granted, safe projection of IN_STOCK vehicles only. RESERVED/SOLD/CANCELLED are explicitly excluded from the public showroom (documented policy in the migration header). `FEATURED_BIKES` and every fake vehicle/price/plate/odometer constant is deleted; loading and error states replace fake fallbacks; missing fields render "—" or are omitted. Private buckets are not leaked: cards use styled placeholders, not photos.
- A2 The sell/inquiry form persists a real `showroom_leads` row through `create_showroom_lead` (migration `20261002003300`) BEFORE any success message; success is gated on the mutation's `onSuccess`. Zalo opening is a secondary try/catch and cannot lose the lead. Anon writes only (validated + phone-normalized + 10-minute per-phone throttle); staff triage lives on the Customers page via `list_showroom_leads`/`update_showroom_lead_status` (audited as `UPDATE_SHOWROOM_LEAD_STATUS`).
- A3 One canonical resolver `src/lib/debt.ts` (`resolveDebtStatus`/`resolveIsOverdue`) is consumed by both desktop and mobile receivables; it prefers the server `debt_status`/`is_overdue` and falls back to the same rules the server uses. The historic mobile missing-UNPAID branch is gone.
- A4 An empty due-date input can no longer silently delete an existing due date: submit blocks with an inline message; removal is a separate "Xóa hạn thanh toán" action with a danger confirmation (form is `noValidate` so the custom message always wins over native tooltips).
- A5/A6 Persisted `VehicleStatus` and query-only `VehicleStatusFilter` (AVAILABLE/UNSOLD aliases) are separate types; canonical constants live in `src/lib/vehicleFilters.ts` and `AVAILABLE_VEHICLE_FILTER` is the only alias allowed in list queries — aliases never reach status mutations.
- A7 `ReceivablesPage.setPaymentStatus` uses a functional `setSearchParams` updater plus `mergeSearchParams` (`src/lib/urlParams.ts`), preserving search/page/date/other params.

Residual notes: migrations `0032`/`0033`/`0034` are pending like every unreleased version — nothing was deployed; `create_showroom_lead` intentionally writes no `audit_logs` row because `private.audit` records `auth.uid()` (NULL for anon) and the lead row itself is the evidence trail. The corpus changes from these doc edits were propagated by re-running the generator over the still-pending `20261001002900_knowledge_seed.sql` in place (production's applied ledger stops at `20260930002500`), so `npm run knowledge:check` is green; if 029 ever turns out applied on a target before this batch ships, switch to a forward re-seed migration and never edit applied files.

Last reviewed: 2026-10-02

## Customer communication Phase 1

- Real Zalo ZNS/SMS providers are not implemented or configured. `MESSAGE_PROVIDER_MODE=MOCK` simulates acceptance; absent configuration fails safely. Keep customer messaging disabled until provider approval, Edge secrets, template/eligibility review, callback handling, and hosted verification are complete.
- The preferred and fallback channels are stored in settings for configuration continuity; fallback sending is not implemented until real providers are approved and integrated.
- No hosted scheduler/queue trigger is installed. The app invokes the worker after sale commit; a transient retry remains durably queued with a backoff timestamp, but needs a later trusted worker invocation (or an owner retry after permanent failure). Production activation must include and verify that trigger.
- If the database cannot record the outbox row, `sell_vehicle` intentionally still commits the completed sale; in that exceptional storage failure, no thank-you event/history row exists. Monitor database errors and reconcile manually if this occurs.
- Hosted migration `20261001002600` and Edge Function `process-message` are not deployed or production-tested. Existing production access/reconciliation blockers below remain in force.

Last reviewed: 2026-09-30

## Production release blockers

- (RESOLVED 2026-10-01, release-prep pass 3) The full E2E suite now passes 43/43, re-confirmed on TWO consecutive full runs after the final code change. The former failures split into stale assertions (assistant `Số khung *` exact label after the duplicate-check hint joins the accessible name; the old `Khoảng thời gian` select becoming date chips + DD/MM/YYYY DatePickers in report/dashboard tests; settings "Tên cửa hàng" moving behind the owner "Thông tin cửa hàng" tab; no `role=status` swap during route loading because React Router keeps the previous route mounted) and two real app defects that were fixed: `ReceivablesPage` rendered duplicated status controls (chips + select) and `DateRange.handleDateChange` let an erased date boundary leave a stale draft value that could then be submitted. The login/sequential timing flake is now genuinely root-caused, not masked: `scripts/db-harness.mjs` opened a fresh embedded-Postgres connection for every intercepted `/rest/v1/*` request, so the app-boot RPC burst caused connection churn whose latency spikes pushed a login past the `expect` timeout; it now reuses a bounded `pg.Pool` with a single bootstrap client, and the RPC-signature lookup (`pg_get_function_arguments`) runs on the dedicated per-request connection instead of the shared bootstrap client (removing a concurrent-query race). No timeout was raised and no `page.waitForTimeout` was added; `npm run test:db` (which includes multi-session concurrency and lock-blocking checks) stays green on the pooled harness. Remaining watch item: the `receipt capture`/draft assistant tests still guard the auth-bootstrap remount (`/assist` can remount once while the session resolves and wipes local form state) with an in-test re-entry helper (`submitDraft`, max two attempts) that asserts on the settled UI; the remount trigger in that static-mock path is not separately root-caused.
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
