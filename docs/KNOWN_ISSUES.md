# Known Issues and Verification Limits

Last reviewed: 2026-09-30

## Production release blockers

- Supabase CLI and authenticated production access were unavailable during release readiness. Live project identity, migration ledger, schema, Auth, RLS, Storage, and Edge deployment status remain unverified.
- Production backup/PITR availability, current restore point, and recovery path have not been verified. Do not apply schema changes until verified.
- `supabase/migrations/20260930001800_reset_owner_password_default.sql` contains a hardcoded default owner password and emits it in migration notices. It is excluded from the local release checkpoint and must not be deployed. If it was ever applied or its value used, rotate the affected credential through the approved account process.
- The checkpoint omits version 018 intentionally, so it is not a deployable/reconciled migration set. Resolve the unsafe historical migration with a deliberate, audited repository decision after checking the remote ledger; do not silently recreate or replay it.

## External integrations not verified

- No migration or Edge Function was deployed during this release turn. Hosted Auth session behavior, RLS, Storage, endpoint configuration, and production smoke tests remain unverified.
- `manage-users` has only local verification. Its actual Deno runtime/module resolution, production CORS, authenticated OWNER flow, and STAFF denial need hosted testing.
- `ai-assist` has no server-side provider key/model configured. AI remains disabled; provider behavior, retention, spending controls, and actual calls have not been tested.
- Camera, microphone, image compression readability, PWA installation, and receipt appearance need acceptance on physical devices/printers/browsers.

## Bundle measurements

A fresh local production build shows a 736.97 kB initial JavaScript entry (220.67 kB gzip), above Vite's warning threshold. It does not contain `html5-qrcode`. The Capture route is dynamically loaded and the camera library is separately loaded only after the user invokes camera scanning (375.14 kB raw, 110.56 kB gzip). No production performance measurement is available; investigate the initial entry if real metrics show a problem.

## Existing product/data limits

- Purchase disbursements and expense settlements are not recorded separately, so reconciliation excludes those flows.
- Direct XLSX import is not implemented; export the spreadsheet as CSV UTF-8.
- Native browser Back cannot display the same route-blocking prompt as an internal link. Nonfinancial draft data may be recovered; monetary values are deliberately not stored.
- Image uploads retry while the current page session remains open; there is no durable offline upload queue.
- Customer identity is grouped by phone. A phone shared by multiple people is warned about but still needs a human to choose the right sale before collection.
- Normal acquire_vehicle/save_vehicle frame-number uniqueness follows existing server behavior; import additionally checks chassis/engine case-insensitively and plates without punctuation while preserving submitted display text.

## Deployment note

The migration directory contains historic Auth/account-recovery operations and the unsafe version 018 described above. Compare the exact target migration history first and apply only reviewed forward changes. The local `reset-owner` function is retired and returns HTTP 410; do not deploy it.
