/**
 * Kiểm tra thông tin tài khoản nhận tiền ở Cài đặt.
 *
 * Ràng buộc khớp ĐÚNG hợp đồng server `save_settings` (ba trường đều bắt buộc
 * khi bật VietQR, trần độ dài 10/40/120) — không tự đặt quy tắc riêng khiến
 * nhân viên bị chặn những gì server vẫn chấp nhận. Để riêng thành module thuần
 * để test được mà không phải dựng cả cây React.
 */
export type BankSettingsInput = {
  bankBin: string;
  accountNo: string;
  accountName: string;
};

export type BankSettingsErrors = {
  bankBin: string;
  accountNo: string;
  accountName: string;
};

export const BANK_BIN_LIMIT = 10;
export const ACCOUNT_NO_LIMIT = 40;
export const ACCOUNT_NAME_LIMIT = 120;

/**
 * Trả về thông báo cho từng trường (chuỗi rỗng = hợp lệ). Biểu mẫu chưa đụng tới
 * (`dirty === false`) thì màn hình ẩn lỗi, còn bản thân hàm này luôn nói thật
 * để nút Lưu không gửi đi một cấu hình thiếu.
 */
export function validateBankSettings(input: BankSettingsInput): BankSettingsErrors {
  const bankBin = input.bankBin.trim();
  const accountNo = input.accountNo.trim();
  const accountName = input.accountName.trim();

  return {
    bankBin: !bankBin
      ? "Vui lòng chọn ngân hàng nhận tiền."
      : bankBin.length > BANK_BIN_LIMIT
        ? "Mã ngân hàng (BIN) tối đa 10 ký tự."
        : "",
    accountNo: !accountNo
      ? "Vui lòng nhập số tài khoản."
      : accountNo.length > ACCOUNT_NO_LIMIT
        ? `Số tài khoản tối đa ${ACCOUNT_NO_LIMIT} ký tự.`
        : !/^\d+$/.test(accountNo)
          ? "Số tài khoản chỉ gồm các chữ số."
          : "",
    accountName: !accountName
      ? "Vui lòng nhập tên chủ tài khoản."
      : accountName.length > ACCOUNT_NAME_LIMIT
        ? `Tên chủ tài khoản tối đa ${ACCOUNT_NAME_LIMIT} ký tự.`
        : "",
  };
}

export const hasBankSettingsErrors = (errors: BankSettingsErrors): boolean =>
  Boolean(errors.bankBin || errors.accountNo || errors.accountName);
