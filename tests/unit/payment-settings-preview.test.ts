import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { removeVietnameseTones } from "@/lib/vietqr/emvco";
import {
  ACCOUNT_NAME_LIMIT,
  ACCOUNT_NO_LIMIT,
  BANK_BIN_LIMIT,
  hasBankSettingsErrors,
  validateBankSettings,
} from "@/lib/vietqr/settingsValidation";

/**
 * P0-5 (mã xem trước ở Cài đặt): thẻ preview từng nhúng cả ảnh mã QR — kể cả
 * bản "minh hoạ" vẽ tại máy — trông như một công cụ thanh toán thật, dễ khiến
 * người xem tưởng quét được và từng có tiền sử gọi thẳng img.vietqr.io làm leak
 * số tài khoản + tên chủ tài khoản của OWNER sang bên thứ ba.
 *
 * Bản hiện tại BỎ HẲN mã QR khỏi thẻ: hợp đồng mới là Cài đặt không được chứa
 * bất kỳ mã QR nào (không vẽ, không nhúng, không nhãn "minh họa"), chỉ hiển
 * thị trực tiếp số tài khoản & chủ tài khoản. Kèm đó là ràng buộc biểu mẫu
 * (P1-e) khớp đúng hợp đồng server `save_settings`.
 */

const card = readFileSync("src/features/settings/PaymentSettingsCard.tsx", "utf8");

/**
 * Quét nguồn phải bỏ comment trước: chính các ghi chú nghiệp vụ kể lại lỗi cũ
 * ("bản cũ gọi img.vietqr.io…") sẽ làm bài test chặn dương tính giả.
 */
const code = card
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("P0-5 · preview ở Cài đặt không chứa mã QR nào", () => {
  it("không gọi img.vietqr.io (không leak số tài khoản ra bên thứ ba)", () => {
    expect(code).not.toMatch(/img\.vietqr\.io/i);
    expect(code).not.toContain("buildVietQrQuickLink");
    expect(code).not.toMatch(/https?:\/\/[^"'\s]*vietqr/i);
  });

  it("không dựng payload EMVCo/Napas nào từ số tài khoản thật", () => {
    expect(code).not.toContain("buildVietQrEmvCoPayload");
    expect(code).not.toContain("qr_payload");
  });

  it("thẻ xem trước bỏ hẳn mã QR: không vẽ, không nhúng, không nhãn 'minh họa'", () => {
    expect(code).not.toContain("renderQrToDataUrl");
    expect(code).not.toContain("DEMO_QR_TEXT");
    expect(code).not.toMatch(/bank-card-qr/);
    expect(code).not.toMatch(/<img\b/);
    expect(card).not.toMatch(/minh họa · không thanh toán/i);
  });

  it("thay vào đó hiển thị trực tiếp số tài khoản & chủ tài khoản trên thẻ", () => {
    expect(code).toContain("bank-card-visual");
    expect(code).toContain("groupAccount(accountNo)");
    expect(code).toContain("bank-card-holder-name");
  });
});

describe("P1-e · kiểm biểu mẫu khớp hợp đồng server save_settings", () => {
  const valid = { bankBin: "970436", accountNo: "0123456789", accountName: "NGUYEN VAN A" };

  it("trần độ dài 10/40/120 đúng như server", () => {
    expect(BANK_BIN_LIMIT).toBe(10);
    expect(ACCOUNT_NO_LIMIT).toBe(40);
    expect(ACCOUNT_NAME_LIMIT).toBe(120);
  });

  it("cấu hình đầy đủ hợp lệ → không chặn nút Lưu", () => {
    expect(hasBankSettingsErrors(validateBankSettings(valid))).toBe(false);
  });

  it("thiếu bất kỳ trường nào đều bị chặn (VIETQR_CONFIG_REQUIRED phía server)", () => {
    for (const key of ["bankBin", "accountNo", "accountName"] as const) {
      const errors = validateBankSettings({ ...valid, [key]: "   " });
      expect(errors[key]).not.toBe("");
      expect(hasBankSettingsErrors(errors)).toBe(true);
    }
  });

  it("vượt trần từng trường bị chặn tại đúng trường đó", () => {
    const overBin = validateBankSettings({ ...valid, bankBin: "9".repeat(BANK_BIN_LIMIT + 1) });
    expect(overBin.bankBin).not.toBe("");
    expect(overBin.accountNo).toBe("");

    const overNo = validateBankSettings({ ...valid, accountNo: "1".repeat(ACCOUNT_NO_LIMIT + 1) });
    expect(overNo.accountNo).not.toBe("");
    expect(overNo.bankBin).toBe("");

    const overName = validateBankSettings({
      ...valid,
      accountName: "A".repeat(ACCOUNT_NAME_LIMIT + 1),
    });
    expect(overName.accountName).not.toBe("");
  });

  it("số tài khoản chứa ký tự ngoài chữ số bị chặn (phòng giá trị đọc từ server)", () => {
    // Ô nhập trên màn hình đã lọc \D, nên chuỗi có chữ/khoảng chỉ có thể tới từ
    // dữ liệu cũ trên server — phải báo lỗi chứ không im lặng gửi đi.
    expect(validateBankSettings({ ...valid, accountNo: "0123ABC56789" }).accountNo).not.toBe("");
    expect(validateBankSettings({ ...valid, accountNo: "0123 4567" }).accountNo).not.toBe("");
    expect(validateBankSettings({ ...valid, accountNo: "0123456789" }).accountNo).toBe("");
    expect(code).toContain('replace(/[^\\d]/g, "")');
  });

  it("ngưỡng ngay tại trần vẫn được chấp nhận (không chặn nhầm)", () => {
    expect(
      hasBankSettingsErrors(
        validateBankSettings({
          bankBin: "9".repeat(BANK_BIN_LIMIT),
          accountNo: "1".repeat(ACCOUNT_NO_LIMIT),
          accountName: "A".repeat(ACCOUNT_NAME_LIMIT),
        }),
      ),
    ).toBe(false);
  });

  it("PaymentSettingsCard dùng đúng module này và chỉ báo lỗi sau khi bấm Lưu", () => {
    expect(code).toContain("validateBankSettings");
    expect(code).toContain("hasBankSettingsErrors");
    expect(code).toMatch(/showErrors \? fieldErrors\.bankBin/);
    expect(code).toMatch(/setShowErrors\(true\)/);
  });

  it("nút Lưu khoá khi đang tải, đang gửi hoặc không có thay đổi", () => {
    expect(code).toMatch(/disabled=\{[^}]*saveMutation\.isPending[^}]*\}/s);
    expect(code).toMatch(/!dirty/);
  });

  it("tên chủ tài khoản lưu lên server vẫn bỏ dấu + HOA như server yêu cầu", () => {
    expect(removeVietnameseTones("Nguyễn Văn A").toUpperCase()).toBe("NGUYEN VAN A");
    expect(code).toMatch(/removeVietnameseTones\(accountName\)\.toUpperCase\(\)/);
  });
});

describe("P1-e · BankPicker là combobox thật, không phải ô gõ mù", () => {
  it("ô tìm kiếm mang ngữ nghĩa combobox chuẩn ARIA", () => {
    expect(code).toContain('role="combobox"');
    expect(code).toContain("aria-expanded");
    expect(code).toContain('aria-autocomplete="list"');
    expect(code).toContain("aria-controls={listboxId}");
    expect(code).toContain("aria-activedescendant={activeBank ? optionId(active) : undefined}");
  });

  it("danh sách là listbox, từng mục là option và tự báo mục đang chọn", () => {
    expect(code).toContain('role="listbox"');
    expect(code).toContain('role="option"');
    expect(code).toContain("aria-selected={b.bin === value}");
    expect(code).toContain('aria-haspopup="listbox"');
  });

  it("thông báo 'không có kết quả' KHÔNG giả làm một lựa chọn", () => {
    // Gán role="option" cho dòng này khiến trình đọc màn hình báo một mục
    // không tồn tại là chọn được.
    expect(code).toMatch(/bank-picker-empty"\s+role="presentation"\s+aria-disabled="true"/);
    expect(code).not.toMatch(/bank-picker-empty[\s\S]{0,80}?role="option"/);
  });

  it("điều hướng được hoàn toàn bằng bàn phím", () => {
    for (const key of ['"ArrowDown"', '"ArrowUp"', '"Home"', '"End"', '"Enter"', '"Escape"']) {
      expect(code).toContain(`e.key === ${key}`);
    }
    expect(code).toMatch(/setActive\(\(p\) => Math\.min\(p \+ 1, results\.length - 1\)\)/);
    expect(code).toMatch(/setActive\(\(p\) => Math\.max\(p - 1, 0\)\)/);
    expect(code).toMatch(/commit\(results\[active\]\.bin\)/);
  });

  it("đóng hoặc chọn thì trả tiêu điểm về nút trigger (WCAG 2.4.3)", () => {
    expect(code).toContain("triggerRef.current?.focus()");
    expect(code).toMatch(/const closePicker = useCallback\(\(restoreFocus: boolean\)/);
    expect(code).toMatch(/if \(restoreFocus\) triggerRef\.current\?\.focus\(\)/);
  });

  it("kết quả lọc được công bố cho trình đọc màn hình bằng live region", () => {
    expect(code).toMatch(/role="status"[\s\S]{0,40}?aria-live="polite"/);
    expect(code).toContain("Đang gợi ý");
    expect(code).toContain("Dùng phím mũi tên để chọn.");
  });

  it("id option sinh từ useId nên hai combobox không đè nhau", () => {
    expect(code).toContain("useId()");
    expect(code).toContain("`${listboxId}-option-${index}`");
  });

  it("trường lỗi có phần tử mô tả cho công nghệ hỗ trợ, không chỉ bằng màu", () => {
    expect(code).toContain("Chưa chọn ngân hàng nhận tiền.");
    expect(code).toMatch(/invalid && !selected \? <span className="sr-only">/);
  });
});
