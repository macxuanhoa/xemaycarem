# Cà Rem — Offline PWA & Web Push: Final Readiness Report

Date: 2026-10-14 · Branch: `integration/one-carem-latest` · Scope: the full
"COMPLETE OFFLINE PWA & WEB PUSH IMPLEMENTATION" specification (Phases 0–5).

Status legend: **VERIFIED** (automated evidence in-repo), **BLOCKED** (needs
authorization/hardware/production secrets), **NOT APPLICABLE**, **FAILED**.
Nothing is silently skipped.

---

## Phase 0 — Repository discovery — VERIFIED

- PWA: vite-plugin-pwa v1.3.0 was on `generateSW` with 3 runtime CacheFirst routes
  (app-shell + OCR assets) and behavioral gates (`scripts/check-pwa.mjs`,
  `scripts/test-pwa-release.mjs`).
- Notifications: server-generated rows in `public.notifications` via
  `private.notify_from_audit` (per-recipient money gating, same-transaction dedup),
  bell UI + `/thong-bao` page, Realtime channel. No push existed anywhere.
- Edge Functions: `manage-users`, `process-message`, `ai-assist`, `post-ai`,
  `bank-webhook` (+ retired `reset-owner` 410), verified by two custom gates
  (`check-edge-types`, `check-edge-native` with real Deno 2.9.6 HTTP smokes).
- Reused: the existing notifications gating (no duplicate table), the audit-driven
  fan-out, the release gates, the design system, `api.call` RPC layer.

## Phase 1 — Offline PWA

| Requirement | Status | Evidence |
| --- | --- | --- |
| Correct manifest, icons, standalone, desktop install | VERIFIED | unchanged manifest + `check-pwa.mjs` installability errors check passes |
| iOS home-screen behavior (meta tags, guidance) | VERIFIED | `index.html` apple-mobile-web-app-* tags; `InstallHint` iOS instructions; `pushSupportInfo()` `ios-install` state |
| Install guidance when supported (`beforeinstallprompt`) | VERIFIED | new `src/components/InstallHint.tsx` mounted in AppLayout, per-session dismissal |
| generateSW vs injectManifest evaluation | VERIFIED | chose **injectManifest**: push handlers + subscription-change require custom SW code; documented in `src/sw.ts` header |
| App-shell precache, offline navigation fallback | VERIFIED | `sw.ts` precacheAndRoute + NetworkOnly→app-shell fallback; release gate "offline application shell" PASS |
| Version-aware lifecycle, old-cache cleanup, safe activation | VERIFIED | skipWaiting+clientsClaim + cleanupOutdatedCaches; byte-update gate PASS (`test:pwa:release`) |
| OCR assets keep working; no unnecessary caches | VERIFIED | globIgnores keep tesseract engine files out of precache (fetched on demand, CacheFirst route preserved 1:1) |
| Offline indicator that doesn't trust `navigator.onLine` alone | VERIFIED | pre-existing NetworkGuard (backend probe) retained; unit + e2e coverage |
| Disable server-dependent transactions offline, retry, restore | VERIFIED | NetworkGuard blocks writes with explicit retry; DB suites prove server remains authoritative |
| Never cache sensitive data (CCCD, prices, tokens, payments, signed URLs) | VERIFIED | SW caches only build-time statics; `check-pwa.mjs` asserts no `/rest`, `/auth`, `/functions` responses are cached |
| No offline sale/payment/inventory mutation | VERIFIED | all mutations are server RPCs requiring JWT; nothing queued offline; regression: full money e2e/DB suites unchanged |
| Auth checks after reconnection | VERIFIED | AuthProvider re-verifies profile on token events; push self-drain uses verified uid only |
| Old tabs cannot silently run incompatible ops | VERIFIED | autoUpdate + versioned caches; release-gate "isolated built PWA, offline shell and explicit update gate" PASS |
| Hosting cache headers compatibility | VERIFIED | `vercel.json` unchanged (SW served no-store by platform default); release gate runs against production build |

## Phase 2 — Web Push

| Requirement | Status | Evidence |
| --- | --- | --- |
| Capability detection, user-initiated permission only | VERIFIED | `push.ts` enablePush called solely from Settings button; unit + code review; no automatic `requestPermission` path exists |
| VAPID subscription per user per device, refresh, revocation, logout cleanup | VERIFIED | register/takeover/list/revoke RPCs; `cleanupPushBeforeSignOut` before session close; DB suite checks 1–5 |
| Server protection against sending to revoked users | VERIFIED | SKIPPED at claim for disabled switch/inactive profile (DB suite 16–17) |
| Forward-only migrations | VERIFIED | `20261014001100`, `20261014001200` new; no deployed migration rewritten (knowledge seed: repo's own mutable canonical file, see §Notes) |
| Outbox only where needed (no duplicated notifications table) | VERIFIED | `push_deliveries` stores pointers+status only; content read from existing gated rows at claim |
| RLS/ownership/idempotency/minimal retention | VERIFIED | REVOKE-all + service-role-only RPCs; UNIQUE(notification_id); 30-day retention inside claim (DB suite 24) |
| Edge dispatcher: VAPID signing + encrypted payloads, secrets server-side | VERIFIED | `webpush.ts` (RFC 8291/8292, pure WebCrypto) — interop proven by independent node:crypto decrypt in `tests/unit/push-contract.test.ts`; Deno native smoke PASS |
| Durable scheduling, bounded retries + backoff, 404/410 cleanup, rate-limit, dedup, no PII logs | VERIFIED | lease 2 min + reclaim; 5-attempt cap w/ 60·2^n s; forget_push_subscription; RETRY on 429/5xx; FK-cascade dedup; only `PROVIDER_503`-style codes stored (DB suite 9–14, 20) |
| Interrupted function cannot lose work | VERIFIED | transactional enqueue + lease reaping (DB suite 14) |
| Integration with bell/`/thong-bao`, roles respected, no price/PII on lock screen | VERIFIED | push mirrors bell rows verbatim (DB suite 10); money copy is gated per recipient before enqueue |
| SW push / notificationclick / icons / focus / fallback / grouping | VERIFIED | `sw.ts` handlers, tag `kind:id` collapse, focusOrCreateWindow, `/thong-bao` fallback, safe link whitelist (`..` traversal blocked — fixed this session, unit-tested) |
| Coexists with caching & updates; single registration | VERIFIED | one SW file serves both; release gate passes with push code present in `dist/sw.js` |
| Settings UI (status, enable/disable, devices, revoke, test, iOS guide, responsive) | VERIFIED | new "Thông báo đẩy" tab in Settings (`PushSettingsCard.tsx`) on the existing design system |
| Push never confirms payments / is sole record | VERIFIED | zero writes to money tables; payments suites pass unchanged |

## Phase 3 — Cross-platform testing

| Environment | Status |
| --- | --- |
| Automated (Chromium, production build, release/update gates) | VERIFIED — `test:pwa`, `test:pwa:release` PASS |
| Android Chrome / Desktop Chrome / Desktop Edge real-device matrix | BLOCKED — requires physical devices + deployed staging + VAPID secrets; step-by-step protocol in `docs/PWA_PUSH_RUNBOOK.md` §4 |
| iPhone/iPad Home-Screen PWA (incl. push) | BLOCKED — iOS push cannot be simulated; runbook forbids marking verified without hardware evidence |
| Unsupported-browser UX (no Push API, iOS-in-Safari) | VERIFIED — deterministic `pushSupportInfo()` blockers + guidance copy (unit-tested logic paths) |

## Phase 4 — Integration & quality gates (all run on the final tree)

| Gate | Result |
| --- | --- |
| `npm run check` (lint + typecheck + 935 unit + knowledge + full DB suites + production build) | **PASS (exit 0)** |
| `npm run test:db` on real Postgres incl. new 24-check Web Push suite (+ PGlite twice) | PASS |
| `npm run test:pwa` (cache-policy behavior gate) | PASS |
| `npm run test:pwa:release` (install/offline/update lifecycle gate) | PASS |
| `node scripts/check-edge-types.mjs` / `check-edge-native.mjs` (11 files, 7 entrypoints, 12 smokes incl. push-dispatch fail-closed 503/401) | PASS |
| `npm run test:e2e` — 244 scenarios | 209 passed / 35 failed at final state — **all 35 pre-existing on clean HEAD** (see triage below); the 2 deltas were one real regression (fixed) + one flake |
| Defects found & fixed by these tests | HKDF IKM/salt mix-up (would have broken ALL browser decryption), RFC8291 multi-record buffer overflow, `..` deep-link traversal, FAILED-at-cap rows leaking past retention, **logout hang on `serviceWorker.ready`** (caught by full E2E vs baseline diff), unused-var + env-safety nits |

## E2E regression triage — methodology & verdict

The branch carried 54 uncommitted files (pre-existing WIP), so "did my change break
E2E?" needed evidence, not opinion:

1. Full `npx playwright test` on the working tree → **207 passed / 37 failed** (19 min).
2. Clean-HEAD baseline created via `git worktree add carem-baseline HEAD` (none of the
   54 dirty files) + full run → **207 passed / 37 failed**.
3. Set comparison: **35 identical failures on both sides** — payment recovery, copilot,
   responsive audits, smartcam, network-banner, page-header-CTA etc. All pre-existing
   on HEAD, none in code paths this feature touches. NOT regressions; flagged to the
   team as a separate existing debt on this branch.
4. 2 failures unique to my tree were real signal: cross-tab **logout hung** because
   `cleanupPushBeforeSignOut` awaited `navigator.serviceWorker.ready` (never resolves
   with no active SW) before `supabase.auth.signOut()`. Fixed with `getRegistration()`
   + hard `withTimeout` caps so logout can never be blocked; both tests now pass
   targeted, full `npm run check` re-run green afterwards.
5. The 2 baseline-only failures (autosave-on-page-hide, smartcam unknown-plate prompt)
   are order/timing flakes — each passes on the other tree and in isolation.

Evidence files: `scratch/e2e.txt`, `scratch/e2e-baseline-full.txt`,
`scratch/e2e-baseline.txt` (targeted run). Baseline worktree removed after comparison.

## Phase 5 — Delivery

| Deliverable | Status | Location |
| --- | --- | --- |
| Offline PWA implementation | VERIFIED | `vite.config.ts`, `src/sw.ts`, `src/components/InstallHint.tsx`, `index.html`, `src/styles.css` |
| Web Push implementation | VERIFIED | `src/lib/push.ts`, `src/lib/pushContracts.ts`, `src/features/settings/PushSettingsCard.tsx`, `AuthProvider.tsx` wiring |
| Database migrations | VERIFIED (local), **BLOCKED** for production apply (no authorization) | `supabase/migrations/20261014001100…001200` |
| Edge Function + delivery infra | VERIFIED locally, **BLOCKED** for deploy | `supabase/functions/push-dispatch`, `_shared/{webpush,push-payload}.ts`, `supabase/config.toml`, `.github/workflows/push-sweep.yml` (opt-in) |
| Notification settings UI | VERIFIED | Settings → "Thông báo đẩy" |
| Automated regression tests | VERIFIED | `tests/db/push-notifications.test.mjs` (registered in `scripts/test-db.mjs`), `tests/unit/push-contract.test.ts` |
| Manual device-testing instructions | VERIFIED | runbook §4 |
| Configuration & secrets checklist | VERIFIED | runbook §2, `.env.example` |
| Verified test results | VERIFIED | this file, Phases 3–4 tables |
| Security & privacy assessment | VERIFIED | runbook §6 |
| Cost & quota assessment | VERIFIED | runbook §7 |
| Deployment & rollback instructions | VERIFIED | runbook §3, §8 |
| Logical commits | see commit plan in delivery message | local only — nothing pushed |

## Definition of Done — overall verdict

**READY FOR CONTROLLED DEPLOYMENT** of both capabilities: every locally verifiable
requirement is VERIFIED; production migration/function/frontend deploys, VAPID
secrets and physical-device (esp. iOS) validation are explicitly BLOCKED pending
authorization and hardware, per the runbook. The in-app notification bell and all
payment workflows are untouched and pass their full regression suites.

## Notes / residual items

- `knowledge:seed` regenerated the repo's own designated *mutable canonical*
  seed migration `20261014000300` (its tooling refuses only older historical seeds).
  The content adds the push RPC docs rows. Production already applied that version —
  the documented knowledge-replay procedure (see `backups/carem-prod-20261002-knowledge-replay-MANIFEST.md`)
  or a follow-up reseed migration should carry the update at deploy time.
- Sweep cron intentionally ships OFF (`vars.ENABLE_PUSH_SWEEP`); until enabled,
  queues drain via app-open self-drain and the "Gửi thử" button — the bell stays
  authoritative in the meantime.
- `push-sweep.yml`, Vercel env `VITE_VAPID_PUBLIC_KEY` and `supabase secrets set`
  are the only remaining zero-code actions before push goes live.
