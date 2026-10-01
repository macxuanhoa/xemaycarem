# Project State — Xe CRM

Last reviewed: 2026-10-01

## Current result

Phase 1 customer communications is complete locally: completed sales enqueue an idempotent thank-you outbox item in the normal transaction; an outbox-write exception is isolated so it cannot fail the sale. Messaging settings default OFF, and CRM sale/customer views expose communication state/history. The `MessagingProvider` boundary supports MOCK only; an unconfigured mode safely skips. Local gates are recorded in `docs/VERIFICATION.md`. No hosted scheduler is installed, no provider secrets are in the frontend/tracked source, and this migration/function has not been deployed. Real delivery remains unverified.

The existing React/TypeScript/Vite PWA continues to use Supabase Auth, PostgreSQL RPC/RLS, Storage, and React Query. The current local implementation adds operational workflows and security changes on that architecture.

Operational additions include receivables collection, selected-day reconciliation, customer history, global search, CSV vehicle import, QR scan/search, safe customer receipts, mobile form conveniences, and an opt-in AI draft/read interface. Local automated verification is recorded in `docs/VERIFICATION.md`.

## AI copilot mode — 2026-10-01

A grounded shop assistant is complete locally. The sidebar section **TRỢ LÝ AI** (visible when `canOperate`) exposes `/copilot` (ask anything about the shop) and `/docs` (in-app documentation viewer). Migrations `20261001002800_knowledge_base.sql` and the generated `20261001002900_knowledge_seed.sql` add `public.knowledge_base` with tiered RLS (`private.knowledge_visible`) plus `search_knowledge`/`list_knowledge`/`get_knowledge_article`; `scripts/build-knowledge-seed.mjs` (`npm run knowledge:seed`) regenerates the seed from tracked markdown, and the seed file is never edited by hand. `ai-assist` gained `task: 'copilot'`: `copilot.ts` builds permission-scoped evidence from the existing read RPCs and document search under the caller JWT, and every fact or excerpt carries a citation id that deep-links to the screen showing it (`src/features/copilot/CitationLinks.tsx`, rendered through the allowlist-only `src/lib/markdownLite.tsx`). Deterministic retrieval is the default and works with no provider configuration; OWNER-only `mode: 'llm'` adds a RAG summary that must cite the retrieved evidence (`copilotSchema`/`validateGroundedAnswer`) and otherwise falls back with a warning. No write path exists. Local gates: `node scripts/check-edge-types.mjs` (six edge files), lint, typecheck, 252 vitest tests, and the PGLite database suite including the knowledge checks. The Playwright specs in `tests/e2e/copilot.spec.mjs` and any hosted deployment have not been run.

## UI feedback and system announcements — 2026-10-01

A feedback and announcement polish layer is complete locally. Toasts (`src/lib/toast.ts` + `Toaster.tsx`) and a reusable confirm dialog (`src/components/ui/ConfirmDialog.tsx` exposing `confirmAction()`) are mounted app-wide with no new dependency; the last native `window.confirm` (unsaved-draft navigation guard) now uses `confirmAction()`. A persistent store-wide system announcement feature is added via migration `20261001002700_system_announcements.sql`: a dedicated `public.system_announcements` table, OWNER-only SECURITY DEFINER RPCs with RLS and `private.audit`, an app-shell `AnnouncementBar` (static/CSS-scrolling ticker, priority ordering, per-device dismissal, scheduling), and an OWNER manager under Cài đặt → Thông báo hệ thống. Local checks: typecheck passes, `tests/unit/feedback-notifications.test.ts` (3) passes, and the standalone operational DB suite reports 33 passing checks including 5 new announcement tests. This is not a hosted/production check; the migration has not been deployed.

## Release readiness

Release readiness is **BLOCKED before production changes**. The worktree has a recoverable local checkpoint branch, but a historical migration containing a hardcoded default owner password is intentionally omitted from the checkpoint. The Supabase CLI is unavailable, so production project identity and migration history could not be queried. Production backup/recovery capability is also unverified. No production changes were made.

There are 29 local migration files (versions `20260930000100` through `20261001003000`). Versions up to `20261001002700` were reviewed for high-risk patterns; `20261001002800_knowledge_base.sql` and `20261001002900_knowledge_seed.sql` were added and reviewed in the copilot pass (RLS + definer read RPCs + seed-only UPSERT/DELETE, no business rows), while the pre-existing `20261001003000_identity_documents.sql` PII migration belongs to separate work. The disposable PostgreSQL test replays them all, but this says nothing about production's applied ledger. Historical Auth/password migrations require exact reconciliation and review; version 018 must never be applied. Read `docs/PRODUCTION_RELEASE.md` and `docs/AGENT_HANDOFF.md` before any hosted operation.

## Verification boundary

Local unit, PostgreSQL, browser, PWA, type, lint, seed, and build checks are not hosted-production checks. Browser tests use mocked Supabase/Auth boundaries and fictional rows. Provider OCR, hosted Supabase, production Auth, production functions, live performance, physical devices, and printers remain unverified.

## Source of truth

The target project's migration ledger is not available from this workspace yet. Do not run `db push` until the target is authoritatively verified, every local/remote migration is reconciled, the pending SQL is reviewed against live state, and a production recovery option is confirmed. The copilot's deterministic answers need no provider; only the OWNER-only `mode: 'llm'` summary depends on server-side `AI_ENABLED`/`AI_PROVIDER_API_KEY`/`AI_MODEL`, which stay unset locally.
