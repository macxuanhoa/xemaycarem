# Cà Rem — Offline PWA & Web Push Runbook

Covers the two capabilities shipped in migrations `20261014001100_push_subscriptions.sql` /
`20261014001200_push_delivery_queue.sql`, Edge Function `push-dispatch`, the custom
`injectManifest` Service Worker (`src/sw.ts`), the client library (`src/lib/push.ts`)
and the Settings → "Thông báo đẩy" card.

---

## 1. Architecture at a glance

```
notifications INSERT ──(AFTER INSERT trigger)──▶ push_deliveries (transactional outbox)
                                                       │ claim_push_deliveries (service_role only,
                                                       │ FOR UPDATE SKIP LOCKED + 2-min lease)
browser PWA ◀── encrypted (RFC 8291) push ◀── push-dispatch Edge Function (RFC 8292 VAPID)
   │  register/list/revoke/test via SECURITY DEFINER RPCs (never expose endpoints to browsers)
   └── self-drain: authenticated users may invoke push-dispatch to flush ONLY their own queue
```

* Content is read **straight from the already per-recipient-gated `notifications` row** —
  there is no second path that could leak OWNER-private prices or customer PII to a lock screen.
* Same-transaction dedup (CREATE_PAYMENT inside CREATE_SALE, VOID inside CANCEL_SALE) deletes
  the notification row → `ON DELETE CASCADE` kills its queued push. No phantom pushes.
* `navigator.onLine` is never trusted for money paths; offline mode disables writes client-side
  and the server is authoritative regardless.

## 2. Secrets & configuration checklist

| Where | Name | Value | Notes |
| --- | --- | --- | --- |
| Edge Function (`supabase secrets set`) | `VAPID_PUBLIC_KEY` | base64url raw P-256 (65 B) | from `node scripts/generate-vapid-keys.mjs` |
| Edge Function | `VAPID_PRIVATE_JWK` | compact JWK JSON `{kty,crv,d,x,y,ext:false}` | NEVER put in the frontend or any `.env` that ships |
| Edge Function | `VAPID_SUBJECT` | e.g. `mailto:it@carem.example` | optional; RFC 8292 `sub` claim |
| Edge Function | `PUSH_SWEEP_TOKEN` | random ≥32 chars | optional; enables the cron sweep caller only |
| Frontend (Vercel env, build time) | `VITE_VAPID_PUBLIC_KEY` | same public key as above | without it the UI shows "server not configured" and never prompts for permission |
| Supabase managed | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | auto-injected on `functions deploy` | push-dispatch fail-closes with 503 `SERVER_CONFIGURATION_REQUIRED` when unset |

Regenerating VAPID keys invalidates every stored subscription (browsers subscribed with the old
application key will fail delivery); if rotated, users must re-enable push from Settings.

## 3. Deployment order (requires explicit authorization — none of this is done automatically)

1. **Migrations** (forward-only, never rewrite deployed ones):
   `supabase db push` — applies `…001100` then `…001200`. Safe to deploy before any
   function exists: rows simply stay `QUEUED` (nothing is lost; bell/in-app notifications are
   unaffected).
2. **Edge Function**:
   `supabase functions deploy push-dispatch` (per-function `verify_jwt = false` is declared in
   `supabase/config.toml` — the handler authenticates callers itself) then set the secrets above.
   Verify the fail-closed smoke by hand: `POST /functions/v1/push-dispatch` without Bearer →
   `401 {"error":"AUTH_REQUIRED"}` (after secrets) / `503 SERVER_CONFIGURATION_REQUIRED` (before).
3. **Frontend** (Vercel): set `VITE_VAPID_PUBLIC_KEY`, build, deploy. The `injectManifest` SW
   (`dist/sw.js`) precaches the shell; autoUpdate activates the new worker on next visit.
4. **Sweep scheduling** (pick at least one; without a sweeper queued pushes drain only when a
   user opens the app / clicks "Gửi thử"):
   * GitHub Actions `push-sweep.yml` — enable with repository variable `ENABLE_PUSH_SWEEP=true`
     plus secrets `SUPABASE_URL` + `PUSH_SWEEP_TOKEN` (it no-ops safely when absent), or
   * any external cron POSTing `{"worker":"cron-1"}` to the function with
     `Authorization: Bearer $PUSH_SWEEP_TOKEN`, or
   * Supabase `pg_cron` + `pg_net` calling the function edge URL.

## 4. Manual device-testing instructions (Phase 3)

Automated gates cover: DB outbox lifecycle (24 checks), payload/crypto contract (12 checks),
installability + offline shell + SW update (release gate). The matrix below has NOT been
executed on real hardware from this workspace — run it before enabling push for staff:

| # | Scenario | Android Chrome | Desktop Chrome/Edge | iPhone/iPad home-screen PWA |
| --- | --- | --- | --- | --- |
| 1 | Install (banner / beforeinstallprompt / Safari Share→Home) | ✔ supported | ✔ supported | iOS: manual add only |
| 2 | Open offline after one online visit (shell + assets) | real device, airplane mode | DevTools offline | real device, airplane mode |
| 3 | Reconnect → banner clears, retry works | ✔ | ✔ | ✔ |
| 4 | Deploy update while tab open → autoActivate, no stale execution | | | |
| 5 | Settings → "Thông báo đẩy" → Bật → OS permission prompt appears (never before) | | | iOS 16.4+ ONLY when launched from home screen |
| 6 | Receive push foreground/background/closed | | | |
| 7 | Click notification → opens deep link / falls back to `/thong-bao` | | | |
| 8 | Reject permission → enable shows guidance, no loop | | | |
| 9 | Revoke permission in OS → next dispatch 410 → device auto-removed | | | |
| 10 | Log out → device disappears from list (`unregister_push_subscription`) | | | |
| 11 | Deactivate employee in Manage Users → queued pushes flip SKIPPED (never delivered) | server-side; verify via push_deliveries | | |
| 12 | Same account on 2+ devices → each gets exactly one notification per event | | | |
| 13 | Lock-screen content check: STAFF sees no price; test notification opens `/cai-dat` | | | |
| 14 | Unsupported browser (e.g. iOS in Safari tab, Firefox desktop pre-136 contexts) → clear "not supported" message, no prompts | | N/A | expected: push unavailable until installed |

Evidence rules: record device/OS/browser + screenshot per row. **iOS Web Push must never be
marked VERIFIED without a physical iPhone/iPad (iOS ≥ 16.4) over HTTPS with the app added to
the Home Screen** — simulators do not implement it.

## 5. Financial-safety guarantees (verified by tests)

* Push carries no authority: nothing in the flow writes `payments`, `sales` or `vehicles`.
  The notification bell + `/thong-bao` + VietQR verification remain the source of truth; if
  push dies the payment-verification workflow is byte-for-byte unchanged (regression-tested
  by `npm run test:db` suites bank-reconciliation/vietqr/payments).
* Offline mode cannot complete sales/payments: mutations require server round-trips; the
  NetworkGuard + disabled action buttons are UX only, the DB is the enforcement point.

## 6. Security & privacy assessment

* **Endpoints/keys are bearer secrets**: `push_subscriptions.endpoint|p256dh|auth` move only
  browser→RPC→Edge→DB. Both tables REVOKE from `public/anon/authenticated` with no policies;
  `list_my_push_devices` returns only a 6-hex hint; claim/complete/forget are `service_role`
  only (`SERVICE_ONLY` raise). Tested.
* **Payload minimality**: title/body are the pre-gated bell strings; parser rejects anything
  off-contract (`v:1`, ≤160/≤400 chars); deep links pass a whitelist (single leading `/`,
  no `//`, no `\`, no `..`, control chars stripped, ≤200) both server and client.
* **Sensitive data never cached**: the SW caches only build-time static assets (precached
  manifest) + 3 CacheFirst routes that provably exclude `/rest`, `/auth`, `/functions`,
  storage and signed URLs (asserted by `scripts/check-pwa.mjs` behavioral gate). Identity
  documents, prices and API responses are never written to Cache Storage/IndexedDB.
* **Auth after reconnection**: every RPC/Realtime call re-validates the JWT; SW update cannot
  smuggle old code (skipWaiting+clientsClaim; versioned cache names, `cleanupOutdatedCaches`).
* **Residual risks**: a compromised service key can send pushes (mitigated: content still comes
  from per-recipient gated rows); a malicious `VAPID_PRIVATE_JWK` secret rotation is a full
  deploy-privileged action — treat as production secret.

## 7. Cost & quota assessment

* Web Push itself is free (browser vendor push services carry the traffic; no paid tier).
* Supabase free/pro impact: 1 Edge Function invocation per sweep/batch (not per device),
  each ≤10 deliveries — realistically ≤ a handful/month at Cà Rem scale; well inside the
  Free Tier's 500k invocations. GitHub Actions cron (15 min, 1 request) is negligible.
* Vercel: no new bandwidth beyond the changed `sw.js` (~26 kB) in the precache; no edge
  middleware changes. Push providers (FCM/Mozilla push/APNs) impose no project cost.
* Rate limits respected: dispatcher caps 10 deliveries × 30 sends per invocation and lets the
  DB do backoff, so provider 429s cannot turn into retry storms.

## 8. Rollback instructions (forward-only)

1. **Stop dispatch** (instant, no schema loss): `supabase functions delete push-dispatch`
   or revoke its secrets → queued rows accumulate (harmless; bell unaffected, 30-day
   retention does not delete QUEUED rows, re-deploy resumes).
2. **Frontend**: revert to the previous Vercel deployment. Old `sw.js` re-activates through
   autoUpdate; push_deliveries rows simply stay in queue.
3. **User-facing kill switch**: `set_push_enabled(false)` per user, or deactivating a profile
   SKIPS their pending pushes at claim time.
4. **NEVER down-migrate** deployed schema. If push must be retired permanently, ship a forward
   migration that drops the trigger first (`enqueue_push_after_notification`) then the tables.

## 9. Known limitations (documented, not silent)

* iOS/iPadOS Web Push requires iOS ≥ 16.4 **and** Home-screen installation (handled by the
  `ios-install` guidance state in the Settings card and InstallHint banner).
* Desktop Safari (<16) has no Push API — the card shows "unsupported browser" instead of failing.
* Chromium background push delivery depends on the vendor relay; the 2-minute lease + reclaim
  covers dispatcher crashes mid-batch (verified in DB tests, not on hosted infra yet).
* Hosted Supabase runtime (JWT verification via GoTrue, PostgREST latency, real push providers)
  is exercised only by the local Deno smoke gates — first production send must be the
  "Gửi thử" flow on a staging project.
* No automated cron exists unless one of the §3 step-4 options is enabled; until then pushes drain on
  user activity (self-drain) — acceptable because the bell is the authoritative record.
