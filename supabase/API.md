# Database contract

All operations require a verified Supabase session and an active profile. Functions are atomic PostgreSQL transactions. Table writes are denied to browser roles. Financial columns live in separate RLS-protected tables; the JSON functions omit sensitive keys unless the caller is OWNER or MANAGER with `can_view_financials`.

| RPC | Arguments | Result |
| --- | --- | --- |
| list_vehicles | p_filters jsonb = {} | {items,total} |
| get_vehicle | p_id uuid | Vehicle with images, expenses, sales, activity |
| lookup_vehicle_identifiers | p_license_plate text = null, p_frame_number text = null | `{plate_matches,frame_matches}` across the entire eligible inventory, exact compact identifiers only; active STAFF/MANAGER/OWNER, no financial/customer/document fields; partial frame fragments never establish identity, duplicates retained, pending deletion/purged records excluded |
| lookup_identity_document_vehicles | p_id_number text (exact 12 digits; spaces, dots and hyphens accepted) | Vehicle identity array `[{id,internal_code,license_plate,frame_number,vehicle_type,status}]`; OWNER/MANAGER only; exact CCCD links from completed acquisitions or stored sale documents, IN_STOCK/RESERVED only, deduplicated, pending deletion excluded; no document PII |
| save_vehicle | p_data jsonb, p_id uuid = null | UUID |
| sell_vehicle | p_data jsonb | sale UUID |
| cancel_sale | p_id uuid, p_reason text | void |
| add_payment | p_data jsonb | payment UUID |
| list_sales | p_filters jsonb = {} | {items,total} |
| get_sale | p_id uuid | Sale with vehicle, payments, paid_amount, remaining_amount |
| list_expenses | p_filters jsonb = {} | {items,total} |
| save_expense | p_kind text, p_data jsonb, p_id uuid = null | UUID |
| cancel_expense | p_kind text, p_id uuid, p_reason text | void |
| dashboard | p_from date = first day of month, p_to date = today | Metrics and lists |
| report | p_kind text, p_filters jsonb = {} | {items,total} |
| list_audit | p_filters jsonb = {} | {items,total} |
| list_profiles | none | Profile[] |
| update_profile | p_id uuid, p_data jsonb | void |
| get_settings | none | settings object |
| save_settings | p_data jsonb | void |
| register_vehicle_image | p_vehicle_id uuid, p_storage_path text, p_display_order int = 0 | UUID |
| remove_vehicle_image | p_id uuid | void |
| search_knowledge | p_query text, p_limit int = 8 (max 20) | Ranked sections: slug,title,section,audience,source_path,rank,excerpt |
| list_knowledge | none | {items:[slug,title,section,audience,source_path],total} |
| get_knowledge_article | p_slug text | Article with body_md,audience,source_path,updated_at |
| log_copilot_gap | p_question text | void; ai-assist records unanswered questions under the caller's JWT |
| list_copilot_gaps | p_days int = 30 (max 365) | {items:[id,question,hits,last_role,asked_first_at,last_seen_at],total,days}; OWNER only |
| report_client_issue | p_data jsonb: closed source/code/operation/route/release/environment fields | `{recorded,reason?}`; active accounts only, no raw messages or business identifiers; actor rate limits, daily aggregate capacity and 90-day retention |
| list_client_issues | p_days int = 7 (1–90) | `{items,total_occurrences,days}`; OWNER only, up to 50 aggregate groups containing safe diagnostics and first/last times, no actor identities |
| list_vehicle_types | none | JSON array `[{id,name,vehicle_count}]` ordered by name; anonymous callers get only the types that currently have IN_STOCK vehicles, without `vehicle_count` |
| save_vehicle_type | p_id uuid (null to create), p_name text | {id,name}; OWNER only; rejects `INVALID_VEHICLE_TYPE_NAME` (2–60 chars), `DUPLICATE_VEHICLE_TYPE`, `VEHICLE_TYPE_NOT_FOUND`, `VEHICLE_TYPE_PROTECTED` (renaming the fallback) |
| delete_vehicle_type | p_id uuid | void; OWNER only; refuses `VEHICLE_TYPE_IN_USE` and `VEHICLE_TYPE_PROTECTED` (the `Chưa phân loại` fallback) |

List filters: `offset` (default 0), `limit` (default 25; max 100), `search`. Vehicle filters: `status` (enum value, `ALL`, or `AVAILABLE`/`UNSOLD` for IN_STOCK and RESERVED), `vehicle_type`, `year`, `date_from`, `date_to`, `sort` (`newest`, `oldest`, `highest_cost`, `longest_stock`). Sales/expense/report dates: `from`, `to` (also accept `date_from`, `date_to`). Expense kind: `vehicle` or `business` (default both), with optional `vehicle_id`. Report kind: `sales`, `inventory`, `profit`, `vehicle_expenses`, `business_expenses`.

Vehicle identity is the license plate plus the frame number: every read function returns `vehicle_title` (`biển số · số khung`, falling back to the internal code) and `vehicle_subtitle` (`loại xe · đời xe · màu sắc`) computed by `private.vehicle_display`, and the browser renders them through `src/lib/vehicleDisplay.ts` only. The record keeps no brand, model line, variant, engine number, odometer or asking price — those columns were dropped permanently, and no function accepts or emits them. `vehicle_type_id` (or a catalogue `vehicle_type` name, for CSV intake) is required on every write path; an unknown or missing value fails with `VEHICLE_TYPE_REQUIRED` / `INVALID_VEHICLE_TYPE`. The vehicle-type catalogue itself is edited only by OWNER through `save_vehicle_type`/`delete_vehicle_type`; STAFF pick from `list_vehicle_types`.

Dashboard period totals, daily sales, top profits, recent sales and recent expenses obey the selected inclusive date range. Today/month counters use the Asia/Ho_Chi_Minh business date. Inventory is current stock; `inventory_cost_pending` counts missing costs and `inventory_indicator` is LOW/NORMAL/HIGH using saved low/high stock thresholds. The indicator counts vehicles AT THE STORE (`IN_STOCK` + `RESERVED`, which includes bikes held for customers — it is not "sẵn sàng bán"/`IN_STOCK` only) with strict comparisons: LOW when the at-store count is strictly below `low_stock_threshold`, HIGH when strictly above `high_stock_threshold`, otherwise NORMAL — a count exactly equal to a threshold is NORMAL (with low=5, high=100: 4 → LOW, 5 → NORMAL, 100 → NORMAL, 101 → HIGH). Inventory thresholds are operational dashboard indicators only: they do not generate automatic notifications or announcements, and the system sends no email, message, push, or `system_announcements` row when a boundary is crossed (`system_announcements` stays OWNER-authored/manual). Inventory reports filter current stock by intake date; they are not historical stock reconstructions.

Vehicle purchase cost is optional only for operational users. Missing cost is stored as NULL, exposed as `cost_pending:true`, and blocks selling until an authorized financial user enters the actual purchase cost. `purchase_price` and `total_cost` keys are absent for unauthorized users. Expense lists require OWNER or MANAGER. Staff can add/update operational vehicle information and sell vehicles with completed costs.

Sale creation data: `request_id,vehicle_id,customer_name,customer_phone,sale_price,sale_date,initial_payment,payment_method,notes`. `sale_price` and `initial_payment` have no server-side source: the sale form always opens empty and the cashier types the figures, so no other record, draft, AI task or showroom view can prefill a selling price. Receipt proposal data: `request_id,sale_id,amount,payment_method,payment_date,reference,notes` plus optional evidence fields described below; `add_payment` records only a manager-verified proposal. Required VND amounts are exact nonnegative integers, single-entry cap 1,000,000,000,000. Payment amounts must be positive, and total payments may not exceed the sale price. Payments remain immutable; cancelling a sale excludes its retained payments from active collection totals and marks them `VOIDED`, preserving their history. Actual bank/cash refunds are handled outside this V1 app and must be reconciled separately.

Vehicle images use the private `vehicle-images` bucket, JPEG/PNG/WebP/AVIF only, max 8 MiB. Path is `<vehicle UUID>/<random UUID>.<extension>`. Register metadata after successful upload, then generate short-lived signed URLs. Removing metadata soft-deletes it and removes read access through the storage policy. Objects are retained for audit/backup and can be pruned administratively after the retention period.

## Write protocol and verified receipts (forward migrations 009–012)

`acquire_vehicle(p_data)` and inventory creation `save_vehicle(p_data,NULL)` require a durable `request_id` UUID. `import_vehicles(p_vehicles)` requires `{request_id,rows}`. Reuse the UUID after timeout; `get_operation_result(operation,request_id)` reconciles the actor-scoped receipt. Missing IDs fail closed with `CLIENT_UPGRADE_REQUIRED`. Inventory creation uses operation `create_vehicle`; intake, batch and sale use `acquire_vehicle`, `import_vehicles`, `sell_vehicle`. Existing sale UUID recovery remains available.

Expense edits require `expected_updated_at`; creation remains allowed without a revision. Debt edits use `update_sale_due_date(p_id,p_due_date,p_expected_updated_at)`; the legacy two-argument overload refuses writes. Stale revisions return a conflict and do not change money or audit history.

`prepare_payment_receipt(p_data)` requires UUID, sale, amount, method and date. Optional physical evidence uses `evidence_kind` (`BANK_TRANSACTION`, `CASH_VOUCHER`, `MANUAL_RECONCILIATION`), `evidence_scope` (receiving account/register) and `evidence_reference` (shared transaction/voucher code). Codes are trimmed and uppercased; each identity is unique across the store. Independent UUIDs with the same matching evidence return one proposal. A proposal is **PENDING**, has no financial effect, and appears through `list_payment_receipts(p_sale_id)`.

`get_payment_receipt_request(p_request_id)` returns `{confirmed,receipt}` scoped to the actor. Request aliases are persisted atomically even when independent UUIDs converge onto one canonical receipt; recover with this lookup after losing the proposal response. Changed payload with the same request returns conflict. Rejected proposals retain their history and request aliases, while a corrected new proposal may reuse unrecorded evidence after explicit manager rejection. BANK_TRANSACTION requires BANK_TRANSFER; CASH_VOUCHER requires CASH. Manual evidence always requires human review.

`add_payment(p_data)` now requires `receipt_id` and transport `request_id`. Only OWNER/MANAGER may record a pending proposal, with `verification_reference` describing evidence actually checked and a canonical business identity if missing. The manager compares bank/cash evidence and all existing payments, including sale initial receipts. Receipt identity fixes the ledger UUID; concurrent/different transport IDs return the same payment. STAFF can replay an already-recorded receipt. `reject_payment_receipt(p_id,p_reason)` is OWNER/MANAGER-only and preserves the rejected proposal plus audit. Missing receipt fails closed for legacy clients. Equal amounts/dates with distinct legitimate vouchers remain independent. Do not fabricate a bank transaction or voucher code; without reliable evidence, reconcile manually before recording. A transfer allocated across multiple sales needs a reviewed allocation contract; automatic splitting is unsupported.

Message workers use `claim_message(p_message_id,p_provider_mode)` and returned `lease_token` (120 seconds). Finish/fail/skip/renew require the token. Old unfenced endpoints refuse writes. Expired MOCK jobs can reclaim with deterministic job identity, with bounded total attempts. Unknown legacy delivery is quarantined for manager review; `resolve_message_delivery(p_message_id,p_resolution,p_evidence_reference)` accepts `CONFIRMED_SENT` or `CONFIRMED_NOT_SENT` only after provider evidence is checked. No production provider or unattended scheduler is certified by local MOCK tests.

## Knowledge base and AI copilot

`public.knowledge_base` stores one row per documentation section (`slug` unique, `title`, `section`, `body_md`, `audience` in `ALL`/`STAFF`/`MANAGER`/`OWNER`, `source_path`, generated `tsvector` with a GIN index). Browser roles have `SELECT` only, guarded by the `knowledge_base_read` policy and re-checked inside each `SECURITY DEFINER` function through `private.knowledge_visible(audience)`: OWNER reads every tier, MANAGER reads `ALL`/`STAFF`/`MANAGER`, STAFF reads `ALL`/`STAFF`, and disabled or unauthorized callers are rejected by `private.require_role`. Unknown and unauthorized slugs are indistinguishable (`KNOWLEDGE_NOT_FOUND`).

The corpus is generated from repository documentation by `npm run knowledge:seed` (`scripts/build-knowledge-seed.mjs`), which writes `supabase/migrations/20261001002900_knowledge_seed.sql` as an idempotent upsert plus a prune of stale slugs; edit the Markdown files, never the seed migration. `docs/SYSTEM_REFERENCE.md` is itself derived from the code (public RPCs with their `require_role` gates, routes from `src/App.tsx`, Edge Functions, storage buckets) by `scripts/build-system-docs.mjs` — regenerate with `npm run knowledge:system`, which is chained into `knowledge:seed`/`knowledge:check` so CI fails when code changed but the reference did not. Operational procedures for staff live in `docs/INTERNAL_SOPS.md` (audience STAFF). The `ai-assist` copilot reads this corpus through `search_knowledge` together with the existing read RPCs and returns a citation for every figure; see [docs/AI_ASSIST_CONTRACT.md](../docs/AI_ASSIST_CONTRACT.md).

When the copilot finds neither data nor documents (`coverage: 'none'`), `ai-assist` calls `log_copilot_gap` with the caller's own JWT; questions collapse on normalized text with a hit counter in `public.copilot_question_gaps` (RLS on, no browser policies, no business data). The OWNER reviews the digest via `list_copilot_gaps` in the in-app docs page and writes the missing SOP into `docs/INTERNAL_SOPS.md` to close the loop.

`manage-users` Edge Function accepts POST `{email,password,full_name,role,can_view_financials}` for an OWNER to create a user. Role/status updates use `update_profile` RPC; self-profile updates accept only full_name. The final active OWNER cannot be disabled/demoted. Owner provisioning for the first account is documented separately and requires a trusted SQL session.
