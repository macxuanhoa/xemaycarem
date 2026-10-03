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
  if (/JWT expired|token is expired|session_expired|PGRST301/i.test(value))
    return "Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.";
  if (/PGRST202|schema cache|Could not find the function/i.test(value))
    return "Chức năng chưa được đồng bộ với cơ sở dữ liệu. Vui lòng tải lại trang hoặc kiểm tra cập nhật hệ thống.";
  if (/PROFILE_NOT_FOUND|P0002/i.test(value))
    return "Không tìm thấy hồ sơ người dùng trong hệ thống.";
  if (/USERNAME_EXISTS|23505/i.test(value))
    return "Tên đăng nhập đã tồn tại trong hệ thống.";
  if (/INVALID_DATE_RANGE/i.test(value))
    return "Khoảng ngày không hợp lệ. Ngày bắt đầu phải trước ngày kết thúc.";
  if (/ANNOUNCEMENT_NOT_FOUND/i.test(value))
    return "Không tìm thấy thông báo hệ thống. Vui lòng tải lại danh sách.";
  if (/INVALID_ANNOUNCEMENT_MESSAGE/i.test(value))
    return "Nội dung thông báo không hợp lệ. Vui lòng nhập từ 1 đến 500 ký tự.";
  if (/VEHICLE_EXPENSE_LOCKED/i.test(value))
    return "Chi phí của xe đã bán hoặc đã hủy đang bị khóa. Vui lòng kiểm tra trạng thái xe.";
  if (/SALE_HISTORY_EXISTS/i.test(value))
    return "Xe này đã có lịch sử mua bán nên không thể xóa cứng. Hãy dùng thao tác hủy để giữ lại vết kiểm toán.";
  if (/DELETION_REASON_REQUIRED/i.test(value))
    return "Vui lòng nhập lý do xóa (từ 3 đến 1000 ký tự).";
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
  if (/last.*owner|owner.*last|LAST_OWNER_REQUIRED/i.test(value))
    return "Cần giữ ít nhất một chủ cửa hàng đang hoạt động.";
  if (/invalid|check constraint|out of range|required/i.test(value))
    return "Thông tin chưa hợp lệ. Vui lòng kiểm tra số tiền, ngày và các trường bắt buộc.";
  // Preserve already-clear Vietnamese error messages thrown by server or client
  if (
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
      value,
    )
  ) {
    return value;
  }
  return "Không thể hoàn tất thao tác. Vui lòng tải lại dữ liệu và thử lại.";
}

