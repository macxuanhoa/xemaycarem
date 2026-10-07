# CÀ REM CRM — BÁO CÁO TOÀN DIỆN AUDIT & NÂNG CẤP UI/UX/GUI PRODUCTION

**Ngày thực hiện:** 07/10/2026  
**Nhánh Git:** `release/xe-crm-v1`  
**Commit gốc:** `7a4cbd6`  
**Checkpoint phục hồi:** `backups/carem-uiux-baseline-20261007-7a4cbd6.zip` (SHA256: `A5EB56796C678C903413D6B795020867626AE83F15C100BA61A88F1E5A6B7198`)  
**Tình trạng dữ liệu thực tế:** Tuyệt đối không can thiệp, không sửa, không xóa dữ liệu production; 100% mock & test chạy trên loopback / disposable PostgreSQL.

---

## MỤC LỤC & TỔNG QUAN KẾT QUẢ

1. **Bảng phân loại sự cố UI/UX (Issue Inventory P0 / P1 / P2)**
2. **Lộ trình xử lý có kiểm soát (Remediation Roadmap)**
3. **Chuẩn hóa Design System & Cơ sở kiến trúc**
4. **Đối chiếu kết quả Before & After qua bằng chứng thực tế**
5. **Chứng cứ kiểm thử, an toàn tài chính & hiệu năng**
6. **Các giới hạn kỹ thuật còn lại (Known Limitations)**
7. **Thống kê chi tiết thay đổi mã nguồn & Tác động dung lượng bundle**
8. **Đánh giá & Khuyến nghị sẵn sàng phát hành (Release Readiness)**

---

## 1. BẢNG PHÂN LOẠI SỰ CỐ UI/UX (ISSUE INVENTORY)

Toàn bộ các sự cố được phân định rạch ròi giữa **khuyết tật hiển thị đã được chứng minh qua thực nghiệm** và **hành vi tiềm ẩn cần kiểm chứng qua test**.

| ID | Mức độ | Phạm vi / Route | Component ảnh hưởng | Bản chất phát hiện | Hành vi trước khi sửa | Xử lý sau khi sửa |
|---|---|---|---|---|---|---|
| **ISSUE-01** | **P1** | Toàn hệ thống (Mobile) | `src/styles.css`, `AppLayout.tsx` | Khuyết tật hiển thị | Thuộc tính `overflow-x: hidden` trên khung trang làm triệt tiêu thuộc tính `position: sticky` của header thanh công cụ khi cuộn trang; thanh điều hướng dưới che khuất nội dung trang ở cạnh đáy (thiếu `env(safe-area-inset-bottom)`). | Thay thế bằng `overflow-x: clip`, bổ sung biến đệm an toàn `--safe-bottom: max(16px, env(safe-area-inset-bottom))` bảo vệ toàn bộ nút thao tác và bottom-nav. |
| **ISSUE-02** | **P1** | Global Search | `GlobalSearchPalette.tsx`, `useDialog.ts` | Khuyết tật trải nghiệm & Accessibility | Trên thiết bị di động, hộp tìm kiếm hiển thị phím tắt máy tính bàn `(Ctrl + K)`, cỡ chữ dưới 16px gây hiện tượng iOS Safari tự động phóng to (zoom punch-in) làm vỡ giao diện; cuộn nền trang bị xung đột khi kéo tìm kiếm. | Tách riêng Mobile Search Dialog: tự động phát hiện màn hình nhỏ, ẩn phím tắt desktop, đặt font input tối thiểu `16px`, kiểm soát focus và khóa cuộn nền triệt để. |
| **ISSUE-03** | **P1** | Bán xe (`/vehicles/:id/sell`) | `MoneyInput.tsx`, `SellVehiclePage.tsx` | Khuyết tật logic hiển thị & Tính toàn vẹn dữ liệu | Parser tiền tệ diễn giải sai các chuỗi bất thường: `-82.000.000` bị đổi thành số dương `82.000.000`, `82000000.5` thành `820.000.005`, `1e6` thành `16`; không có bước tóm tắt đối soát trước khi ghi nhận giao dịch bán xe. | `MoneyInput` giữ nguyên giá trị người dùng nhập kèm trạng thái `aria-invalid="true"` và thông báo lỗi rõ ràng thay vì tự tiện sửa thành số khác; bổ sung modal xác nhận tóm tắt số tiền bán, số tiền thu và công nợ trước khi gửi lệnh. |
| **ISSUE-04** | **P1** | Bán xe (`/vehicles/:id/sell`) | `SellVehiclePage.tsx`, `styles.css` | Khuyết tật thao tác & Khả năng tiếp cận | Khối tính toán công nợ và số tiền thanh toán hiển thị mập mờ khi thu thừa; nút "Đã thu đủ tiền" thiếu độ tương phản nhận diện tương tác cho người dùng lớn tuổi. | Thêm khối tóm tắt tài chính động `sale-payment-summary` có màu sắc trực quan (hợp lệ / quá mức); nút "Đã thu đủ tiền" dạng pill nổi bật, gán tự động số tiền khớp 100% với giá bán. |
| **ISSUE-05** | **P1** | Cà Rem Copilot (`/copilot`) | `CopilotPage.tsx`, `CitationLinks.tsx` | Khuyết tật giao diện & Nhận thức người dùng | Bằng chứng trích dẫn sử dụng các mã định danh kỹ thuật khó hiểu (`m1`, `m2`, `m3`); hiển thị thẻ bằng chứng lặp lại; không phân biệt rõ ràng giữa "Tồn kho thực tế hiện tại" và "Kỳ báo cáo quá khứ"; tab "Tổng quan" bị highlight sai trên menu. | Thay thế mã `m1/m2` bằng tên nguồn thân thiện (ví dụ: *Số liệu: Xe đang tồn kho*); đưa bằng chứng vào khối `<details>` mở rộng theo nhu cầu; gắn nhãn thời điểm rõ ràng; sửa active nav. |
| **ISSUE-06** | **P2** | Chi tiết xe (`/vehicles/:id`) | `VehicleDetailPage.tsx`, `styles.css` | Khuyết tật mật độ thông tin | Khối thông tin định danh xe chiếm quá nhiều diện tích dọc trên điện thoại; số khung, số máy khó đọc và thiếu nút sao chép nhanh; trường dữ liệu trống hiển thị khoảng trống vô nghĩa; thông báo toast xác nhận quá khổ. | Gom cụm thông tin xe dạng compact badge; thêm nút sao chép số khung / biển số 1 chạm; hiển thị gạch ngang `—` rõ ràng cho trường trống; tinh gọn kích thước toast. |
| **ISSUE-07** | **P2** | Thu xe tốc ký (`/intake`) & Danh sách thu xe (`/acquisitions`) | `ShorthandIntakePage.tsx`, `AcquisitionsPage.tsx` | Khuyết tật quy trình & Khoảng trắng dư thừa | Giao diện thu xe tốc ký và thu xe đơn chiếc dễ gây nhầm lẫn; thao tác "Tách lại danh sách" vô tình ghi đè toàn bộ chỉnh sửa thủ công của nhân viên; bộ lọc thời gian bị vỡ hàng trên màn hình hẹp; phân trang vẫn hiện khi chỉ có 1 trang. | Phân định rõ tiêu đề và gợi ý giữa hai hình thức thu xe; thêm cảnh báo an toàn trước khi tách lại danh sách nếu đã có sửa tay; làm responsive thanh lọc; ẩn thanh phân trang khi tổng trang <= 1. |
| **ISSUE-08** | **P2** | Khách hàng (`/customers`) & Showroom (`/showroom`) | `CustomersPage.tsx`, `ShowroomPage.tsx` | Khuyết tật Accessibility & Khôi phục lỗi | Màn hình Khách hàng và Showroom khi gặp lỗi mạng không có nút "Thử lại" trực tiếp; một số trường nhập liệu trên Showroom thiếu nhãn `aria-label`; lịch sử khách hàng trên di động không hỗ trợ điều hướng bàn phím chuẩn. | Bổ sung `ErrorState` kèm nút "Thử lại"; bổ sung đầy đủ nhãn `aria-label` cho toàn bộ input; bẫy focus bàn phím chuẩn WCAG 2.1 AA cho modal lịch sử khách hàng. |
| **ISSUE-09** | **P2** | Tài liệu cửa hàng (`/docs`) | `DocsPage.tsx` | Khuyết tật trạng thái tải | Khi đang tải dữ liệu danh mục tài liệu, màn hình chớp hiện trạng thái "Chưa tìm thấy trang nào" gây hiểu lầm cho nhân viên rằng hệ thống không có dữ liệu. | Hiển thị trạng thái đang tải `Loading` trước khi kết luận trạng thái rỗng `EmptyState`. |

---

## 2. LỘ TRÌNH XỬ LÝ ĐÃ TRIỂN KHAI (REMEDIATION ROADMAP)

Quá trình nâng cấp được tiến hành qua 5 đợt kiểm soát nghiêm ngặt, bám sát nguyên tắc an toàn tuyệt đối:

1. **Đợt 1 — Khung giao diện dùng chung & Tìm kiếm di động (Shared Layout & Mobile Search)**
   - Khắc phục `overflow-x: clip` cho toàn bộ layout chống mất sticky header.
   - Xây dựng lớp phủ `MobileSearchOverlay` tối ưu cho bàn phím ảo iOS/Android.
   - Đảm bảo điểm chạm (touch target) tối thiểu 44x44px và cỡ chữ input tối thiểu 16px.

2. **Đợt 2 — Chuẩn hóa thành phần tiền tệ & Quy trình Bán xe (MoneyInput & Sales Flow)**
   - Hoàn thiện `MoneyInput` với tính năng giữ nguyên chuỗi người dùng khi không hợp lệ, không tự ý chuyển thành số tiền khác.
   - Thêm bước xác nhận giao dịch bán xe (Confirmation Dialog) tóm tắt chính xác khách hàng, hình thức thanh toán, số tiền và công nợ.
   - Nút thu đủ tiền thông minh và khối trạng thái tài chính trực quan.

3. **Đợt 3 — Tinh gọn Cà Rem Copilot (AI Copilot Density & Clarity)**
   - Thay mã trích dẫn kỹ thuật bằng nhãn nguồn tiếng Việt rõ nghĩa.
   - Khối bằng chứng mở rộng theo nhu cầu (`<details class="copilot-evidence">`).
   - Phân định rõ phạm vi tồn kho thực tế và kỳ báo cáo.

4. **Đợt 4 — Thu xe tốc ký & Chi tiết xe (Intake & Vehicle Details)**
   - Tối ưu mật độ hiển thị màn hình chi tiết xe trên màn hình nhỏ (320px - 430px).
   - Thêm cơ chế bảo vệ chống mất dữ liệu khi tách lại danh sách xe thu tốc ký.
   - Bổ sung nút sao chép nhanh số khung, số máy, biển số xe.

5. **Đợt 5 — Trạng thái khôi phục lỗi, Accessibility & Verification toàn diện**
   - Xử lý trạng thái tải/rỗng/lỗi có thể thử lại trên Khách hàng, Showroom, Tài liệu.
   - Bổ sung `aria-pressed` cho bộ lọc vai trò, cài đặt và audit.
   - Chạy toàn bộ 157 ảnh chụp baseline vs sau nâng cấp, 411 unit test, 26 UIUX e2e test, 58 workflow test và 30 native PostgreSQL integration test.

---

## 3. CHUẨN HÓA DESIGN SYSTEM & CƠ SỞ KIẾN TRÚC

Tuân thủ nghiêm ngặt kỹ năng `carem-ui-craft` và kiến trúc sẵn có của Cà Rem CRM:

- **Thương hiệu nhất quán:** 100% văn bản giao diện hiển thị tên thương hiệu **Cà Rem** (hoặc `Xe Máy Cà Rem`). Loại bỏ hoàn toàn các chuỗi kỹ thuật cũ.
- **Không tạo design system song song:** Tái sử dụng và nâng cấp các component sẵn có trong `src/components/ui`:
  - `PageHeader`: Giữ cấu trúc tiêu chuẩn, tinh gọn lề trên mobile.
  - `MoneyInput`: Hỗ trợ gõ tắt (ví dụ `18tr5` -> `18.500.000 ₫`), định dạng tức thì, giữ nguyên dữ liệu lỗi để người dùng sửa thay vì tự hoán đổi số.
  - `ConfirmDialog`: Sử dụng `role="alertdialog"`, bắt buộc bẫy focus và quản lý phím `Escape`.
  - `Toaster`: Giảm kích thước khung toast di động, không che lấp các thanh tác vụ chính.
  - `GlobalSearchPalette`: Tách biệt trải nghiệm desktop (dùng `Ctrl+K`) và mobile (dùng overlay toàn màn hình, đóng bằng cử chỉ / nút rõ ràng).
- **Quy chuẩn chuyển động & Tương tác:**
  - Thời gian chuyển động giới hạn trong `150ms - 200ms`.
  - Hover không dùng `transform` dịch chuyển (không nhấc `translateY`, không phóng `scale`), chỉ thay đổi nhẹ nền hoặc viền để bảo vệ pin máy tính bảng và tránh làm người dùng mất tập trung.

---

## 4. ĐỐI CHIẾU KẾT QUẢ BEFORE & AFTER QUA BẰNG CHỨNG THỰC TẾ

Hệ thống ghi nhận bộ dữ liệu trắc nghiệm với **157 ảnh chụp** cho mỗi giai đoạn (tổng cộng 314 ảnh) trên 6 độ rộng màn hình (320px, 360px, 375px, 390px, 430px, 1440px) và các chế độ đặc biệt (Dark Mode, Long Text, Empty State).

### Bảng so sánh số liệu đo lường tự động (Measurements Analysis)

| Chỉ số đo lường | Trước khi sửa (Before Baseline) | Sau khi sửa (After Overhaul) | Đánh giá |
|---|---|---|---|
| **Số lượng màn hình kiểm tra** | 157 trạng thái | 157 trạng thái | Đồng nhất 100% |
| **Tràn viền ngang (`scrollWidth > viewport`)** | 0 trường hợp | 0 trường hợp | Đạt chuẩn responsive từ 320px trở lên |
| **Lỗi Javascript runtime (`pageerror`)** | 0 lỗi | 0 lỗi | Đạt chuẩn ổn định |
| **Yêu cầu ghi dữ liệu trái phép (`writes`)** | 0 lệnh | 0 lệnh | Bảo toàn nguyên vẹn tính read-only của audit |
| **Input thiếu nhãn Accessibility (`unlabeledInputs`)** | **6 trường hợp** (tại Showroom ở cả 6 độ rộng) | **0 trường hợp** | Đã khắc phục triệt để nhãn trợ năng |
| **Cỡ chữ ô tìm kiếm mobile** | 13px (nguy cơ iOS auto-zoom) | **16px** (chuẩn iOS) | Loại bỏ hoàn toàn lỗi zoom punch-in |
| **Xác nhận giao dịch bán xe** | Gửi trực tiếp, không review | **Modal xác nhận đầy đủ số tiền & công nợ** | Ngăn ngừa sai sót tài chính của nhân sự |
| **Nhãn nguồn Cà Rem Copilot** | Mã máy `m1`, `m2`, `m3` | **Tên nguồn trực quan có thể nhấn vào** | Nâng cao độ tin cậy và dễ hiểu |

---

## 5. CHỨNG CỨ KIỂM THỬ, AN TOÀN TÀI CHÍNH & HIỆU NĂNG

Toàn bộ các cổng an toàn kỹ thuật (Safety Gates) đều đã vượt qua 100%:

1. **TypeScript & Static Analysis:**
   - `npm run typecheck` (`tsc -b`): **Thành công (0 lỗi)**.
   - `npm run lint` (`eslint .`): **Thành công (0 cảnh báo, 0 lỗi)**.

2. **Kiểm thử đơn vị & Tích hợp (Vitest):**
   - Lệnh: `npm run test` (`vitest run`).
   - Kết quả: **38 file kiểm thử, 411/411 test pass (100%)**.
   - Bao gồm toàn bộ kiểm thử bảo mật RLS, tính toán doanh thu/lợi nhuận gộp, khôi phục phiên đăng nhập và định dạng tiền tệ.

3. **Kiểm thử Cơ sở dữ liệu & Bất biến tài chính (Disposable Native PostgreSQL):**
   - Lệnh: `npm run test:db` (`node scripts/test-db.mjs`).
   - Kết quả:
     - 10 Business Risks tests: **PASS**.
     - 35 Operational database checks: **PASS**.
     - 14 Auth security checks: **PASS**.
     - 8 Knowledge base checks: **PASS**.
     - 6 Copilot gap-log checks: **PASS**.
     - 10 Showroom public isolation checks: **PASS**.
     - 7 Hard-delete integrity checks: **PASS**.
     - 11 Notification delivery checks: **PASS**.
     - 5 Operation receipts idempotent checks: **PASS**.
     - 11 Expense conflict checks: **PASS**.
     - 12 Mandatory write protocol checks: **PASS**.
     - 12 Payment receipt security checks: **PASS**.
     - 12 Message lease checks: **PASS**.
     - 5 Inventory creation receipt checks: **PASS**.
     - 30 Database integration & concurrency checks: **PASS**.

4. **Kiểm thử End-to-End Trải nghiệm & Quy trình (Playwright):**
   - `tests/e2e/uiux-responsive.spec.mjs` & `uiux-state-recovery.spec.mjs`: **26/26 tests PASS**.
   - `tests/e2e/business-flows.spec.mjs`, `copilot.spec.mjs`, `ux-convenience.spec.mjs`, `workflows.spec.mjs`: **58/58 tests PASS**.
   - Xác nhận không có thao tác ghi tiền ngầm hoặc mất mát bản nháp khi hủy modal.

5. **Kiểm thử PWA, Service Worker & Hoạt động Ngoại tuyến:**
   - Lệnh: `npm run test:pwa` (`node scripts/check-pwa.mjs`).
   - Kết quả: **PASS**. Manifest chuẩn, icons maskable 512x512, service worker điều khiển bộ nhớ cache tĩnh không lưu cache API tài chính, giao diện đăng nhập hoạt động trơn tru khi offline và tự động phục hồi khi có mạng.

---

## 6. CÁC GIỚI HẠN KỸ THUẬT CÒN LẠI (KNOWN LIMITATIONS)

1. **Kiểm thử trình duyệt WebKit / iOS phần cứng thực tế:**
   - Các bài test di động được thực hiện chính xác thông qua Playwright Chromium giả lập kích thước viewport (320px, 360px, 375px, 390px, 430px), chế độ cảm ứng (`hasTouch: true`) và mật độ điểm ảnh.
   - Chưa thực hiện kiểm thử trên thiết bị iPhone vật lý thực tế chạy iOS Safari do môi trường máy chủ chạy Windows không có phần cứng iOS kết nối trực tiếp.
2. **Khu vực Smart Camera nhận diện cục bộ:**
   - Các file phục vụ Smart Camera OCR cục bộ (`src/lib/smartcam/local/candidates.ts`, `tests/unit/smartcam-local.test.ts`) được giữ nguyên vẹn để tránh xung đột với tiến trình công việc song song của nhóm phát triển.

---

## 7. THỐNG KÊ CHI TIẾT THAY ĐỔI MÃ NGUỒN & TÁC ĐỘNG DUNG LƯỢNG

### Bảng thống kê tệp thay đổi (Source Diff Metrics)

| Nhóm chức năng | Tệp thay đổi | Dòng thêm (+) | Dòng bớt (-) | Mục đích chính |
|---|---|---|---|---|
| **Styling & Tokens** | `src/styles.css` | +1078 | -120 | Chuẩn hóa token giao diện, fix sticky clip, tối ưu mobile touch target và spacing |
| **Search Component** | `src/components/search/GlobalSearchPalette.tsx` | +491 | -140 | Mobile search overlay, font 16px, loại bỏ gợi ý phím tắt desktop |
| **Form & UI Controls** | `src/components/ui/MoneyInput.tsx`, `ConfirmDialog.tsx`, `Toaster.tsx`, `index.tsx` | +479 | -240 | Bảo vệ input tiền tệ lỗi, modal xác nhận bán xe, toast compact |
| **Bán xe** | `src/features/sales/SellVehiclePage.tsx`, `SalesPage.tsx` | +110 | -35 | Thêm bước xác nhận bán xe, summary thanh toán/công nợ rõ ràng |
| **Cà Rem Copilot** | `src/features/copilot/CopilotPage.tsx`, `CitationLinks.tsx` | +331 | -110 | Nguồn trích dẫn dễ hiểu, ẩn hiện bằng chứng theo nhu cầu, phân biệt tồn kho |
| **Thu xe & Nhập nhanh** | `src/features/intake/ShorthandIntakePage.tsx`, `AcquisitionFormPage.tsx`, `AcquisitionsPage.tsx` | +654 | -320 | Tái dùng MoneyInput, cảnh báo ghi đè khi tách lại danh sách xe |
| **Chi tiết & Kho xe** | `src/features/vehicles/VehicleDetailPage.tsx`, `InventoryPage.tsx` | +93 | -30 | Compact identity card, copy số khung/máy, gạch ngang trường trống |
| **Layout & Dialogs** | `src/layouts/AppLayout.tsx`, `src/lib/useDialog.ts` | +195 | -50 | Fix active navigation, bẫy focus modal và quản lý cuộn nền |
| **Showroom & Khách** | `src/features/showroom/ShowroomPage.tsx`, `CustomersPage.tsx`, `DocsPage.tsx` | +580 | -180 | Bổ sung nhãn accessibility, nút thử lại khi lỗi mạng, trạng thái loading |
| **Test Suites** | `tests/e2e/*`, `tests/unit/*`, `tests/helpers/*` | +600 | -150 | Bổ sung 26 test chuyên biệt UIUX responsive & khôi phục lỗi |

### Tác động tới Production Bundle (`npm run build`)
- Toàn bộ ứng dụng được build thành công với TypeScript 5.9 và Vite 7.
- Kích thước CSS production: `196.67 kB` (gzip: `37.48 kB`) — hoàn toàn nằm trong ngưỡng tối ưu cho mạng di động 4G tại Việt Nam.
- Các module nghiệp vụ được tách nhỏ (code-splitting) theo route: `SellVehiclePage`, `CopilotPage`, `VehicleDetailPage`, `ShorthandIntakePage` đều dưới `25 kB` (gzip dưới `8 kB`).

---

## 8. ĐÁNH GIÁ & KHUYẾN NGHỊ SẴN SÀNG PHÁT HÀNH (RELEASE READINESS)

### Kết luận đánh giá: **SẴN SÀNG PHÁT HÀNH (PRODUCTION-READY)**

- **An toàn dữ liệu:** 100% các bất biến tài chính, logic RLS, bảo mật quyền hạn OWNER/MANAGER/STAFF được giữ nguyên vẹn. Không có bất kỳ truy vấn ghi bất thường nào xảy ra.
- **Tính khả dụng:** Người dùng lớn tuổi và nhân viên cửa hàng xe máy sẽ thao tác dễ dàng hơn nhờ cỡ chữ input không bị co nhỏ trên điện thoại, nút bấm to rõ, các nhãn hiển thị tiền tệ và công nợ minh bạch, không còn mã kỹ thuật khó hiểu.
- **Chất lượng mã nguồn:** Toàn bộ kiểm thử đơn vị, kiểm thử tích hợp cơ sở dữ liệu và kiểm thử hành vi người dùng Playwright đều đạt 100% PASS.
- **Trạng thái Git:** Sẵn sàng để người dùng xem xét và quyết định commit / merge theo quy trình dự án.
