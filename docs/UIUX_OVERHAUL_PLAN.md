# Cà Rem CRM — UI/UX controlled implementation plan

Date: 2026-10-07. Status: read-only source audit complete enough to prepare baseline; visual confirmation and regression gates pending.

## Authorization and recovery

- Human authorized `release/xe-crm-v1` in this thread. Starting HEAD `7a4cbd6`; initial Git status clean.
- Other same-project Codex task observed idle; three delegated auditors are read-only. Root is the sole implementation writer. Recheck Git before each implementation batch; stop on unexpected drift.
- Recoverable tracked-source checkpoint: `backups/carem-uiux-baseline-20261007-7a4cbd6.zip`, SHA256 `A5EB56796C678C903413D6B795020867626AE83F15C100BA61A88F1E5A6B7198`. Ignored secrets and production backups are excluded.
- No production access/writes, migration changes, commits, pushes or deployments are authorized.

## Architecture and reuse

React 19 / Vite 7 / TypeScript, lazy React Router routes, React Query, React Hook Form + Zod; central `src/styles.css` and existing theme tokens. Existing `PageHeader`, `Card`, `Field`, `Badge`, `DateRange`, `EmptyState`, `Loading`, `ErrorState`, `MoneyInput`, `ConfirmDialogHost`, `Toaster`, `GlobalSearchPalette`, `useDialog`, `useMobileDrawer` are the design-system foundation. Refine these rather than add parallel equivalents for the requested component names. Keep form actions in normal document flow where existing tests explicitly require that. Dark mode is supported.

## Evidence boundaries

The ten referenced real iPhone screenshots were not attached to this conversation and were not found among repository image assets. Do not attribute any defect or unusual record to those screenshots. Baseline/after captures use fictional local fixtures and desktop browser engines; keyboard-height simulation is not an iOS virtual keyboard or hardware certification. Source findings, runtime measurements and visual observations must have distinct labels.

## File-level batches (only after baseline capture)

| Batch         | Files                                                                                                                         | Intended change                                                                                                                                                         | Protected workflow / validation                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared/search | `src/components/search/GlobalSearchPalette.tsx`, `src/layouts/AppLayout.tsx`, `src/lib/useDialog.ts`, `src/styles.css`        | Mobile search overlay, dismiss/focus/scroll behavior, viewport bounds, desktop-only shortcut hints, correct sale/intake active navigation, safe-area and compact tokens | Existing global_search RPC, permissions, camera/QR, recent vehicles, route shortcuts; keyboard/focus and drawer tests                                             |
| Copilot       | `src/features/copilot/CopilotPage.tsx`, `src/features/copilot/CitationLinks.tsx`, `src/styles.css`                            | Compact composer/history; human-readable sources and collapsible evidence; distinguish reporting period from current stock                                              | Do not modify answer server contracts, facts, provider permissions, draft actions or sanitization; Copilot unit/e2e/security tests                                |
| Vehicle       | `src/features/vehicles/VehicleDetailPage.tsx`, `src/styles.css`                                                               | Compact identity/details, missing-value wrapping and copy affordances                                                                                                   | Keep financial gating, photos, every business action; mobile-detail and hard-delete tests                                                                         |
| Sale/money    | `src/components/ui/MoneyInput.tsx`, `src/features/sales/SellVehiclePage.tsx`, `src/components/ui/index.tsx`, `src/styles.css` | Clear payment/debt summary and full-payment control; actual sale confirmation and accessible validation/focus                                                           | Preserve schema limits, arithmetic, executeOperation, request IDs, recovery and sensitive-draft rules; interaction tests before changing malformed-input handling |
| Intake        | `src/features/acquisitions/AcquisitionsPage.tsx`, `src/features/intake/ShorthandIntakePage.tsx`, `src/styles.css`             | Distinguish intake routes and compact filters/cards only when evidence demonstrates a gap                                                                               | Existing Smart Camera and transaction/import protocol unchanged; acquisition and shorthand tests                                                                  |
| Test safety   | `tests/helpers/db-safety.ts`, `tests/security/production-safety.test.ts`                                                      | If reproduced: fail closed for nonlocal PG URLs; current catch swallows its own safety error                                                                            | Test-only change; no DB contracts or production connections                                                                                                       |
| Evidence      | `tests/e2e/uiux-responsive.spec.mjs`, local capture harness, `docs/UIUX_OVERHAUL_AUDIT.md`                                    | Reproducible responsive, accessibility, long/empty, before/after and release report                                                                                     | Mock all external business transport; disposable native PG for existing transactional/RLS regression                                                              |

## Mandatory gates

1. Baseline before any application edits; capture all major routes and focused states at 320/360/375/390/430px plus desktop.
2. TypeScript, ESLint, all existing Vitest unit/integration/security suites.
3. Full native disposable-PostgreSQL database replay/RLS/concurrency regression (never hosted DB).
4. Full Playwright against a new server with explicit placeholder Supabase env and no server reuse collision.
5. Explicit focus/error/confirmation/no-write checks, long strings, empty data, dark mode; after captures for every changed screen.
6. Build/PWA update and offline checks using fixture configuration. Record command results, screenshots, source diff size and limitations. Real iOS Safari/Android Chrome remain unverified unless hardware is actually available.

## Initial priorities (visual audit pending)

- P1: mobile search keyboard/scroll bounds; money input malformed-text interpretation and invalid-field focus; missing sale review confirmation; ambiguous current-stock period; opaque citation IDs.
- P2: duplicated evidence presentation; composer/history density; vehicle detail density/copy feedback; intake route terminology and filter spacing.
- P1 test infrastructure: PostgreSQL safety assertion catches its own nonlocal-host rejection (reproduce before correction).
- No confirmed P0 in the inspected scope. No assertion that production contains no P0.
