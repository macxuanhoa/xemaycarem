# Release handoff — Xe CRM

Last reviewed: 2026-09-30 (Asia/Saigon)

## Release state

The local implementation phase is complete according to `docs/IMPLEMENTATION_REPORT.md` and `docs/VERIFICATION.md`. The local gates recorded there are green; the production build was rerun during this release audit and completed successfully. These results do not verify hosted Supabase, production Auth, Edge Functions, physical devices, printers, or production performance.

No production database, Auth configuration, Edge Function, backup, or business record has been changed or verified during this release-readiness turn.

## Repository checkpoint

- Starting branch: `main`, tracking `origin/main`; history contained only `b5b21df` (`Initial commit: Quản lý Cửa Hàng Xe Máy Cà Rém`).
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
- The worktree has 25 migration files, versions `20260930000100` through `20260930002500`. The safe checkpoint intentionally omits version `20260930001800`; the checkpoint therefore must not be used for `db push` or represented as a reconciled deploy set.
- Production status for every version is `UNVERIFIED`. The disposable PostgreSQL suite replay is local testing, not production-ledger evidence.
- Production backup/PITR availability, a restore point, and a recovery path have not been verified. The general plan in `docs/OPERATIONS.md` is guidance, not proof of a production backup.
- All production database apply operations are blocked until target identity, complete remote ledger reconciliation, migration review, and backup/recovery evidence are available.

## Functions and optional integrations

- `manage-users`: local account-management function; requires Supabase runtime configuration, a server-side administrative key, and allowed-origin configuration. Not confirmed deployed or production-tested.
- `ai-assist`: optional local authenticated/read-only assistant; requires `AI_ENABLED`, `AI_PROVIDER_API_KEY`, and `AI_MODEL` server-side. Provider configuration is absent; AI remains disabled and is not a CRM release dependency.
- `reset-owner`: retired local endpoint returns HTTP 410. Do not deploy it.

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

