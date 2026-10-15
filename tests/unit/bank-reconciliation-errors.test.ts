import { describe, expect, it, vi } from "vitest";
import { friendlyError } from "@/lib/errors";

describe("bank reconciliation errors identify the failed guard", () => {
  vi.stubGlobal("navigator", { onLine: true });
  it.each([
    ["BANK_WEBHOOK_NOT_CONFIGURED", /chưa được cấu hình đầy đủ/],
    ["BANK_PROVIDER_MISMATCH", /dịch vụ ngân hàng khác/],
    ["BANK_ACCOUNT_MISMATCH", /Tài khoản nhận tiền không khớp/],
    ["BANK_TRANSACTION_AMOUNT_MISMATCH", /Số tiền ngân hàng nhận không khớp/],
    ["VIETQR_REQUEST_NOT_PENDING", /không còn chờ thanh toán/],
  ])("%s gives an actionable message", (code, expected) => {
    expect(friendlyError({ code: "22023", message: code })).toMatch(expected);
  });
});
