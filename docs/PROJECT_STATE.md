# Project State — Xe CRM

Last reviewed: 2026-09-30

## Current result

The existing React/TypeScript/Vite PWA continues to use Supabase Auth, PostgreSQL RPC/RLS, Storage, and React Query. The current local implementation adds operational workflows and security changes on that architecture.

Operational additions include receivables collection, selected-day reconciliation, customer history, global search, CSV vehicle import, QR scan/search, safe customer receipts, mobile form conveniences, and an opt-in AI draft/read interface. Local automated verification is recorded in `docs/VERIFICATION.md`.

## Release readiness

Release readiness is **BLOCKED before production changes**. The worktree has a recoverable local checkpoint branch, but a historical migration containing a hardcoded default owner password is intentionally omitted from the checkpoint. The Supabase CLI is unavailable, so production project identity and migration history could not be queried. Production backup/recovery capability is also unverified. No production changes were made.

All 25 local migration files were reviewed for high-risk patterns. The disposable PostgreSQL test replays all 25, but this says nothing about production's applied ledger. Historical Auth/password migrations require exact reconciliation and review; version 018 must never be applied. Read `docs/PRODUCTION_RELEASE.md` and `docs/AGENT_HANDOFF.md` before any hosted operation.

## Verification boundary

Local unit, PostgreSQL, browser, PWA, type, lint, seed, and build checks are not hosted-production checks. Browser tests use mocked Supabase/Auth boundaries and fictional rows. Provider OCR, hosted Supabase, production Auth, production functions, live performance, physical devices, and printers remain unverified.

## Source of truth

The target project's migration ledger is not available from this workspace yet. Do not run `db push` until the target is authoritatively verified, every local/remote migration is reconciled, the pending SQL is reviewed against live state, and a production recovery option is confirmed. AI remains optional and disabled without server-side provider configuration.
