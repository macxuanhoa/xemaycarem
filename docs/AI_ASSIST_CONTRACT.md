# Xe CRM AI extraction and read assistant — prepared interface

Status on 2026-09-30: implemented locally and verified with mocked provider/Edge tests. No provider key has been configured, no external images/text have been sent, and no Edge deployment or hosted business mutation has been performed by this work.

## Request and response

Invoke the `ai-assist` Supabase Edge Function with the existing authenticated user session. The frontend must display a clear processing action and send `consent: true` only after the user invokes it. The function rejects unauthenticated, disabled, outside-schedule, deleted and temporary-password users before provider processing.

```ts
type Request = {
  task: 'receipt' | 'vehicle_document' | 'license_plate' | 'odometer' | 'voice' | 'business_question';
  consent: true;
  vehicle_id?: string; // existing UUID context takes priority over model-selected context
  image?: { mime_type: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };
  text?: string; // a voice transcript or business question, maximum 2,000 characters
};
```

Image tasks accept one cropped/compressed image, maximum 2 MiB decoded. Text tasks require text and reject images. The server bounds streamed request bodies to 3 MB, checks image signatures, validates the exact request fields, and never persists the image or logs raw documents, transcripts or provider output.

Extraction returns:

```json
{
  "kind": "draft",
  "task": "receipt",
  "vehicle_id": "existing-vehicle-uuid-or-null",
  "draft": { "amount": 850000, "date": null, "merchant": null, "description": null, "expense_type": null },
  "human_confirmation_required": true,
  "warnings": ["Kiểm tra lại từng trường trước khi lưu. Số khung và các số tiền cần được xác nhận."]
}
```

Every field is nullable when uncertain. Document fields are frame number, engine number, plate, brand, model, color and year. Odometer/plate tasks return only their respective field. Voice returns a limited intent (`CREATE_ACQUISITION`, `ADD_VEHICLE_EXPENSE`, `PREPARE_SALE`, `UNKNOWN`) and explicit draft fields. It never executes a command. Browser speech recognition can supply the `text` field; typed text remains the fallback. Server transcription is not implemented.

The frontend must apply a draft only to an editable form, retain existing vehicle context, show extracted values for review, warn on reduced odometer readings, and call the normal secure business RPC only after human confirmation. A draft is not a completed acquisition, expense, payment or sale. No write/action-agent endpoint exists.

## Read assistant and permissions

Business questions are converted into a validated read plan. The server executes a fixed read allowlist with the current user's JWT, then returns actual RPC data as `facts`. Model-generated numbers or prose answers are not used. Database results are not sent to the external provider.

Supported plans: inventory counts, monthly acquisition counts, monthly sale counts, monthly revenue, monthly gross profit, inventory aging, vehicle search, vehicle expenses and vehicle history. These currently map to `dashboard`, `list_vehicles` and `get_vehicle`; pagination limits search to 25 results. Unsupported questions return `available:false`. Failed retrieval returns `503 DATA_UNAVAILABLE`.

`OWNER` can request all supported plans. Revenue and expense queries require `OWNER`/`MANAGER`. Profit requires `OWNER` or a `MANAGER` with `can_view_financials`. Staff can search/view operational summaries, but cannot use the assistant to bypass restricted costs/profit. Expense extraction/drafts require management rights. Vehicle-document and lifecycle voice drafts require operating rights. Every database RPC still enforces the server's existing authorization.

## Provider and operational configuration

The initial adapter uses OpenAI Responses with strict JSON schema, `store:false`, a 30-second timeout and an output token cap. The configured model must support image inputs and structured outputs. No model is chosen implicitly. Change the isolated `providerDraft` adapter to use a different provider without changing business RPCs or draft contracts.

Server-only environment settings:

- `AI_ENABLED=true`: explicit enablement; otherwise normal forms remain the available path.
- `AI_PROVIDER_API_KEY`: external provider credential; never use a `VITE_` variable.
- `AI_MODEL`: explicit compatible model identifier selected for this deployment.
- Existing `SUPABASE_URL` and `SUPABASE_ANON_KEY` / publishable key: the function uses user JWTs and never reads a service-role credential.

Missing configuration returns `503 AI_NOT_CONFIGURED`. The UI should explain availability and retain manual entry. Do not automatically call the function on screen renders, normal search, validation or saving a simple form.

Usage logs contain only user UUID, task, model, token counts and duration. An initial per-isolate limit allows 10 requests per user per 10 minutes; this is not a distributed billing limit. Before production enablement, configure provider/project spending controls and, if needed, a shared rate limiter. Provider errors/refusals/incomplete or invalid outputs never become drafts or business writes.

`store:false` disables Responses application state storage; it does not independently establish Zero Data Retention or override provider abuse-monitoring obligations. Confirm the deployment's provider/data-retention policy before enabling sensitive document processing. Supabase infrastructure can also have its own access/error logs, separate from application code.

## Sensitive capture separation

Vehicle-photo storage remains a private bucket with registered-image authorization and signed URLs. Registered ordinary vehicle photos are readable by active application users. Do not place identity documents or receipts into that bucket. Capture those in browser memory for explicit transient extraction; a future durable document workflow needs a separate restricted bucket and authorization policy.

## Verification boundary

Local tests cover actual Edge handler authentication, missing configuration, draft confirmation, restricted profit queries, grounded reads, request/image/output validation and absence of business writes. SQL tests separately verify temporary-password gating, real password-change proof, restricted acquisition costs and owner-only performance summaries.

`node scripts/check-edge-types.mjs` checks the Edge sources against installed Supabase TypeScript types and a minimal Deno runtime declaration when Deno is absent. It does not verify Deno's remote module resolution. Password resets first gate existing sessions, preserve a pending-reset state while Auth credentials change, and record the new temporary-password fingerprint before allowing self-service completion. Self-admin resets use the native change/recovery path; unrelated profile edits do not reset password-change proof.

Hosted GoTrue password updates, actual provider OCR accuracy, deployed Edge policies, real phone cameras/voice permissions and provider spending controls remain live integration checks. Test frame-number recognition against real representative documents before considering document extraction production ready.

References: [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
