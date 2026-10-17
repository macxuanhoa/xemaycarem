export class AppError extends Error {}
export function friendlyError(error: unknown): string {
  const value =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : error instanceof Error
        ? error.message
        : "";
  // Supabase surfaces Postgres/PostgREST failures as a plain object carrying
  // `code` (the SQLSTATE), `message`, `details` and `hint`. A unique-violation
  // (23505) on its own does not say WHICH table collided, so we read every
  // field to tell a duplicated vehicle chassis apart from a duplicated
  // username before either branch claims the error.
  const err =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const code = err.code != null ? String(err.code) : "";
  const signature =
    `${value} ${code} ${err.details ?? ""} ${err.hint ?? ""}`.toLowerCase();
  // Supabase Auth returns a handful of policy errors verbatim in English (for
  // example the minimum-length rejection from updateUser / createUser). Catch
  // them here, before the AppError short-circuit below, so a raw GoTrue string
  // that got wrapped in an AppError still surfaces in Vietnamese.
  const passwordMin = /password should be at least (\d+) characters?/i.exec(value);
  if (passwordMin)
    return `Mật khẩu phải có ít nhất ${passwordMin[1]} ký tự.`;
  // Mã lỗi số tiền đặc trưng của một mã VietQR (money_input chặn > 1.000.000.000.000 ₫
  // hoặc nhận số thập phân). Ánh xạ SỚM, trước cả nhánh "mất mạng", để lúc offline
  // thật (hoặc navigator.onLine giả trong môi trường test) người dùng vẫn đọc đúng
  // giới hạn thay vì bị nuốt vào câu "Không thể kết nối".
  if (/INVALID_PAYMENT_AMOUNT|INVALID_MONEY|MONEY_OUT_OF_RANGE/i.test(value))
    return "Số tiền không hợp lệ cho một mã chuyển khoản: phải là số nguyên, lớn hơn 0 và tối đa 1.000.000.000.000 ₫.";
  if (error instanceof AppError) return error.message;
  if (
    (typeof navigator !== "undefined" && !navigator.onLine) ||
    /fetch|network|load failed|failed to load|timeout|timed out/i.test(value)
  )
    return "Không thể kết nối. Giao dịch chưa được xác nhận; hãy kiểm tra lại danh sách trước khi thử lại.";
  if (/invalid login credentials/i.test(value))
    return "Email hoặc mật khẩu không chính xác.";
  if (/rate.limit|too many requests/i.test(value))
    return "Bạn đã thử quá nhiều lần. Vui lòng đợi một chút rồi thử lại.";
  if (/JWT expired|token is expired|session_expired|PGRST301/i.test(value))
    return "Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.";
  if (/PGRST202|schema cache|Could not find the function/i.test(value))
    return "Chức năng chưa được đồng bộ với cơ sở dữ liệu. Vui lòng tải lại trang hoặc kiểm tra cập nhật hệ thống.";
  if (/CLIENT_UPGRADE_REQUIRED/i.test(value))
    return "Phiên bản đang mở chưa hỗ trợ lưu giao dịch an toàn. Thao tác chưa được ghi nhận; hãy cập nhật ứng dụng, tải lại dữ liệu và đối soát lịch sử trước khi gửi lại.";
  if (/PROFILE_NOT_FOUND|P0002/i.test(value))
    return "Không tìm thấy hồ sơ người dùng trong hệ thống.";
  // Vehicle chassis identity clash. Two staff can slip past the client-side
  // pre-check and submit the same frame at the same moment; the loser gets
  // either the RPC's DUPLICATE_FRAME_NUMBER or a raw 23505 unique-violation on
  // the vehicles FULL-frame index. Both must read as a vehicle problem, never
  // the username message below.
  if (
    /DUPLICATE_FRAME_NUMBER/i.test(value) ||
    (code === "23505" && /frame/.test(signature))
  )
    return "Số khung đã tồn tại trong hệ thống.";
  // Smart tri-state detection: RED (biển số + 5 ký tự cuối khung trùng xe đang
  // quản lý) chặn cứng; YELLOW cần nhân viên xác nhận. Không phải trùng tên đăng
  // nhập, nên dựng ở đây trước nhánh username.
  if (/DUPLICATE_VEHICLE_SUSPECTED|PLATE_AND_LAST5|NEED_VERIFY_PARTIAL_FULL/i.test(value))
    return "Biển số và 5 ký tự cuối số khung trùng với xe đang quản lý. Hãy nhập số khung đầy đủ hoặc mở hồ sơ hiện có để đối chiếu.";
  if (/DUPLICATE_VEHICLE_NEEDS_CONFIRM|PARTIAL_MATCH/i.test(value))
    return "Có thể xe này đã tồn tại. Hãy kiểm tra danh sách xe tương tự rồi xác nhận lưu.";
  // Luồng xác minh nghi trùng theo vai trò (migration 20261011000400). Hai mã
  // dưới đây chỉ xuất hiện ở luồng này nên an toàn khi ánh xạ toàn cục; còn
  // ALREADY_PENDING / APPROVAL_STALE_DATA dùng chung với bán dưới giá thu nên
  // được diễn giải riêng ngay tại UI gửi/duyệt để không đổi văn bản cũ.
  if (/DUPLICATE_OVERRIDE_REASON_REQUIRED/i.test(value))
    return "Cần nhập lý do ngoại lệ (từ 5 ký tự) trước khi lưu hồ sơ nghi trùng.";
  if (/NO_DUPLICATE_TO_REVIEW/i.test(value))
    return "Tín hiệu nghi trùng không còn khi gửi. Hãy tải lại kiểm tra trùng; nếu vẫn nghi vấn, mở hồ sơ hiện có để đối chiếu.";
  if (
    /USERNAME_EXISTS/i.test(value) ||
    (code === "23505" && /username|profiles_username|email/.test(signature))
  )
    return "Tên đăng nhập đã tồn tại trong hệ thống.";
  if (/INVALID_DATE_RANGE/i.test(value))
    return "Khoảng ngày không hợp lệ. Ngày bắt đầu phải trước ngày kết thúc.";
  if (/ANNOUNCEMENT_NOT_FOUND/i.test(value))
    return "Không tìm thấy thông báo hệ thống. Vui lòng tải lại danh sách.";
  if (/INVALID_ANNOUNCEMENT_MESSAGE/i.test(value))
    return "Nội dung thông báo không hợp lệ. Vui lòng nhập từ 1 đến 500 ký tự.";
  if (/VEHICLE_EXPENSE_LOCKED/i.test(value))
    return "Chi phí của xe đã bán hoặc đã hủy đang bị khóa. Vui lòng kiểm tra trạng thái xe.";
  if (/DUPLICATE_VEHICLE_TYPE/i.test(value))
    return "Loại xe này đã có trong danh mục (tên chỉ khác hoa/thường hoặc khoảng trắng).";
  if (/INVALID_VEHICLE_TYPE_NAME/i.test(value))
    return "Tên loại xe cần từ 2 đến 60 ký tự.";
  if (/VEHICLE_TYPE_PROTECTED/i.test(value))
    return "\"Chưa phân loại\" là hàng đợi bắt buộc của hệ thống — không đổi tên, không xoá.";
  if (/VEHICLE_TYPE_IN_USE/i.test(value))
    return "Đang có xe thuộc loại này nên không thể xoá. Hãy chuyển các xe đó sang loại khác trước.";
  if (/VEHICLE_TYPE_NOT_FOUND/i.test(value))
    return "Loại xe không còn trong danh mục. Tải lại trang để cập nhật danh mục mới nhất.";
  if (/VEHICLE_TYPE_REQUIRED|\bINVALID_VEHICLE_TYPE\b/i.test(value))
    return "Chưa chọn loại xe hợp lệ từ danh mục. Hãy chọn lại loại xe rồi lưu.";
  if (/SALE_HISTORY_EXISTS/i.test(value))
    return "Xe này đã có lịch sử mua bán nên không thể xóa cứng. Hãy dùng thao tác hủy để giữ lại vết kiểm toán.";
  if (/DELETION_REASON_REQUIRED/i.test(value))
    return "Vui lòng nhập lý do xóa (từ 3 đến 1000 ký tự).";
  // Hàng đợi "Chờ duyệt" cho bán dưới giá thu (migration 20261010000300).
  if (/SALE_BELOW_COST_APPROVAL_REQUIRED/i.test(value))
    return "Bán dưới giá thu là quyết định của chủ cửa hàng. Hãy bấm «Gửi yêu cầu duyệt» để chuyển yêu cầu sang mục Chờ duyệt.";
  if (/SALE_APPROVAL_PENDING/i.test(value))
    return "Xe đang có yêu cầu bán dưới giá thu chờ chủ duyệt nên chưa tạo được giao dịch khác. Cần đổi số liệu thì rút yêu cầu cũ rồi gửi lại.";
  if (/ALREADY_PENDING/i.test(value))
    return "Xe này đang có yêu cầu bán dưới giá thu chờ duyệt. Không gửi thêm yêu cầu trùng.";
  if (/ALREADY_RESOLVED/i.test(value))
    return "Yêu cầu này đã được xử lý. Tải lại danh sách Chờ duyệt để xem trạng thái mới.";
  if (/APPROVAL_STALE_DATA/i.test(value))
    return "Giá thu hoặc chi phí của xe đã thay đổi sau khi gửi đơn. Chủ không duyệt bản cũ; nhân viên cần rút yêu cầu và gửi lại số liệu mới.";
  if (/SALE_NOT_BELOW_COST/i.test(value))
    return "Giá bán không thấp hơn giá thu nên không cần duyệt. Hãy bấm xác nhận bán xe bình thường.";
  if (/APPROVAL_NOT_FOUND/i.test(value))
    return "Yêu cầu không còn trong danh sách chờ duyệt. Tải lại trang để cập nhật trạng thái.";
  if (/FUTURE_DATE/i.test(value))
    return "Ngày ghi nhận không được nằm trong tương lai.";
  if (/SALE_BEFORE_EXPENSE/i.test(value))
    return "Ngày bán không được trước ngày phát sinh chi phí của xe.";
  if (/PURCHASE_AFTER_EXPENSE/i.test(value))
    return "Ngày nhập xe không được sau ngày chi phí đã ghi nhận.";
  if (/PAYMENT_VERIFICATION_REQUIRED|PAYMENT_EVIDENCE_REQUIRED/i.test(value))
    return "Cần quản lý đối chiếu tiền thực nhận và chứng từ dùng chung trước khi ghi nhận khoản thu.";
  if (/PAYMENT_RECEIPT_REJECTED/i.test(value))
    return "Đề nghị thu tiền này đã bị từ chối. Kiểm tra lý do và lịch sử với quản lý.";
  if (/PAYMENT_RECEIPT_CONFLICT/i.test(value))
    return "Chứng từ này đã được dùng hoặc có thông tin khác. Khoản thu chưa được ghi nhận; hãy đối chiếu chứng từ và lịch sử với quản lý.";
  if (/PAYMENT_REQUEST_CONFLICT/i.test(value))
    return "Lần thu tiền này có thông tin khác với lần gửi trước. Kiểm tra lịch sử thanh toán trước khi lập khoản thu mới.";
  if (/BANK_WEBHOOK_NOT_CONFIGURED/i.test(value))
    return "Kết nối ngân hàng chưa được cấu hình đầy đủ. Chủ cửa hàng cần kiểm tra cấu hình trước khi nhận giao dịch tự động.";
  if (/BANK_PROVIDER_MISMATCH/i.test(value))
    return "Giao dịch đến từ dịch vụ ngân hàng khác với cấu hình cửa hàng. Hãy kiểm tra nguồn giao dịch trước khi đối soát.";
  if (/BANK_ACCOUNT_MISMATCH/i.test(value))
    return "Tài khoản nhận tiền không khớp cấu hình cửa hàng. Hãy đối chiếu đúng tài khoản trước khi ghi nhận.";
  if (/BANK_TRANSACTION_AMOUNT_MISMATCH/i.test(value))
    return "Số tiền ngân hàng nhận không khớp yêu cầu VietQR. Hãy đối chiếu tiền thực nhận và tạo yêu cầu với đúng số tiền.";
  if (/VIETQR_REQUEST_NOT_PENDING/i.test(value))
    return "Yêu cầu VietQR đã được xử lý hoặc không còn chờ thanh toán. Tải lại giao dịch trước khi đối soát.";
  if (/VIETQR_BANK_EVIDENCE_REQUIRED/i.test(value))
    return "Chưa có khoản chuyển được ngân hàng xác minh. Chưa ghi nhận đã thu tiền; hãy kiểm tra trạng thái thanh toán.";
  if (/VIETQR_PAYER_REQUIRED/i.test(value))
    return "Nhập tên người thanh toán trước khi tạo mã chuyển khoản.";
  if (/VIETQR_REPLACEMENT_COOLDOWN/i.test(value))
    return "Chưa đến thời gian thay mã. Mỗi mã cần chờ ít nhất 60 giây trước khi thay mã mới.";
  if (/VIETQR_RATE_LIMITED/i.test(value))
    return "Đã tạo quá nhiều mã thanh toán. Giữ mã đang có và thử lại sau để tránh nhầm khoản chuyển.";
  if (/VIETQR_REPLACE_REQUIRED/i.test(value))
    return "Thông tin thanh toán đã thay đổi. Mở mã hiện tại và dùng nút thay mã mới sau thời gian chờ.";
  if (/VIETQR_REPLACEMENT_CONFLICT/i.test(value))
    return "Mã thanh toán đã được thay ở màn hình khác. Đóng và mở lại để xem đúng mã hiện tại.";
  if (/VIETQR_FUNDS_ALREADY_RECEIVED/i.test(value))
    return "Mã này đã có tiền vào tài khoản. Không thay mã hoặc sửa khoản thu; hãy kiểm tra và gắn khoản tiền với đúng hợp đồng.";
  if (/VIETQR_SALE_BINDING_MISMATCH/i.test(value))
    return "Thông tin xe, người thanh toán hoặc số tiền khác với khoản chuyển đã nhận. Chưa hoàn tất bán xe; hãy đối soát lại.";
  if (/VIETQR_CONTENT_TOO_LONG/i.test(value))
    return "Không tạo được nội dung chuyển khoản chuẩn. Kiểm tra thông tin xe và tài khoản nhận tiền trước khi tạo mã.";
  if (/OPERATION_REQUEST_CONFLICT/i.test(value))
    return "Mã giao dịch này đã được dùng với thông tin khác. Hãy đối soát giao dịch trước và kiểm tra lịch sử trước khi tạo giao dịch mới.";
  if (/VEHICLE_EDIT_CONFLICT/i.test(value))
    return "Xe đã được người khác cập nhật. Thay đổi của bạn chưa được lưu; hãy tải lại hồ sơ xe và đối chiếu trước khi sửa tiếp.";
  if (/SALE_DUE_DATE_CONFLICT/i.test(value))
    return "Giao dịch đã được cập nhật. Hạn trả của bạn chưa được lưu; hãy đóng, tải lại danh sách công nợ và đối chiếu trước khi sửa tiếp.";
  if (/EXPENSE_EDIT_CONFLICT/i.test(value))
    return "Chi phí đã được người khác cập nhật. Thay đổi của bạn chưa được lưu; hãy đóng, tải lại danh sách và đối chiếu trước khi sửa tiếp.";
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
  if (/PURCHASE_PRICE_REQUIRED/i.test(value))
    return "Cần nhập giá thu mua (lớn hơn 0) cho xe. Đây là thông tin bắt buộc khi đưa xe vào kho.";
  if (/cost.*pending|purchase.*required|cost.*missing/i.test(value))
    return "Xe chưa có giá thu mua. Mở hồ sơ xe và bổ sung giá thu trước khi bán.";
  if (/overpay|exceed|remaining|payment.*amount/i.test(value))
    return "Số tiền thu vượt quá số tiền còn phải thanh toán.";
  if (/duplicate|unique/i.test(value))
    return "Thông tin này đã tồn tại. Vui lòng kiểm tra mã xe hoặc số khung.";
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

/**
 * ALREADY_PENDING và APPROVAL_STALE_DATA là mã dùng chung giữa luồng "bán dưới
 * giá thu" và luồng "xác minh nghi trùng". friendlyError chỉ có một văn bản cho
 * mỗi mã (đang thiên về bán), nên UI nghi trùng gọi hàm này để đọc đúng ngữ cảnh
 * mà KHÔNG sửa ánh xạ toàn cục (tránh hồi quy cho luồng bán).
 */
export function mapDuplicateReviewError(error: unknown): string {
  const raw =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : error instanceof Error
        ? error.message
        : "";
  if (/ALREADY_PENDING/i.test(raw))
    return "Hồ sơ nghi trùng này đang có yêu cầu xác minh chờ Chủ/Quản lý. Không gửi yêu cầu trùng — hãy chờ quyết định đã.";
  if (/APPROVAL_STALE_DATA/i.test(raw))
    return "Dữ liệu xe hoặc hồ sơ đối chiếu đã thay đổi so với lúc gửi. Không lưu được bản cũ; tải lại và kiểm tra trùng rồi thao tác tiếp.";
  return friendlyError(error);
}

