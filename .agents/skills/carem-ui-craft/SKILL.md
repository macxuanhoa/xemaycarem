---
name: carem-ui-craft
description: Chuẩn mực kỹ thuật và quy trình xây dựng, tỉa gọn, nâng cấp giao diện tinh tế chuyên nghiệp cho Cà Rem CRM.
---

# Kỹ Năng Thiết Kế & Xây Dựng Giao Diện Cà Rem CRM

Khi tiếp nhận bất kỳ yêu cầu nào về giao diện, bố cục hoặc trải nghiệm thao tác trong hệ thống **Cà Rem CRM**, bạn phải tuân thủ nghiêm ngặt các nguyên tắc sau:

## 1. Tên Thương Hiệu Nhất Quán
- Tất cả text hiển thị ra ngoài màn hình cho nhân viên, quản lý và khách hàng là **Cà Rem** (hoặc `Xe Máy Cà Rem`).
- Tuyệt đối không để sót `xeCRM`, `Xe CRM`, hoặc các chuỗi cũ trong layout, header, footer, modal hay thông báo.

## 2. Bố Cục & Visual Hierarchy
- **Header Banner**: Sử dụng `DashboardExecutiveBanner` ở đầu các trang tổng quan, kết hợp:
  - Lời chào theo khung giờ (Sáng / Chiều / Tối)
  - Huy hiệu trạng thái cửa hàng trực tuyến
  - Các nút hành động chính (Primary CTA) với nền lime mọng nước
- **Thanh công cụ tác vụ (`carem-quick-bar`)**: Đặt ở các vị trí chuyển tiếp nội dung để nhân viên thao tác nhanh mà không cần cuộn ngược lên đầu trang.
- **Thẻ Metric**:
  - Luôn đi kèm icon trong khung màu mềm (`#eaf3ec`)
  - Chữ số to rõ (`32px`, `font-variant-numeric: tabular-nums`)
  - Thẻ nổi bật (`.metric.featured`) dùng gradient ngọc lục bảo sâu với chữ trắng và icon ánh vàng chanh.

## 3. Thao Tác Nhanh & Phím Tắt
- Bảng thao tác nhanh (`QuickActionsModal`) luôn được phân loại thành 4 nhóm rõ ràng:
  1. **Giao dịch cửa hàng**: Thu xe, Bán xe
  2. **Tra cứu & Công cụ thông minh**: Hỏi Cà Rem AI, Quét QR / Căn cước, Tìm kiếm nhanh, Kho xe
  3. **Tài chính & Quản trị**: Công nợ, Chi phí, Nhập Excel
  4. **Khách hàng & Showroom**: Lịch sử khách, Xem Showroom
- Bắt buộc duy trì phím tắt:
  - Phím `Q`: Mở bảng thao tác nhanh
  - Phím `Ctrl+K` / `⌘K`: Mở tìm kiếm toàn cục
  - Phím `Esc`: Đóng các modal

## 4. Tinh Tế & Nhẹ Nhàng (Không Lạm Dụng Animation)
- Giới hạn thời gian chuyển động trong khoảng `150ms - 200ms`.
- Hover (nút, thẻ, mục menu, pill, ảnh): KHÔNG dùng `transform` — không nhấc `translateY(-1px)`, không phóng `scale`. Chỉ đổi màu nền / viền / bóng (`box-shadow`) hoặc `filter: brightness()` rất nhẹ.
- Được phép giữ `transform` cho trạng thái nhấn (`:active`) và chỉ báo mục đang chọn (`.active`), vì đó là phản hồi bấm, không phải hover.
- Không dùng animation chạy nền gây hao pin máy tính bảng hay gây mất tập trung cho nhân sự.
