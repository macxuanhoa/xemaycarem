# Security and deployment notes

## Database boundaries

- Every application table has RLS enabled. The browser has SELECT only; no INSERT, UPDATE, DELETE, or sequence privileges. All mutations pass through explicit functions with active-role checks and an empty `search_path`.
- `vehicle_financials` and `sale_financials` isolate purchase costs and profit from general inventory/sale records. OWNER and financially authorized MANAGER have SELECT through RLS. JSON functions apply the same financial gate. STAFF and nonfinancial MANAGER cannot sort by cost or invoke profit reports.
- Profile defaults are active STAFF (the lowest operational role). Auth `user_metadata` is never trusted for permissions. Public registration is disabled in both local config and production Auth settings. A disabled profile is rejected by every RPC and RLS data policy; profile self-read is the only exception, so the app can explain that access is disabled.
- `private` is not an API-exposed schema. Only small RLS predicates can be executed by authenticated clients. Audit insertion, JSON serialization, money parsing, and role validation helpers are not executable directly.
- `knowledge_base` holds documentation text, never business rows. Audience tiers (`ALL`/`STAFF`/`MANAGER`/`OWNER`) are enforced by an RLS read policy and repeated inside each definer read RPC (`search_knowledge`, `list_knowledge`, `get_knowledge_article`), because `SECURITY DEFINER` bypasses RLS. The corpus comes from tracked markdown via `scripts/build-knowledge-seed.mjs`, so a secret or credential must never be pasted into a documentation file, especially a low-tier one. No browser write access exists.
- `audit_logs`, `vehicle_activity`, and `sale_financials` reject modification/deletion even from privileged SQL unless their protecting triggers are deliberately removed. Authenticated clients cannot append arbitrary audit events. Owner audit contains financial data; the separate operational timeline contains only action, actor, entity, and timestamp.
- Currency is integer VND. The database validates input strings before conversion (no fractional rounding). A single entry is bounded at 1 trillion VND, and aggregates reject values outside JavaScript's exact integer range.

## Atomicity and cancellation

All writes affecting a vehicle's cost or sale state lock the same vehicle row first. `sell_vehicle` locks it, validates availability, captures immutable cost snapshots, inserts the sale/payment, changes the vehicle state, and adds audit events in a single transaction. A partial unique index independently prevents two completed sales for one vehicle. Payment creation and cancellation lock the same vehicle and then sale row, serializing balance checks without deadlock-prone inverse lock ordering.

Expenses and purchase cost cannot change while a vehicle is sold. A sale can be cancelled by OWNER/MANAGER with a recorded reason, returning the vehicle to stock. Payments remain in history as VOIDED and are excluded from active paid balances; they are never deleted. This records business cancellation only. Real refunds must be completed and reconciled separately. A subsequent resale creates a new snapshot and retains the cancelled sale's original snapshot.

An incomplete purchase cost is NULL, never assumed zero. Operational staff can receive a vehicle without knowing its cost. A financially authorized user must complete the purchase cost before any sale. Inventory value is NULL while any stock vehicle has an unknown cost; `inventory_cost_pending` identifies the count.

## Owner provisioning

1. Apply migrations to the correct Supabase project.
2. In Supabase Auth, create the initial owner using a verified email and a unique strong password. The trigger creates an inactive profile.
3. In a trusted SQL editor, substitute the actual Auth UUID and run:

```sql
update public.profiles
set full_name = 'Chủ cửa hàng', role = 'OWNER', active = true,
    can_view_financials = true, updated_at = now()
where id = 'AUTH-USER-UUID-HERE'::uuid;
```

4. Confirm exactly one expected profile was updated. Sign in and create subsequent users from Users. Never share the owner account. The owner account can be renamed later.
5. Disable public signup in the hosted project's Auth settings too; `config.toml` configures local services and is not proof that hosted settings changed.

The Edge Function requires `SUPABASE_URL`, a public API key, a server secret API key, and `ALLOWED_ORIGINS` (comma-separated exact origins, e.g. `https://your-store.example`). The handler enforces this list on CORS: a browser `Origin` not in `ALLOWED_ORIGINS` receives no `Access-Control-Allow-Origin` header and the browser blocks the response. Leaving `ALLOWED_ORIGINS` unset falls back to the Supabase SDK default CORS headers and is acceptable only for local development; production deployments must always set it. Legacy environments provide the keys as `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`; modern names are listed below. Deploy `manage-users` with JWT verification enabled. The handler also validates the JWT via Auth `getUser`, checks an active OWNER in the database, bounds input, creates an inert account through the server-only Auth Admin API, then activates it through the caller-authorized RPC. If activation fails, the account remains inactive and is returned as `USER_CREATED_INACTIVE`; inspect it in Users instead of retrying blindly. Passwords and tokens are never logged.

Modern key configuration is also supported: `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY`, or the platform's named `SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS` JSON objects (preferring `default`). The legacy names above are fallbacks. The browser sends its session JWT as `Authorization: Bearer ...` and its public key as `apikey`; a publishable key by itself never passes the handler's Auth user verification. See [Edge authorization headers](https://supabase.com/docs/guides/functions/auth-headers) and [API keys](https://supabase.com/docs/guides/getting-started/api-keys). No additional browser admin grants are needed: Auth Admin creation uses the server secret, while profile activation uses the owner's authenticated RPC permissions.

## AI copilot

The `ai-assist` function answers shop questions (`task: 'copilot'`) with a read-only evidence engine. It holds no service-role credential: every figure and document section is fetched with the caller's own JWT through the existing read RPCs and the knowledge search, so the assistant cannot widen what a STAFF account may already see. Financial keys simply disappear from the payload rather than rendering as zero. Retrieval is deterministic by default and needs no provider configuration. OWNER may request an `llm` summary, which is constrained to re-word the evidence already retrieved for that request; `copilotSchema` and `validateGroundedAnswer` discard any answer citing an unknown evidence id, stating an ungrounded figure or linking outside the app, and the handler falls back to the deterministic answer with a warning. The provider receives no credentials and no raw rows beyond those facts, and images/documents are never sent for copilot. There is no write, draft-application or command endpoint in this path.

## Storage

The `vehicle-images` bucket is private, permits JPEG/PNG/WebP/AVIF, and caps each object at 8 MiB. Object paths must belong to an existing vehicle. No object can be overwritten by a browser. Unregistered objects are not readable. Soft-deleted metadata denies new read requests; already issued signed URLs remain usable until their short expiration. Avoid long-lived signed URLs. Metadata removal retains the physical object for retention/backup. Review abandoned upload objects periodically with a trusted administrator; do not enable broad public policies to make images render.

## Production checklist

- Deploy the migrations, Edge Function, and static web build; set HTTPS Auth site URL and exact reset-password redirect URL.
- Supply only the public Supabase URL and anon/publishable key to Vite. Server secrets never use a `VITE_` variable.
- Keep API exposed schemas to public (and Supabase defaults if required); never expose private.
- Re-run authorization tests after modifying any grant, policy, or SECURITY DEFINER function. Do not grant browser table write access.
- Set database backups for the chosen Supabase plan; maintain encrypted external dumps and a separate storage-object backup. A database dump does not contain Storage object bytes or replace Auth configuration backup.
- Restore in an isolated project first; verify owner access, record counts, snapshots, payments, RLS, and image access before changing production endpoints.

Supabase references: [Database functions](https://supabase.com/docs/guides/database/functions), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Auth getUser](https://supabase.com/docs/reference/javascript/auth-getuser).
