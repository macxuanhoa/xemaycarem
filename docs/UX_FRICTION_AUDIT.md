# UX Friction Audit — Xe CRM

Audited from the existing routed source on 2026-09-30. The business flow remains **Thu vào → Tồn kho → Chi phí / cập nhật → Bán ra**. Counts below describe the normal path and exclude optional fields; elapsed-time budgets are targets, not measured claims about staff productivity.

## Existing workflow evidence and friction

| Workflow              | Existing screens and normal interactions                                                                                                                              | Required typing / repeated data                                                                                                   | Waiting, confirmation and navigation friction                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                 | `/login`: username, password, Đăng nhập (3 interactions, plus optional remember selection)                                                                            | Username and password; browser-appropriate autocomplete already available                                                         | Username lookup, Auth, profile and server access checks must complete. These checks remain authoritative; convenience must not skip them.                                   |
| Thu xe                | `/acquisitions/new`: open form; type frame, brand, model, purchase amount for financial roles; submit (at least 6 interactions)                                       | Common brand/model/color manually retyped; 15 inputs visible across two cards for financial roles, including optional metadata                | Long mobile scroll to the final action. Duplicate frame found only after submission. No draft recovery. Server confirmation is required.                                    |
| Find vehicle          | Top bar → `/vehicles?q=…` or search palette → detail                                                                                                                  | Plate, frame, code, engine, brand/model; prior implementation already had a palette but no real request debounce                  | `useDeferredValue` delays rendering, not requests. Every changed query could issue another request. Keyboard result selection and role-aware commands were incomplete.      |
| Open vehicle / return | `/vehicles` → `/vehicles/:id` → inventory                                                                                                                             | Query persisted in URL; status, brand/date/price filters, sort and pagination were local component state                          | Layout scrolled to the top on every pathname change. Back lost local filters/page. Recent vehicles could be displayed, but successful detail loads did not record activity. |
| Add expense           | Vehicle → scroll to expense card → `/expenses?kind=vehicle&vehicle=…&new=1` → choose type, description, amount/date → save → return to vehicle (about 8 interactions) | Vehicle context existed in the URL, but the larger screen/picker still consumed attention. Common expense description typed again | Full page transition interrupted vehicle work. Existing quick modal was not connected; several chip categories did not match existing expense enums.                        |
| Sell vehicle          | Vehicle → `/vehicles/:id/sell` → customer, phone, amount/payment → confirm (about 5–7 interactions after selection)                                                   | Vehicle and asking price already preserved; date already defaults to Vietnam today; “Đã thu đủ tiền” already existed              | Money fields displayed raw digits; no remembered safe payment category. Server confirmation must remain deliberate.                                                         |
| View inventory        | `/vehicles`: query, status, sort, filters and pagination                                                                                                              | Re-entered filters after returning from detail                                                                                    | Loading replaced the whole list on changed query keys. Dashboard status/cost/age links were not read by the inventory page.                                                 |
| Recent transactions   | Dashboard → Bán ra or Thu vào → date/search filter → transaction/vehicle                                                                                              | Date/search context could be re-entered                                                                                           | Dashboard cards were clickable in the current worktree, but links did not consistently forward the selected reporting period.                                               |
| Vehicle photos        | Detail/form → choose photos → wait for sequential upload                                                                                                              | Select files again after failure                                                                                                  | Original size gate rejected phone photos above 5 MB before compression. No local preview or per-photo retry state; uploader blocked further selections.                     |

### Existing conveniences that were not complete

The worktree already contained `MoneyInput`, `AutocompleteInput`, `QuickChips`, `QuickExpenseModal`, image compression and recent-vehicle storage. Merely having these files did not make the routed workflows faster. The main forms/detail page did not consume them. Recent storage also used device-wide keys, so shared-device users could see another account’s history. The money parser stripped arbitrary characters and could turn a malformed or negative entry into another positive amount.

These concrete defects took priority over new gestures or visual redesign.

## Friction budget and proposed normal path

| Task                       | Budget                                             | Path after incremental convenience changes                                                              |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Find vehicle               | Under 3 seconds after entering a useful identifier | Focus search → type → select visible result; no mandatory Enter                                         |
| Open recently used vehicle | 1 tap                                              | “Xe vừa thao tác” → vehicle                                                                             |
| Add simple vehicle expense | Under 10 seconds                                   | Vehicle “+ Chi phí” → category chip → amount → save                                                     |
| Acquire normal vehicle     | Under 30 seconds                                   | Frame → plate if present → brand/model or suggestions → price → save; optional metadata stays available |
| Sell selected vehicle      | Under 20 seconds                                   | Customer → price/payment review → explicit server-confirmed sale                                        |
| Return to inventory        | No repeated query/filter work                      | Back restores URL filters, sort, page and saved position                                                |

## Implemented convenience boundaries

### Search, navigation and recent activity

- Search requests use a real debounce. Search matches the existing server-supported identifiers and permitted customer/transaction results.
- Inventory URL contains query, status, brand/year/date/price filters, sort, page, pending-cost and stock-age filters. This makes browser history and the detail “Tồn kho” link restore the same context.
- Cached previous inventory rows remain visible while a changed query is being fetched; an update message makes their state clear.
- Detail data is prefetched only on hover, focus or intentional touch.
- A successful detail load records actual vehicle activity using an authenticated user-specific key. Legacy device-wide recent records are ignored. No financial fields are copied into recents.
- Mobile cards keep the normal detail link and expose a visible “Thao tác” sheet. Sale only opens the normal sale form; no gesture or quick button executes a financial mutation.

### Forms and safe defaults

- Thu xe shows essential identity/brand/model/price/date/seller inputs first. Số máy, variant/year/color/km, asking price and notes remain in an accessible “Thông tin khác” disclosure.
- Brand/model/variant/color autocomplete derives from recent values and permitted recent store vehicles. Model/variant suggestions follow the selected brand. Chips are optional shortcuts; manual input remains available.
- Money input accepts normalized VND paste and supported shorthand, displays the interpreted value, and rejects negative, malformed, fractional raw VND and unsafe amounts. Persisted money remains an integer.
- Frame duplicate warnings appear after a 450 ms debounce and link to the existing record. This is advisory convenience; server uniqueness and permission checks still decide the transaction.
- Local drafts are versioned, user-specific and expire after seven days. They restore the form's full business content — specs, prices, seller/customer contacts and notes — so an interrupted entry resumes completely after an explicit resume or discard. Credentials, identity-document numbers, status, permissions and secrets stay excluded.
- Draft storage failure (private mode/quota) triggers close/reload loss protection and confirmation for an internal link that leaves the form; successful persistence never blocks navigation because the draft is restored next visit. The current BrowserRouter does not provide a blocker for a native Back action. Drafts are never described as completed transactions.
- Primary acquisition/edit/sale actions stay reachable on mobile. Dates use `Asia/Ho_Chi_Minh` and stay visible/editable.
- A successful acquisition opens the real vehicle with next actions: Thu xe tiếp, Thêm ảnh and permitted Chi phí. Success comes from the confirmed RPC, not an arbitrary query string.
- AI review handoffs, when explicitly selected by the user, prefill only safe structured acquisition fields. Purchase prices must be entered by the user. An expense handoff displays a review notice and requires the normal explicit save.

### Vehicle context and photos

- Detail “+ Chi phí” and the mobile vehicle sheet open the same compact form with a fixed vehicle ID. Existing `canManage` expense permissions remain unchanged; STAFF does not receive extra permissions for convenience.
- Expense chips map to the existing enum: Lốp/Nhớt → PARTS, Giấy tờ → PAPERWORK.
- Choosing a category supplies its description and focuses the amount. Date defaults to today. Repeating the previous expense restores only category/description and clears the amount.
- Modal focus stays inside the dialog, Escape closes a nonpending action, and focus returns to the opener. Pending financial submissions cannot be dismissed/repeated.
- Clipboard buttons copy frame, engine, plate, internal code and allowed supplier phone with explicit feedback.
- Vehicle photos show local previews immediately, compress before upload, queue in the background and expose a status/retry for each image. Another photo can be selected while uploads run. A before-unload warning protects pending uploads. Document images used by extraction are not automatically converted into vehicle photos.

## Validation

Source review covers all frequent workflows listed above. Automated validation is recorded in `docs/VERIFICATION.md`.

Meaningful convenience tests include:

- Scoped recent records and categorical values do not cross accounts; malformed/unavailable storage is handled.
- Permissions/status/secrets and identity numbers are excluded from reusable drafts; recent values never store amounts.
- Repeat expense does not store/reuse an amount.
- Strict money normalization rejects malformed/negative/unsafe values.
- Isolated mocked browser interactions cover mobile acquisition with a visible action, integer shorthand conversion, duplicate detection before submit, contextual expenses with valid enum values, repeat amount clearing, Escape/focus behavior and inventory return context.
- Browser timing checks use the budgets above against fixture interactions; they are regression checks rather than claims about a person’s typing speed. A fifth desktop regression checks Ctrl+K, recent vehicles, one debounced request while typing, and ArrowDown/Enter selection.

## Remaining verification and next increments

- Perform acceptance with actual store staff on a phone and desktop: search-as-you-type, acquisition, expense, sticky save, recent vehicle, quick sheet and back/forward. Record task durations without field contents.
- Verify compression readability using representative plate/frame photos. Device-specific camera/document quality needs real hardware.
- Expand suggestions beyond the recent 100 permitted store records only if real usage shows missing frequent values.
- Current duplicate convenience query reads up to 100 matching permitted results. Server validation remains the definitive check.
- Pending image uploads continue within the current browser session; there is no persistent offline upload queue across closing/restarting the app.
- Swipe/long press and image reordering are optional future shortcuts; visible actions already cover their useful tasks. They must never execute business lifecycle/financial changes directly.
- Lightweight anonymous timing/abandonment measurement can be added after a retention/consent decision. No sensitive field contents or employee surveillance telemetry is collected by this increment.
