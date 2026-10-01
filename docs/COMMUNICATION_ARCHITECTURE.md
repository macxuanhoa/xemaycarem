# Customer communication architecture

Phase 1 adds a provider-agnostic post-sale thank-you workflow. AI, marketing automation, bulk outreach, payment and debt automations are out of scope.

## Sale event and outbox

`public.sell_vehicle` remains the authoritative atomic sale operation. After it inserts the completed sale and marks the vehicle SOLD, it writes one `SALE_THANK_YOU` row to `public.message_outbox` in the same database transaction. The unique `(event_type, sale_id, channel)` constraint prevents duplicate events for a sale/channel. No external request runs in PostgreSQL. The caller commits the sale before the UI invokes `process-message` in the background.

The message is queued only when customer messaging, sale thank-you automation, and a primary channel are enabled and the phone normalizes to a valid Vietnamese mobile number. Otherwise an auditable `SKIPPED` row and CRM history item explain the safe skip. Defaults are disabled.

## Provider worker and status

`supabase/functions/process-message` authenticates the caller and claims one eligible queued job through a server-authorized RPC. A canonical `MessagingProvider` interface accepts the recipient, channel, template variables, and idempotency key. It supports only explicit `MESSAGE_PROVIDER_MODE=MOCK`, which records a `mock_...` identifier and `SENT` state as simulated success. The disabled provider fails closed and records a permanent provider-not-configured failure. This function has no production provider implementation and must not be treated as real delivery. `SENT` means accepted by the mock; callbacks can later advance a provider message to `DELIVERED`.

Statuses are `QUEUED`, `PROCESSING`, `SENT`, `DELIVERED`, `FAILED`, `SKIPPED`, and `CANCELLED`. Transient failures use up to three attempts with bounded exponential delay. Invalid phone and missing provider configuration are permanent. OWNER/MANAGER may manually retry eligible failed jobs; retry reuses the same outbox/history row and starts a new bounded attempt window. Provider-not-configured and invalid-phone skips are not retryable.

The sale flow invokes the worker once after commit. No hosted scheduler or durable queue trigger is installed in this phase, so transient retries remain safely queued until a later trusted worker invocation. A production provider rollout must include a verified scheduled/drain trigger.

## Communication history

`public.customer_communications` is durable CRM history, joined to the existing completed sales by normalized Vietnamese phone. It stores only a short message preview, provider identifier, status and lifecycle timestamps. It does not store provider payloads, credentials, or sale financial data. Customer history and sale detail read through role-checked RPCs.

## Settings and security

Messaging controls live on `system_settings` and can only be changed by OWNER through the existing settings RPC boundary. Client settings include enablement, thank-you automation, preferred/fallback channel, store brand and support phone. No credential fields exist in client settings. Outbox/history tables have RLS enabled and direct grants revoked; RPCs enforce active-role checks. Provider credentials, when a real integration is approved, belong only in Supabase Edge Function secrets.

Audit events include `AUTO_MESSAGE_QUEUED`, `MESSAGE_SENT`, `MESSAGE_FAILED`, `MESSAGE_RETRIED`, `MESSAGE_MANUALLY_RETRIED`, and `MESSAGE_SETTING_CHANGED`; they contain operational status only.

## Activating a real provider

Production sending is not configured. Activation requires an approved Zalo ZNS or SMS account, reviewed template and consent/eligibility policy, provider-specific Edge Function implementation, server-side secrets, retry/error mapping, delivery callback verification, and hosted tests. Do not add keys to Vite variables, SQL rows, logs, or source control. Until those steps are complete, keep sending disabled; mock results are workflow verification only.

## Future AI integration

Future AI may draft, personalize, or summarize communication, but it must not control sale transactions or become a delivery dependency. Automation decides when to contact; AI may suggest content; this outbox and provider boundary own delivery and history.
