# Architecture Decisions — Xe CRM

## Existing foundation retained

## Customer communication Phase 1

- Thank-you event creation is part of `sell_vehicle`'s database transaction; external delivery is always outside the sale transaction.
- The outbox unique key is `(event_type, sale_id, channel)`. Jobs and customer history default to `SKIPPED` unless messaging, thank-you automation, a channel, and a valid Vietnamese phone are present.
- The worker supports explicit mock mode only. `SENT` from mock is workflow evidence, never production delivery evidence. Production provider credentials and behavior are not configured.
- Direct table access is revoked for the outbox/history; role-checked RPCs expose operational data. Customer history stores short previews and operational metadata only.

Xe CRM remains a React and TypeScript single-page application backed by Supabase Auth and PostgreSQL. Business writes continue through security-checked SQL RPCs. RLS remains the table boundary. TanStack Query owns client data freshness. Vietnam local business dates use Asia/Ho_Chi_Minh.

## Operational features

- Receivables are calculated from completed sales and active payment rows; no second debt ledger is introduced.
- A payment retry reuses a client-generated request UUID as the payment UUID. The server compares caller and complete payload before returning the original payment. Different payload with the same key is rejected.
- Reconciliation reports sales revenue by sale date and cash collected by payment date. Net cash movement means collected customer payments minus expenses recorded for that date. Purchase disbursements and expense settlements are unavailable in the existing model and are excluded.
- Customer history groups by normalized phone only. Shared phones carry an identity warning; names without a phone are not merged.
- Import first previews the full file, then asks for explicit confirmation. Only validated rows are submitted; invalid rows remain visible and are not silently represented as imported. Database insertion reuses the acquisition transaction and rolls back a failed batch.
- Printed customer documents use an explicit field allowlist. They exclude cost, profit and internal notes.
- QR stores a UUID and same-origin application route, never arbitrary external navigation.
- AI produces editable drafts or returns actual data from an authorized read-only RPC allowlist. No AI endpoint performs a business mutation.

## AI copilot mode

- The copilot answers strictly under the caller's JWT and RLS. Retrieval calls the existing read RPCs plus `search_knowledge`; `ai-assist` holds no service-role credential, so a STAFF answer physically cannot contain figures STAFF cannot open. Rejected: an unrestricted "see everything" assistant, which would defeat the RLS model the whole app is built on.
- Deterministic, permission-scoped retrieval is both the default and the fallback. The LLM (`mode: 'llm'`) may only re-word evidence already fetched in the same request, never invent a number, and is OWNER-only (`LLM_MODE_OWNER_ONLY`). `copilotSchema` + `validateGroundedAnswer` reject unknown citation ids, ungrounded prose, over-length answers and non-internal links with `INVALID_AI_RESULT`, and the handler degrades to the deterministic answer with a Vietnamese warning instead of failing the question. Rationale: the existing contract already forbids model-authored numbers, and a provider outage or a missing key must not take the feature away.
- Every fact and document excerpt carries a citation id that deep-links into the screen showing it, and the renderer only accepts internal routes. Evidence is a navigation control, not a footnote, because an unverifiable assistant answer would be a worse audit trail than no answer at all.
- Documentation lives in `public.knowledge_base`, generated from tracked markdown by `scripts/build-knowledge-seed.mjs` (one row per `##` section, audience tier per source file) instead of a hand-maintained content table or runtime filesystem reads. The repository stays the single source of truth and a fresh database, including PGLite tests, reproduces the corpus. Rejected: a second copy of the docs authored inside the app, which drifts immediately.
- The copilot is read-only by design: no draft payload, no write RPC, no action endpoint. "Full tool access" was rejected because MCP is an IDE/agent-loop concept that has no host in a Deno Edge Function or an offline PWA, and writes must stay human-approved in the existing secure forms.
- Copilot traffic gets a 30-request budget in the same rolling 10-minute per-user window other AI tasks share at 10, because one grounded question fans out into several read RPCs.

## UI feedback and system announcements

- Feedback layer is hand-built with zero new dependencies (no toast/dialog library added), reusing the project's bespoke CSS-class UI. Toasts use a small `useSyncExternalStore` store (`src/lib/toast.ts`) with SUCCESS/INFO/WARNING/ERROR variants, Vietnamese titles, and 3s/4s/5s/9s default durations (error/warning stay closable).
- Destructive confirmations use one reusable `confirmAction()` promise API backed by a single dialog host (`src/components/ui/ConfirmDialog.tsx`), replacing the last native `window.confirm`. The unsaved-draft navigation guard re-fires the link click after confirmation so native browser navigation is preserved.
- System announcements live in a dedicated `public.system_announcements` table rather than the settings blob, so scheduling, priority, audience, and dismissal have first-class columns. It is a small persistent banner, deliberately kept separate from transient toasts and per-sale business notifications.
- Announcement writes go only through OWNER-checked SECURITY DEFINER RPCs (`save_announcement`, `set_announcement_active`, `delete_announcement`, `list_announcements`); direct table access is revoked and RLS is enabled. Reads for the bar use `list_active_announcements`, which filters by `is_active`, the Asia/Ho_Chi_Minh time window, and audience role, and orders by type priority (CRITICAL>WARNING>INFO>SUCCESS). Every change reuses `private.audit` (ANNOUNCEMENT_CREATE/UPDATE/ACTIVATE/DEACTIVATE/DELETE).
- Dismissal is per-device via `localStorage` keyed by announcement id and `updated_at`, so a substantial edit re-surfaces the announcement; non-dismissible announcements always show. The scrolling ticker is CSS keyframes (not `<marquee>`), pauses on hover, and freezes under `prefers-reduced-motion`.

## Temporary-password proof

The profile flag is a user-flow signal, not proof. A private table stores a salted Auth hash fingerprint for comparison and a pending-reset flag. Server-side completion succeeds only after Supabase Auth changes the hash. Raw password/hash is never returned to the browser. Hosted migration status must be checked before applying this forward migration.

## Privacy and drafts

Local draft/recent values are scoped to the authenticated user and exclude financial amounts and secrets. Images sent for extraction are transient in the browser request; vehicle photo storage remains a separate existing workflow. The provider is disabled until explicit server configuration and policy review.

## Unverified external state

These decisions describe local code. They do not assert the current contents of a hosted Supabase project or any production account credential.

