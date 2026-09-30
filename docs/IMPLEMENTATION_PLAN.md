# Implementation Plan — Xe CRM operational increment

Last reviewed: 2026-09-30

## Status

Local implementation and automated verification are complete. Production deployment, real-device acceptance, and external AI provider setup are pending.

## Phases delivered

1. Fixed server RPCs for receivables, customer summaries/history, global search, dashboard alerts, imports, payment retries and daily reconciliation.
2. Connected operational pages and role-aware routes to existing RPCs; preserved normal vehicle acquisition, sale and payment flows.
3. Added actual QR labels/scanning fallback, CSV preview/atomic import, safe customer receipts and mobile/contextual conveniences.
4. Added opt-in assistant UI/Edge contract for transient extraction and grounded authorized reads. No external provider configuration or writes.
5. Added forward-only security migration, database/UI/Edge tests and handoff documentation.

## Verification

See docs/VERIFICATION.md for the exact commands/results. Automated data tests use disposable PostgreSQL and fictional records. No production Supabase action took place.

## Pending before production use

- Compare migration ledger and schema with target project; plan only new forward migrations 024/025.
- Retire a hosted legacy reset endpoint if one exists.
- Validate hosted Auth, Edge, Storage and RLS in staging.
- Complete device/printer smoke tests listed in docs/IMPLEMENTATION_REPORT.md.
- Treat AI as unavailable until provider credentials, model, retention policy, spending caps and privacy approval are in place.

