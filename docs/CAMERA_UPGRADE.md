# Quét camera và QR xe

## Tự tìm vùng chữ và chọn ảnh rõ

Camera đọc biển số và số khung liên tục trên toàn bộ vùng hình đang thấy. Không cần chọn loại thông tin hoặc bấm chụp. Bộ đọc trên máy tìm các cụm nét chữ, khoanh tối đa hai vùng đang đọc, cắt ảnh có viền và chỉnh nghiêng nhẹ trong phạm vi 20 độ. Cả ảnh thư viện và camera đều đi qua quy trình này. Bộ đọc vẫn kiểm tra toàn ảnh để không bỏ sót biển số khác hoặc số khung ở ngoài vùng được khoanh.

Khung “Vùng chữ” là vùng có nét giống chữ, chưa chứng minh đó là biển số hoặc số khung. Nền nhiều chữ, kim loại bị lóa, dấu dập mờ và nghiêng phối cảnh vẫn có thể gây đọc sai. Camera đưa hướng dẫn thiếu sáng, lóa, nhòe hoặc cần đưa gần hơn; các gợi ý này không chặn việc đọc. Đây là phân tích ảnh và OCR trên máy, chưa có mô hình được huấn luyện riêng cho biển số Việt Nam.

Khi hai lần đọc độc lập cho cùng định danh đạt độ tin cậy cần thiết, camera chọn ảnh rõ nhất trong tối đa ba ảnh của cùng cảnh và cùng kết quả. Đổi đối tượng, đổi camera hoặc tắt camera sẽ bỏ các ảnh cũ. Những cảnh báo ký tự từ các lần đọc cùng kết quả được giữ lại; chọn ảnh rõ hơn không làm mất chữ đỏ cần kiểm tra.

## Tra đúng xe trong toàn bộ kho

Quét biển số và số khung được đối chiếu bằng phép so khớp chính xác trong toàn kho, không bị giới hạn bởi 25 dòng đầu của trang tìm kiếm. Khoảng trắng, dấu gạch và dấu chấm không ảnh hưởng đối chiếu. Số khung cần đủ ít nhất 11 ký tự chữ/số và hồ sơ phải đánh dấu là số khung đầy đủ mới được dùng làm định danh tự mở xe.

Một xe khớp duy nhất và không có ký tự cần kiểm tra thì mở hồ sơ xe. Nhiều xe trùng định danh hoặc biển số và số khung trỏ tới hai xe khác nhau sẽ cần chọn/kiểm tra; không tự mở theo phỏng đoán. Hồ sơ đang chờ xóa hoặc đã bị xóa không xuất hiện. Mất kết nối khi đối chiếu phải báo thử lại, không coi xe là mới.

## Mã QR ổn định và tem xe

Tem QR mới chứa mã cố định `carem:vehicle:v1:<UUID>` của hồ sơ xe. Đổi tên miền hoặc thông tin xe không đổi định danh QR. Trang hồ sơ cho phép tải QR và in tem có mã nội bộ, biển số/số khung và thông tin xe. Quét tem bằng chế độ QR xe trong Camera của Cà Rem.

QR dạng UUID và đường dẫn cùng tên miền của tem cũ vẫn được hỗ trợ. Máy quét không đi tới đường dẫn lạ trong QR. Trước khi mở xe luôn đọc hồ sơ từ kho với quyền hiện tại; QR không cấp thêm quyền và không chứa thông tin khách/CCCD hoặc giá vốn.

## Theo dõi lỗi và đưa bản mới vào sử dụng

OWNER xem thống kê lỗi tại Cài đặt → Ứng dụng & Dữ liệu. Thống kê chỉ chứa loại lỗi, thao tác, trang theo mẫu, phiên bản và thời gian. Không ghi nội dung ảnh, CCCD, thông tin khách hoặc nội dung yêu cầu. Mất mạng hoặc dịch vụ theo dõi chưa có không làm hỏng giao dịch; số liệu chưa có không chứng minh ứng dụng không có lỗi.

Mã nguồn và hai RPC tra định danh/theo dõi lỗi cần được phát hành cùng nhau. Kiểm tra trước trên dự án Supabase thử riêng và điện thoại thực tế. Kiểm thử ảnh dựng và trình duyệt thật không thay thế bộ ảnh biển số/số khung của cửa hàng ở nhiều góc, ánh sáng và loại máy. Hướng dẫn staging, sao lưu và diễn tập ở `docs/OPERATIONS_UPGRADE.md`.
