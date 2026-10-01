# Production Auth Acceptance Report

**Verification date:** 2026-10-01  
**Production project:** `atsgqtarxhmxrsugulva` (`https://atsgqtarxhmxrsugulva.supabase.co`)  
**Scope:** Read-only production probes and local code-path inspection. No code, database, account, or Edge Function changes were made.

## Follow-up acceptance-test attempt

The requested real OWNER-UI acceptance sequence could not start in this session. Browser control failed during initialization before it could inspect any open tab, so the claimed OWNER session could not be reached. No UI clicks, authenticated requests, or account actions were performed. All creation/login/role/disable/delete acceptance results below remain untested; reconnect the production OWNER browser tab in Codex to resume.

## Evidence correction

The earlier conclusion that migration `20260930002200` was missing, that the password-change path deadlocked, or that any one of these was the production root cause was unsupported. Those claims are withdrawn. Production migration-ledger state remains unknown.

## Production verification matrix

| Check | Result | Evidence and limits |
|---|---|---|
| `resolve_login_email(p_identifier)` | **Callable; returned a value** | `POST /rest/v1/rpc/resolve_login_email` with the known username `nguyenb11` returned HTTP 200 and a value in the internal-email domain. The value was not recorded. This alone cannot distinguish a stored mapping from the function's fallback. |
| `check_user_access()` | **Exists; anonymous execution denied** | Anonymous call returned HTTP 401 with PostgreSQL code `42501` (`permission denied for function`). This confirms the function resolves in production but is not executable by `anon`. No signed-in user token was available to verify its authenticated behavior. |
| `manage-users` | **Unknown** | `OPTIONS /functions/v1/manage-users` returned HTTP 200 and an allow-origin header. Unauthenticated `POST` returned HTTP 401. This establishes a CORS response and an authentication rejection, not successful function execution, deployment/version, or OWNER authorization. No OWNER invocation was made. |
| Production migration ledger | **Unknown** | Supabase CLI/access token unavailable. No ledger query was performed. |
| Production definitions/policies for access RPCs, profile RLS, `active`, schedule fields, and `must_change_password` | **Unknown** | No authenticated metadata or SQL access was available. Local migration definitions are not evidence of production state. |
| OWNER login | **Not tested** | No OWNER credentials/session available. |
| Old STAFF Auth (`nguyenb11` / `phoang.le2409`) | **Not tested** | No password sign-in attempt was made. Resolver call is not an Auth sign-in test. |
| Old STAFF application access | **Expected to fail at the active check, conditional on Auth success and deployed matching app code** | Existing audit evidence records both profiles as `active=false`. The live login path was not exercised in this verification. |
| Fresh STAFF creation through OWNER UI | **Blocked / not attempted** | No authenticated OWNER session; unauthenticated Edge Function request returned 401. No account was created. |
| Fresh STAFF Auth, forced password change, and app entry | **Blocked / not tested** | No fresh account was created. |

## First failing layer

**No first failing request from the reported manual login attempt has been observed.** The production authentication and route sequence remains untested.

If either old account successfully completes Supabase password authentication and receives its audited `active=false` profile, the local AuthProvider checks `profile.active` before it calls `check_user_access()` and blocks that session at the **ACTIVE FLAG** layer. Whether that was the first failing layer in the user's actual attempt remains unverified.

## Manage-users probe details

- Preflight: HTTP 200 with an allow-origin response.
- Unauthenticated POST: HTTP 401.
- Authenticated OWNER invocation: not attempted; no OWNER token/session was available.
- Function deployment/version and last-updated time: unknown.
- No create action succeeded or was attempted with credentials.

The 401 is an authentication result from the unauthenticated probe. It must not be interpreted as a 404, a confirmed missing function, or a successful handler invocation.

## Authentication versus application access

The production `resolve_login_email` endpoint is callable, but no `signInWithPassword` request was made. Therefore Auth identity/password acceptance is unknown. Profile lookup, authenticated `check_user_access`, route guards, and first application queries were not observed against a signed-in production user.

Local code inspection only:

- `LoginPage` resolves a username through `resolve_login_email` before password sign-in.
- `AuthProvider` then reads the matching profile, rejects deleted or inactive profiles, and calls `check_user_access` for active profiles.
- The local migration's `check_user_access()` denies inactive profiles and allows eligible users while returning the `must_change_password` flag.
- `Protected` redirects a profile with `must_change_password=true` to `/change-password`; that route is declared outside the protected application shell, and the page requires a loaded profile. The local path does not show the previously alleged deadlock for an active account whose access check succeeds.

These are local-code observations only; deployed frontend and database behavior remain unverified.

## Production auth matrix

- **`resolve_login_email`:** EXISTS / callable; HTTP 200, value returned. Stored mapping versus fallback not distinguished.
- **`check_user_access`:** EXISTS; anon gets HTTP 401 / `42501` execute permission denied; authenticated call not tested.
- **`manage-users`:** UNKNOWN; preflight HTTP 200; unauthenticated POST HTTP 401; OWNER invocation not tested.
- **OWNER login:** NOT TESTED.
- **OLD STAFF account Auth:** NOT TESTED.
- **OLD STAFF app access:** Expected FAIL at active check if Auth succeeds and deployed app matches inspected local code; live flow NOT TESTED. Reason on audited profiles: `active=false`.
- **FRESH STAFF creation:** BLOCKED / NOT ATTEMPTED (no OWNER session).
- **FRESH STAFF Auth:** BLOCKED / NOT TESTED (no fresh account).
- **FRESH STAFF forced password change:** BLOCKED / NOT TESTED.
- **FRESH STAFF app entry:** BLOCKED / NOT TESTED.
- **First failing layer:** UNKNOWN for the actual reported attempt. Conditional old-account blocker: ACTIVE FLAG after successful Auth and profile lookup.

## Safe next action

Use an authorized OWNER browser session to inspect Network requests while creating exactly one disposable STAFF account, only after confirming the intended production project. Separately test that account's password sign-in and record the status/body category for profile lookup, `check_user_access`, route transition, and first app queries. A live authenticated probe is also required to verify the production `check_user_access()` object and its behavior.

Do not reactivate the old accounts, apply migration `20260930002200`, deploy `manage-users`, or make other production changes based on the current evidence. Compare actual production objects with the migration first; if any state is incomplete, prepare a reviewed forward-only reconciliation rather than replaying the historical migration blindly.
