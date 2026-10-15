# Deferred — migrations held back for a separate coordinated release

Files here live OUTSIDE `supabase/migrations/`, so the Supabase CLI does **not**
apply them on `db push`. They remain tracked in Git (unlike `supabase/quarantine/`,
which is for files that must *never* run). Move a file back into
`supabase/migrations/` when its coordinated release window is ready.

## 20261014000500_retire_thankyou_messaging.sql + 20261014001000_retire_messaging_followup.sql

Retirement of the thank-you & customer-messaging (CSKH) feature. This is a
**destructive, paired release** and was deferred (Owner decision, 2026-10-15)
from the inventory-thumbnail production push because it is out of that scope.

`retire_thankyou_messaging` DROPs 4 tables (`message_outbox`,
`customer_communications`, `customer_contacts`, `message_templates`), ~28 RPC
functions, and 5 settings columns. `retire_messaging_followup` is its mandatory
forward-only follow-up (redefines `record_sale` etc. that referenced the dropped
tables) and must ship in the same window.

Its own header requires ALL of the following before `db push`:
1. Explicit OWNER approval for the DROPs.
2. A same-day logical + Storage backup (`carem-prod-<timestamp>-*`).
3. A plan to remove the `process-message` Edge Function from hosting in the same
   release window (delete `supabase/functions/process-message` and unblock
   `[functions.process-message]` in `supabase/config.toml`).
4. Removal of the paired backend tests
   (`tests/db/message-delivery-trust.test.mjs`, `tests/db/message-leases.test.mjs`,
   `tests/unit/communication-provider.test.ts`, `tests/unit/messageWorkerRecovery.test.ts`,
   and the message/contact blocks in `tests/db/smart-sales-automation.test.mjs`,
   `tests/db/operational-features.test.mjs`).

Note: `retire_thankyou_messaging` also reused version `20261014000500`, which
collides with the already-applied `identity_document_image_purge`. When it is
promoted for release, re-stamp it to a fresh, unused, in-order version first.
