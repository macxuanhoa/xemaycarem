# Architecture Decisions — Xe CRM

## Existing foundation retained

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

## Temporary-password proof

The profile flag is a user-flow signal, not proof. A private table stores a salted Auth hash fingerprint for comparison and a pending-reset flag. Server-side completion succeeds only after Supabase Auth changes the hash. Raw password/hash is never returned to the browser. Hosted migration status must be checked before applying this forward migration.

## Privacy and drafts

Local draft/recent values are scoped to the authenticated user and exclude financial amounts and secrets. Images sent for extraction are transient in the browser request; vehicle photo storage remains a separate existing workflow. The provider is disabled until explicit server configuration and policy review.

## Unverified external state

These decisions describe local code. They do not assert the current contents of a hosted Supabase project or any production account credential.

