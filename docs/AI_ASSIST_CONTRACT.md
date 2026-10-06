# Xe CRM AI extraction and read assistant — prepared interface

Status on 2026-10-01: implemented locally and verified with mocked provider/Edge tests, plus the `knowledge_base` corpus and its PGLite checks. No provider key has been configured, no external images/text have been sent, and no Edge deployment or hosted business mutation has been performed by this work.

## Request and response

Invoke the `ai-assist` Supabase Edge Function with the existing authenticated user session. The frontend must display a clear processing action and send `consent: true` only after the user invokes it. The function rejects unauthenticated, disabled, outside-schedule, deleted and temporary-password users before provider processing.

```ts
type Request = {
  task: 'receipt' | 'vehicle_document' | 'vehicle_scan' | 'license_plate' | 'odometer' | 'voice' | 'business_question' | 'copilot';
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

Every field is nullable when uncertain. Document fields are frame number, engine number, plate, brand, model, color and year. `vehicle_scan` (the smart camera at `/capture`) additionally returns `variant` and `odometer`: plate/frame/engine are copied exactly as printed with the plate normalised to `59-A1 234.56`, brand/model/variant/color may come from visible styling, year only from printed evidence — anything unclear must be null, so the client never receives an invented value. Odometer/plate tasks return only their respective field. Voice returns a limited intent (`CREATE_ACQUISITION`, `ADD_VEHICLE_EXPENSE`, `PREPARE_SALE`, `UNKNOWN`) and explicit draft fields. It never executes a command. Browser speech recognition can supply the `text` field; typed text remains the fallback. Server transcription is not implemented.

The frontend must apply a draft only to an editable form, retain existing vehicle context, show extracted values for review, warn on reduced odometer readings, and call the normal secure business RPC only after human confirmation. A draft is not a completed acquisition, expense, payment or sale. No write/action-agent endpoint exists.

## Read assistant and permissions

Business questions are converted into a validated read plan. The server executes a fixed read allowlist with the current user's JWT, then returns actual RPC data as `facts`. Model-generated numbers or prose answers are not used. Database results are not sent to the external provider.

Supported plans: inventory counts, monthly acquisition counts, monthly sale counts, monthly revenue, monthly gross profit, inventory aging, vehicle search, vehicle expenses and vehicle history. These currently map to `dashboard`, `list_vehicles` and `get_vehicle`; pagination limits search to 25 results. Unsupported questions return `available:false`. Failed retrieval returns `503 DATA_UNAVAILABLE`.

`OWNER` can request all supported plans. Revenue and expense queries require `OWNER`/`MANAGER`. Profit requires `OWNER` or a `MANAGER` with `can_view_financials`. Staff can search/view operational summaries, but cannot use the assistant to bypass restricted costs/profit. Expense extraction/drafts require management rights. Vehicle-document, smart-camera `vehicle_scan` and lifecycle voice drafts require operating rights. Every database RPC still enforces the server's existing authorization.

## Copilot mode (`task: 'copilot'`)

The copilot answers free-form questions about the shop and always returns evidence. The function itself is read-only: no draft, no write, and no provider call unless the OWNER explicitly asks for prose mode.

Retrieval (`src/features/copilot/CopilotPage.tsx` → `supabase/functions/ai-assist/copilot.ts`) runs first and always:

1. `search_knowledge` ranks documentation sections the caller's audience tier may read.
2. Keyword intents (overview, inventory, acquisitions, recent sales, sales, daily cash, revenue, profit, aging, receivables, expenses, audit, customers, team, settings) call only the existing read RPCs — `dashboard`, `list_receivables`, `list_expenses`, `list_audit`, `list_profiles`, `get_settings`, `list_sales`, `list_customers`, `daily_reconciliation` — with the caller's JWT, so RLS and `private.require_role` decide what is answerable. `daily_reconciliation` is the server's own OWNER/MANAGER gate, so the cash intent is marked management-only.
3. When no intent yields a figure, a grounded fallback runs `global_search` on a detected plate, phone number, or quoted name, citing the matching vehicles, sales and customers directly.
4. Each returned figure is paired with a citation (`id`, `type`, `label`, `detail`, `route`) pointing at the exact screen that shows it (`/vehicles/:id`, `/sales/:id`, `/receivables`, `/expenses`, `/audit`, `/users`, `/customers`, `/settings`, `/docs/:slug`).

Questions naming a period resolve it in Asia/Ho_Chi_Minh before the read: `tháng 9`, `tháng này`, `tháng trước`, `2026-08`, `hôm nay`, `hôm qua`, `tuần này`, `quý 3`, `năm 2025` and `tháng 9 năm 2025` all set the `dashboard`/`list_sales` bounds.

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

### Draft-to-save handoff (client-side, review-only)

`src/lib/shorthand/draftActions.ts` deterministically parses a command sentence typed into the copilot (also used by the `/assist` voice task when no provider is configured) into an editable draft proposal: "chi 500k thay nhot xe 59-B1 123.45" → vehicle expense, "ban cho anh Binh 30tr xe 59-B1 123.45" → sale draft, purchase shorthand → the existing `/intake` parser. Detection runs entirely in the browser, refuses questions and interrogations, requires a real plate for anything vehicle-bound, and never reaches this Edge Function. `DraftActionCard` only prefills the normal secure forms — `QuickExpenseModal`, the sale sheet (`SellVehiclePage` consumes `state.aiDraft` for customer name/phone/price only) or the seeded notes box on `/intake` (`state.seedText` auto-parses) — and the write still happens through the existing confirmed RPC after the human reviews every field. Expense proposals render only for OWNER/MANAGER (`canManage`), sale and intake proposals only for operable roles. This is a UX handoff, not an action agent: no RPC executes without the forms' own confirmation.

### Smart Camera recognition (`/capture` → `/intake`)

The smart camera is a local-first scanner (`src/lib/smartcam/`): recognition runs on-device and `vehicle_scan` (this Edge Function) is an optional, budgeted cloud fallback — never the default per-frame path. Every business decision stays client-side under the existing read RPCs:

0. Three layers per live scan tick, cheapest first: (a) ZXing QR/barcode decoding of the frame — free, multi-code (whole frame + lower band); a vehicle QR is verified against `get_vehicle` before it counts as a match; (b) Tesseract WASM OCR in a background worker — free, plate-band + sparse-text passes with contrast preprocessing, glyph-confusion candidate parsing gated by `@/lib/plate` validation, adaptive frame sampling (650 ms base, backoff to 2.4 s while starved, never overlapping passes) and stable-frame voting (a read fires only after ≥2 identical frames at ≥55 mean confidence, with scene-change reset); (c) the paid `vehicle_scan` cloud call only in a configured mode — default **`manual`** (explicit "AI đọc ảnh" button or user-initiated shot; `auto` fallback after six consecutive sharp unreadable ticks must be deliberately enabled), or `off`. Camera frames are never streamed; at most one image leaves the device per budgeted decision. The local layers extract identity strings only (plate/frame/engine/QR): **manufacturer, model, variant and color classification is cloud-only** (`vehicle_scan` visual fields, always SUGGESTED for human review) — there is no on-device appearance model and none is claimed.
1. `recognition.ts` normalizes identifiers through `@/lib/plate` (canonical plate, stripped frame/engine codes, implausible year/odometer degrade to unreadable — never to a guess; `source: "local" | "cloud"` records which layer produced the read), then `lookup.ts` resolves identity via `list_vehicles` re-filtered to exact canonical equality: one match → VERIFIED vehicle profile; no match → optional "Thu xe mới"; multiple or contradictory identifiers → ambiguous/conflict requiring manual verification. Visual appearance alone never concludes "new vehicle". The success tone sounds only for a unique verified match (and only once per scan target); ambiguous or conflicting identity gets the review tone; "no match" is silent.
2. Each field carries a provenance status (VERIFIED / SUGGESTED / UNREADABLE / CONFLICT) that travels with the result and renders as badges in the camera and inline in the intake form.
3. "Thu xe mới" maps the single normalized result onto one existing `IntakeEntry` (`recognitionToIntakeEntry`) and navigates to `/intake` via `state.recognition` — no second intake parser, no parallel save API. The write remains the confirmed `validate_import_vehicles` → `import_vehicles` protocol; prices and customer data are never prefilled from the camera.
4. User-approved photos stay in memory/router state (sessionStorage drafts exclude images) and upload after the confirmed write through the existing storage gateway, keyed by the server-issued `vehicle_ids` that `import_vehicles` returns in the same transaction (stored in the operation receipt, so a reconciled replay carries them) — never a substring re-search of the inventory; the exact-match re-lookup is a last resort for legacy results and only when exactly one row matches. Upload failures are reported without touching the saved record. Auto-capture, on-device OCR, sound and auto-open are user settings.

### Cloud cost limits (`vehicle_scan` from the camera)

The only client code path that can invoke the paid provider for the camera is `api.assist({ task: 'vehicle_scan' })` inside `SmartVehicleScan.cloudRead` — every frame analysis, lookup and photo operation is local or free-RPC. Each call is checked against a rolling one-hour browser ledger (`src/lib/smartcam/local/budget.ts`, key `xe_crm_smartcam_cloud_ledger_v1`): at most 6 cloud reads per hour overall and 1 per scan target per hour; manual/library shots get minute-granularity target keys. The ledger records latency and image bytes per call, the UI shows today's usage against the limit, and blocked fallbacks surface an honest Vietnamese notice instead of silently spending. Consent to send images remains mandatory for any cloud call. **This browser ledger is friction, not a ceiling** — it resets with the device and cannot bound the organization. Server side, every request is already authenticated (`check_user_access` + profile role + task gate + per-user `throttle` of 10 requests/10 minutes before any provider call, plus the 2 MB image bound and `AI_ENABLED` as a global kill switch), but that throttle lives in isolate memory: it is per-isolate, not a shared or persistent org-wide budget. A true enforceable ceiling needs a server-side usage table (migration) and provider spending caps — until those are verified, cloud mode defaults to `manual`. Latency and JS heap usage (Chromium only) render in the on-screen metrics row; real device OCR accuracy, false-match rate and provider cost per 1,000 scans are live checks this repository cannot measure.

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

Local tests cover actual Edge handler authentication, missing configuration, draft confirmation, restricted profit queries, grounded reads, request/image/output validation and absence of business writes. SQL tests separately verify temporary-password gating, real password-change proof, restricted acquisition costs and owner-only performance summaries. The copilot adds `tests/security/copilot.test.ts` (input contract, owner-only prose mode, evidence grounding, provider fallback), `tests/unit/copilot-ui.test.tsx` (Markdown/citation rendering stays escaped and internal), `tests/unit/copilot-draft-actions.test.tsx` (deterministic command parsing, question rejection, plate/phone guards, role-gated prefilled card), `tests/db/knowledge.test.mjs` (documentation tiers and read RPCs) and `tests/e2e/copilot.spec.mjs` (sidebar entry, clickable evidence, doc viewer). The smart camera adds `tests/security/ai-assist.test.ts` vehicle_scan cases (consent, role gate, exact-key/range output rejection), `tests/unit/smartcam.test.ts` (acceptance A/B/E/F/G at the pure-logic layer: identity resolution, conflict blocking, provenance, intake-entry mapping without invented fields, beep dedupe, draft roundtrip without photos), `tests/unit/smartcam-local.test.ts` (18 cases on the real-world parsing layer: plate/frame/engine OCR-text candidates with glyph confusions, current and legacy province prefixes, stable-frame voting, adaptive sampling, the cloud budget ledger, and created-id correlation that rejects misaligned or non-v4 lists), `tests/e2e/smartcam-ocr-runtime.spec.mjs` (runtime proof with the actual Tesseract worker, same-origin WASM core and language data: a real Chromium page performs genuine OCR on a cleanly rendered plate and matches it uniquely with zero `ai-assist` requests; skips honestly when the language CDN is unreachable) and `tests/e2e/smart-camera.spec.mjs` (known plate → profile with zero writes; unknown plate → intake prefill saved only after confirmation, photo attached through the storage gateway using the trusted `vehicle_ids` — the spec asserts `register_vehicle_image.p_vehicle_id` equals the id the import returned, and runs with on-device OCR disabled so no WASM is downloaded; consent refusal sends no image).

`node scripts/check-edge-types.mjs` checks the Edge sources against installed Supabase TypeScript types and a minimal Deno runtime declaration when Deno is absent. It does not verify Deno's remote module resolution. Password resets first gate existing sessions, preserve a pending-reset state while Auth credentials change, and record the new temporary-password fingerprint before allowing self-service completion. Self-admin resets use the native change/recovery path; unrelated profile edits do not reset password-change proof.

Hosted GoTrue password updates, actual provider OCR accuracy, deployed Edge policies, real phone cameras/voice permissions and provider spending controls remain live integration checks. Test frame-number recognition against real representative documents before considering document extraction production ready.

References: [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [image inputs](https://developers.openai.com/api/docs/guides/images-vision), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
