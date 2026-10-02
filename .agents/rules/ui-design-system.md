# Cà Rem CRM — Quy Chuẩn Thiết Kế Giao Diện & Trải Nghiệm (UI/UX)

Tài liệu này là quy chuẩn bắt buộc cho tất cả các trang, tính năng và thành phần giao diện trên hệ thống CRM Cà Rem (Cửa Hàng Xe Máy Cà Rem).

---

## 1. Định Danh Thương Hiệu
- **Tên hệ thống**: `Cà Rem` (hoặc `Xe Máy Cà Rem`, `Cà Rem CRM`). Tuyệt đối không dùng tên cũ `xeCRM` hay `Xe CRM` trên giao diện người dùng.
- **Khẩu hiệu / Subtitle**: `HỆ THỐNG CỬA HÀNG XE` / `Vận hành cửa hàng xe máy chuyên nghiệp`.
- **Trang bán hàng trực tuyến**: `Showroom Cà Rem` (`/showroom`).

---

## 2. Phong Cách Thiết Kế: "Mọng Nước Tinh Tế" (Juicy & Refined)
Giao diện phải tạo ấn tượng chuyên nghiệp, sang trọng, đẳng cấp nhưng **nhẹ nhàng, thanh thoát**:
- **Bề mặt & Nền**:
  - Nền trang: Porcelain trắng ngà dịu mắt (`#f4f6f3`), chống mỏi mắt khi nhân viên làm việc cả ngày.
  - Thẻ (Card): Màu trắng thuần khiết (`#ffffff`), viền mảnh mềm mại (`border: 1px solid var(--line, #e2e8e2)`), bo góc mềm (`border-radius: 16px`).
  - Đổ bóng phân tầng: Bóng mềm mờ nhẹ (`box-shadow: 0 4px 20px -3px rgba(16, 43, 35, 0.05), 0 1px 3px 0 rgba(16, 43, 35, 0.03)`).
  - Độ sâu bóng nước (Juicy Sheen): Các banner chính hoặc nút điểm nhấn có viền phản quang vi mô `inset 0 1px 0 rgba(255, 255, 255, 0.4)` và `backdrop-filter: blur(10px)`.

- **Màu sắc chủ đạo (Palette Tokens — Luxury Ruby & Carbon Black)**:
  - **Carbon Black (Đen Carbon Sang Trọng)**: `--carbon: #0f1015`, đại diện cho đẳng cấp xe máy thể thao, quyền lực và sự chắc chắn.
  - **Ruby Crimson (Đỏ Ruby Nổi Bật)**: `--ruby: #e11d48`, viền phản quang và điểm nhấn thao tác chính (CTA, Active tabs, Hero banner).
  - **Warm Porcelain (Trắng ngọc trai dịu)**: `--bg-page: #f7f7f9`.
  - **Cảnh báo & Trạng thái**:
    - Nguy cấp / Quá hạn: Đỏ hồng đậm `#ef4444` / `#fee2e2`.
    - Chờ xử lý: Hổ phách ấm `#f59e0b` / `#fef3c7`.
    - An toàn / Hoàn tất: Xanh lục dịu `#22c55e` / `#dcfce7`.

---

## 3. Quy Tắc Animation: "Nhẹ Nhàng, Không Quá Lố"
**Yêu cầu nghiêm ngặt từ người dùng**: CRM phải hỗ trợ làm việc nhanh, không làm người dùng chóng mặt.
- **Thời lượng**: Tối đa `160ms` đến `200ms` với `cubic-bezier(0.16, 1, 0.3, 1)` hoặc `ease-out`.
- **Hiệu ứng cho phép**:
  - Hover nút / thẻ: Nâng nhẹ 1px (`transform: translateY(-1px)`), tỏa bóng nhẹ.
  - Chuyển tab / bộ lọc: Đổi màu nền mượt mà trong 150ms.
  - Modal / Popover: Mờ mờ dịu (`opacity` và `backdrop-filter`), mở tức thì không giật cục.
- **Tuyệt đối cấm**:
  - Không dùng animation xoay, rung lắc liên tục, zoom nhảy mạnh hoặc hiệu ứng hạt bay rườm rà.
  - Không làm chậm trễ thao tác nhập liệu của nhân viên bán hàng.

---

## 4. Tối Ưu Thao Tác & Phím Tắt (Operational Ergonomics)
- **Phím tắt toàn cục**:
  - `Q` / `q`: Bật/tắt Bảng Thao Tác Nhanh (`QuickActionsModal`). Tự động bỏ qua khi đang gõ trong `input`, `textarea`, `select`.
  - `Ctrl + K` hoặc `⌘ + K` hoặc `/`: Bật Bảng Tìm Kiếm Nhanh Toàn Cục (`GlobalSearchPalette`).
  - `Esc`: Đóng bất kỳ modal hay popup nào đang mở.
- **Huy hiệu phím tắt (Keyboard Chips)**: Luôn hiển thị gợi ý phím tắt tinh tế bên cạnh nút (ví dụ: `<kbd>Q</kbd>`, `<kbd>Ctrl+K</kbd>`).
- **Thao tác nhanh**: Các tác vụ tần suất cao (Thu xe, Bán xe, Quét QR, Xem công nợ) phải luôn truy cập được chỉ trong 1 lần click từ Banner hoặc Topbar.

---

## 5. Typography (Phông Chữ)
- **Phông chữ giao diện chính**: `Plus Jakarta Sans` (hoặc hệ thống fallback `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto`).
- **Phông chữ số liệu / Biển số / Mã khung (VIN)**: `JetBrains Mono` với định dạng `tabular-nums` để các con số căn thẳng cột hoàn hảo trong bảng thu chi và tồn kho.
