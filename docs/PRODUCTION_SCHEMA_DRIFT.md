# Production Schema Drift Matrix (release/xe-crm-v1)

Generated 2026-10-01 by read-only comparison of the LIVE production database
(`atsgqtarxhmxrsugulva`, migrations 001–025 applied historically) against the
LOCAL INTENDED FINAL STATE (clean `supabase db reset` replay of 001–030 with the
neutralized 018 placeholder). No production data or definition was modified.

## Method

- Object fingerprints (`md5` of `pg_get_functiondef` / policy expressions / view defs)
  captured from both databases with the same SQL (`drift-items`, `drift-detail` probes).
- Trigger and view definitions: byte-identical on both sides.
- Shared RLS policies (15): expressions and roles byte-identical on both sides.
- Function signatures verified 1:1 (no overload drift), so `CREATE OR REPLACE` is safe.
- Grants captured via a privilege manifest (`has_*_privilege` matrix per role), not ACL strings.

## Canonical role model

`OWNER`, `MANAGER`, `STAFF` (+ per-profile `can_view_financials` flag, `active`,
`disabled_until`, schedule window). **VIEWER no longer exists anywhere in the
current code**: `src/types/index.ts` (`Role`), `src/lib/permissions.ts`, the user
UI role selector, `manage-users` Edge Function (`['MANAGER','STAFF']` validation)
and all tests reference only the three roles. The VIEWER-era definitions still
running in production are the historical artifacts this reconciliation removes
forward-only (they were legitimately edited out of the local rewritten
migrations; production converges via migration 031 instead of replay).

## Drift matrix

| OBJECT | PRODUCTION STATE | LOCAL INTENDED STATE | DIFFERENCE | SECURITY IMPACT | BUSINESS IMPACT | RECONCILIATION REQUIRED | TARGET | CLASS |
|---|---|---|---|---|---|---|---|---|
| `private.new_auth_user()` | mentions VIEWER in grant logic | VIEWER-free | body drift | low (defensive) | none | YES | 031 | MUST RECONCILE |
| `public.dashboard()` | VIEWER-era aggregation | hardened, no VIEWER | body drift | medium: pre-hardening def | identical outputs for real roles | YES | 031 | MUST RECONCILE |
| `public.get_sale`, `get_vehicle`, `get_settings` | VIEWER reachable branches | VIEWER-free | body drift | medium | none | YES | 031 | MUST RECONCILE |
| `public.list_vehicles`, `list_sales`, `list_acquisitions`, `list_customers`, `list_receivables`, `global_search`, `get_customer_history` | VIEWER-era filters | role-scoped filters | body drift | medium | unchanged for OWNER/MANAGER/STAFF | YES | 031 | MUST RECONCILE |
| `public.sell_vehicle`, `save_settings`, `update_profile` | pre-refactor bodies | final bodies (schedule/active/PII gating) | body drift | medium (`update_profile` loses VIEWER path, keeps `can_view_financials`/`must_change_password` logic) | final sale/settings/profile semantics | YES | 031 | MUST RECONCILE |
| Function EXECUTE grants (36 functions incl. `check_user_access`, `resolve_login_email`, `sell_vehicle`, …) | historical ACL mix | exact matrix from replayed local | ACL drift | **high**: anon could execute `check_user_can_hard_delete`, `update_sale_due_date` | none | YES (031 revokes; only `resolve_login_email` stays anon by design) | 031 | MUST RECONCILE |
| Table/sequence/view GRANT+RLS flags (13 tables, sequences, 1 view) | historical ACLs | exact matrix from local | ACL/flag drift | medium | none | YES | 031 | MUST RECONCILE |
| `public.user_performance_summary` (view) | identical def | identical | acl only | low | none | via 031 grants | 031 | SAFE DRIFT |
| Shared RLS policies (13 public tables) | identical expressions | identical | none | none | none | NO | — | MATCH |
| Triggers (5), view defs (1) | identical | identical | none | none | none | NO | — | MATCH |
| `resolve_login_email`, `check_user_access`, `complete_password_change` | present | present | defs identical | none | none | NO | — | MATCH |
| Legacy credential surfaces (`reset_password_direct`, `process_password_reset`, `password_reset_requests`, owner-info views) | **absent** (dropped by applied 022) | absent | none | none | none | NO | — | MATCH |
| 018 credential-reset SQL | recorded applied 2026-09-30 | neutralized no-op placeholder | version-only slot | none (never re-executes; original holds only credential ops, zero schema changes) | none | NO (must NEVER run) | quarantine | OBSOLETE REMOTE (historical, immovable) |
| 026 communications objects (2 tables, outbox RPCs, settings columns) | absent | present | local only | messaging defaults `false`/`DISABLED` — nothing sends on deploy | enables feature | push 026 | 026 | NEW FORWARD |
| 027 announcements (table + 6 RPCs + policies) | absent | present | local only | OWNER-only management, role-targeted reads | enables feature | push 027 | 027 | NEW FORWARD |
| 028/029 knowledge base + seed | absent | present | local only | audience-tiered reads; non-blocking for core CRM | enables copilot grounding | push 028–029 | 028/029 | NEW FORWARD |
| 030 identity documents (CCCD) | absent | present | local only | private bucket (`public=false` enforced by upsert), OWNER/MANAGER-only helpers, path-regex upload gate, 120s signed URLs, full audit; **source-fixed to revoke default anon EXECUTE** | enables legal-file module | push 030 | 030 | NEW FORWARD |

## Anon-privilege hardening (found by this audit)

Supabase default privileges grant `anon` EXECUTE on newly created public functions.
Historical applied migrations (006/022/023) never revoked some of them, so
production (and a naive local replay) leaks:

- `public.check_user_can_hard_delete(uuid)` — revoked from anon in 031
- `public.update_sale_due_date(uuid, date)` — revoked from anon in 031
- `private.can_user_login()` — unreachable (private USAGE revoked) but also revoked in 031
- 030 identity RPCs — fixed at SOURCE (030 not yet applied anywhere, so editing it is
  forward-clean); replay now shows them `anon=false`

`public.resolve_login_email(text)` remains anon-executable **by design** (pre-login
username resolution; returns only the derived email placeholder). Verified: after a
full replay including 031, it is the ONLY anon-executable function.

## Migration 018 final assessment

The quarantined original is a pure DO block: locate OWNER profile → `UPDATE
auth.users` set hardcoded default password → `UPDATE public.profiles` flag →
informational SELECT. **Zero** CREATE/ALTER/DROP/GRANT/policy/storage statements.
Nothing a fresh database needs lives in it. The local neutralized placeholder
(comments + `SELECT 1;`) is therefore safe to commit, and the version slot keeps
`db push` from ever offering 018 again.
