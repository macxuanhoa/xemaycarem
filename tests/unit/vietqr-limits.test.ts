import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NAPAS_SINGLE_TRANSFER_LIMIT,
  isAboveNapasSingleTransfer,
  napasOverLimitHint,
} from "@/lib/vietqr/limits";
import { friendlyError } from "@/lib/errors";

describe("VietQR hạn mức một lệnh chuyển nhanh 24/7", () => {
  it("chốt mốc 300.000.000 ₫ đúng thoả thuận Owner", () => {
    expect(NAPAS_SINGLE_TRANSFER_LIMIT).toBe(300_000_000);
  });

  it("chỉ báo vượt khi LỚN HƠN mốc, không phải bằng mốc", () => {
    expect(isAboveNapasSingleTransfer(NAPAS_SINGLE_TRANSFER_LIMIT)).toBe(false);
    expect(isAboveNapasSingleTransfer(NAPAS_SINGLE_TRANSFER_LIMIT + 1)).toBe(
      true,
    );
    expect(isAboveNapasSingleTransfer(299_999_999)).toBe(false);
  });

  it("an toàn với giá trị rỗng/NaN/không phải số", () => {
    expect(isAboveNapasSingleTransfer(undefined)).toBe(false);
    expect(isAboveNapasSingleTransfer(null)).toBe(false);
    expect(isAboveNapasSingleTransfer(Number.NaN)).toBe(false);
    expect(isAboveNapasSingleTransfer(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("lời nhắc nêu rõ mốc và khẳng định mã vẫn tạo được (không chặn cứng)", () => {
    const hint = napasOverLimitHint();
    expect(hint).toContain("300.000.000");
    expect(hint).toMatch(/vẫn tạo/i);
  });
});

describe("Ánh xạ lỗi số tiền vượt trần kỹ thuật của một mã", () => {
  for (const code of [
    "INVALID_MONEY",
    "INVALID_PAYMENT_AMOUNT",
    "MONEY_OUT_OF_RANGE",
  ]) {
    it(`${code} → văn bản tiếng Việt nêu giới hạn, không chung chung`, () => {
      const message = friendlyError({ message: code });
      expect(message).toContain("1.000.000.000.000");
      expect(message).not.toBe(
        "Thông tin chưa hợp lệ. Vui lòng kiểm tra số tiền, ngày và các trường bắt buộc.",
      );
    });
  }
});

/**
 * Modal kiểm bằng hợp đồng nguồn (không có jsdom/RTL ở repo này) — cùng cách
 * tests/unit/vietqr-ui-flow.test.ts đang dùng. Chốt ba guardrail của lần sửa này
 * để một refactor sau không âm thầm hồi quy.
 */
const modalCode = readFileSync(
  "src/features/sales/VietQrPaymentModal.tsx",
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("VietQR modal — guardrail tạo lại và nhắc tiền lớn", () => {
  it("ẩn mã khi biểu mẫu đã đổi (canShowQr yêu cầu !changedDetails) để không quét nhầm số tiền", () => {
    const canShowQrBlock = modalCode.match(/const canShowQr =[\s\S]*?;/)?.[0];
    expect(canShowQrBlock).toContain("!changedDetails");
  });

  it("tự tạo lại khi đổi thông tin chỉ bị chặn bởi ổ khóa chống spam tại máy, không chờ server cooldown", () => {
    expect(modalCode).toMatch(
      /if \(!network\.online \|\| reissuePending \|\| spamCooldownSeconds > 0\) return;/,
    );
    expect(modalCode).not.toMatch(
      /if \(!network\.online \|\| reissuePending \|\| cooldownSeconds > 0\) return;/,
    );
    // Chống lặp lại lời gọi khi server từ chối: khóa theo bộ (mã|số tiền|tên).
    expect(modalCode).toContain("lastReissueKey");
    expect(modalCode).toContain("reissueKey");
  });

  it("số tiền vượt mốc ngân hàng vẫn hiển thị mã nhưng kèm lời nhắc hạn mức", () => {
    expect(modalCode).toContain("isAboveNapasSingleTransfer(amount)");
    expect(modalCode).toContain("napasOverLimitHint()");
    expect(modalCode).toContain("Số tiền lớn — kiểm tra hạn mức ngân hàng");
  });
});
