# Xe CRM AI extraction and read assistant — prepared interface

Status on 2026-10-01: implemented locally and verified with mocked provider/Edge tests, plus the `knowledge_base` corpus and its PGLite checks. No provider key has been configured, no external images/text have been sent, and no Edge deployment or hosted business mutation has been performed by this work.

## Request and response

Invoke the `ai-assist` Supabase Edge Function with the existing authenticated user session. The frontend must display a clear processing action and send `consent: true` only after the user invokes it. The function rejects unauthenticated, disabled, outside-schedule, deleted and temporary-password users before provider processing.

```ts
type Request = {
  task: 'receipt' | 'vehicle_document' | 'license_plate' | 'odometer' | 'voice' | 'business_question' | 'copilot';
  consent: true;
  vehicle_id?: string; // existing UUID context takes priority over model-selected context
  mode?: 'deterministic' | 'llm'; // copilot only; 'llm' requires the OWNER role
  image?: { mime_type: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };
  text?: string; // a voice transcript, business question or copilot question, maximum 2,000 characters
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

## Copilot mode (`task: 'copilot'`)

The copilot answers free-form questions about the shop and always returns evidence. It is read-only: no draft, no write, and no provider call unless the OWNER explicitly asks for prose mode.

Retrieval (`src/features/copilot/CopilotPage.tsx` → `supabase/functions/ai-assist/copilot.ts`) runs first and always:

1. `search_knowledge` ranks documentation sections the caller's audience tier may read.
2. Keyword intents (inventory, acquisitions, sales, revenue, profit, aging, receivables, expenses, audit, team, settings) call only the existing read RPCs — `dashboard`, `list_receivables`, `list_expenses`, `list_audit`, `list_profiles`, `get_settings`, `list_vehicles` — with the caller's JWT, so RLS and `private.require_role` decide what is answerable.
3. Each returned figure is paired with a citation (`id`, `type`, `label`, `detail`, `route`) pointing at the exact screen that shows it (`/vehicles/:id`, `/sales/:id`, `/receivables`, `/expenses`, `/audit`, `/users`, `/settings`, `/reports`, `/docs/:slug`).

Responses use `kind: 'copilot'`:

```json
{
  "kind": "copilot",
  "mode": "deterministic",
  "available": true,
  "coverage": "both",
  "period": "Tháng 09/2026",
  "facts": [{ "label": "Xe đang tồn kho", "value": 7, "display": "7 xe", "citation": "m2" }],
  "citations": [{ "id": "m2", "type": "metric", "label": "Xe đang tồn kho", "detail": "Tháng 09/2026", "route": "/vehicles" }],
  "doc_excerpts": [{ "id": "d1", "title": "Checklist phát hành Cà Rem", "section": "Kiểm thử", "excerpt": "Chạy npm run check:db…" }],
  "answer_markdown": "- Xe đang tồn kho: **7 xe** [m2]",
  "suggestions": [{ "label": "Mở Sổ công nợ", "route": "/receivables" }],
  "insufficient": false,
  "warnings": []
}
```

`mode: 'llm'` is OWNER-only (`validateInput` rejects it for other roles with `LLM_MODE_OWNER_ONLY`). It adds a provider summary written **only over the evidence this request already retrieved** and uses `copilotSchema`/`validateGroundedAnswer`: the provider returns `answer_markdown`, `citation_ids` and `insufficient`; unknown citation ids, missing grounding, over-length prose or non-internal links are rejected and the handler falls back to the deterministic answer with a warning. The provider never receives credentials, raw rows outside the retrieved facts, or a write capability. `AI_ENABLED`, `AI_PROVIDER_API_KEY` and `AI_MODEL` are therefore optional for the copilot: deterministic answers work without any provider configuration, while a missing configuration simply downgrades `mode: 'llm'` to the grounded lookup.

The copilot limit is 30 requests per user per 10 minutes (other tasks remain at 10). Documentation is read through `search_knowledge`, `list_knowledge` and `get_knowledge_article`; see [supabase/API.md](../supabase/API.md) for the corpus and its audience tiers.

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

Local tests cover actual Edge handler authentication, missing configuration, draft confirmation, restricted profit queries, grounded reads, request/image/output validation and absence of business writes. SQL tests separately verify temporary-password gating, real password-change proof, restricted acquisition costs and owner-only performance summaries. The copilot adds `tests/security/copilot.test.ts` (input contract, owner-only prose mode, evidence grounding, provider fallback), `tests/unit/copilot-ui.test.tsx` (Markdown/citation rendering stays escaped and internal), `tests/db/knowledge.test.mjs` (documentation tiers and read RPCs) and `tests/e2e/copilot.spec.mjs` (sidebar entry, clickable evidence, doc viewer).

`node scripts/check-edge-types.mjs` checks the Edge sources against installed Supabase TypeScript types and a minimal Deno runtime declaration when Deno is absent. It does not verify Deno's remote module resolution. Password resets first gate existing sessions, preserve a pending-reset state while Auth credentials change, and record the new temporary-password fingerprint before allowing self-service completion. Self-admin resets use the native change/recovery path; unrelated profile edits do not reset password-change proof.

Hosted GoTrue password updates, actual provider OCR accuracy, deployed Edge policies, real phone cameras/voice permissions and provider spending controls remain live integration checks. Test frame-number recognition against real representative documents before considering document extraction production ready.

References: [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
