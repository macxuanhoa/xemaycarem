export class AppError extends Error {}
export function friendlyError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const value =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  if (!navigator.onLine || /fetch|network/i.test(value))
    return "Không thể kết nối. Giao dịch chưa được xác nhận; hãy kiểm tra lại danh sách trước khi thử lại.";
  if (/invalid login credentials/i.test(value))
    return "Email hoặc mật khẩu không chính xác.";
  if (/rate.limit|too many requests/i.test(value))
    return "Bạn đã thử quá nhiều lần. Vui lòng đợi một chút rồi thử lại.";
  if (/VEHICLE_EXPENSE_LOCKED/i.test(value))
    return "Chi phí của xe đã bán hoặc đã hủy đang bị khóa. Vui lòng kiểm tra trạng thái xe.";
  if (/FUTURE_DATE/i.test(value))
    return "Ngày ghi nhận không được nằm trong tương lai.";
  if (/SALE_BEFORE_EXPENSE/i.test(value))
    return "Ngày bán không được trước ngày phát sinh chi phí của xe.";
  if (/PURCHASE_AFTER_EXPENSE/i.test(value))
    return "Ngày nhập xe không được sau ngày chi phí đã ghi nhận.";
  if (/PAYMENT_REQUEST_CONFLICT/i.test(value))
    return "Lần thu tiền này có thông tin khác với lần gửi trước. Kiểm tra lịch sử thanh toán trước khi lập khoản thu mới.";
  if (/PASSWORD_CHANGE_REQUIRED/i.test(value))
    return "Bạn cần đổi mật khẩu trước khi sử dụng các chức năng của cửa hàng.";
  if (/FINANCIAL_ACCESS_DENIED/i.test(value))
    return "Bạn chưa được cấp quyền xem hoặc sửa giá vốn. Liên hệ chủ cửa hàng.";
  if (
    /permission|access_denied|not authorized|forbidden|disabled|inactive|42501/i.test(
      value,
    )
  )
    return "Bạn không có quyền thực hiện thao tác này hoặc tài khoản đã bị khóa.";
  if (/already sold|not available|vehicle_not|sold|sale.*exist/i.test(value))
    return "Không thể bán xe. Xe có thể đã được bán hoặc thay đổi bởi người dùng khác.";
  if (/cost.*pending|purchase.*required|cost.*missing/i.test(value))
    return "Giá mua chưa được xác nhận. Chủ cửa hàng cần bổ sung giá mua trước khi bán.";
  if (/overpay|exceed|remaining|payment.*amount/i.test(value))
    return "Số tiền thu vượt quá số tiền còn phải thanh toán.";
  if (/duplicate|unique/i.test(value))
    return "Thông tin này đã tồn tại. Vui lòng kiểm tra mã xe, số khung hoặc số máy.";
  if (/last.*owner|owner.*last/i.test(value))
    return "Cần giữ ít nhất một chủ cửa hàng đang hoạt động.";
  if (/invalid|check constraint|out of range|required/i.test(value))
    return "Thông tin chưa hợp lệ. Vui lòng kiểm tra số tiền, ngày và các trường bắt buộc.";
  return "Không thể hoàn tất thao tác. Vui lòng tải lại dữ liệu và thử lại.";
}
