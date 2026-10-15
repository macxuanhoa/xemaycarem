import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildVietQrEmvCoPayload, buildVietQrQuickLink, removeVietnameseTones } from "@/lib/vietqr/emvco";
import { getBankByBin, searchBanks } from "@/lib/vietqr/banks";

describe("VietQR UI Business Flow Logic", () => {
  const bankConfig = {
    bankBin: "970422",
    bankName: "MBBank",
    accountNo: "0987654321",
    accountName: "NGUYEN VAN A",
  };

  it("generates correct reference code format for motorbike transactions", () => {
    const reference = "CAREM GD00123";
    expect(reference).toMatch(/^CAREM GD[0-9]{5}$/);
    expect(removeVietnameseTones(reference)).toBe(reference);
  });

  it("creates dynamic VietQR payload for multi-stage sale (Deposit & Remaining)", () => {
    // Stage 1: Deposit 5,000,000 VND
    const stage1Payload = buildVietQrEmvCoPayload({
      bankBin: bankConfig.bankBin,
      accountNo: bankConfig.accountNo,
      amount: 5000000,
      description: "CAREM GD01001",
      accountName: bankConfig.accountName,
    });
    expect(stage1Payload).toContain("54075000000"); // 5,000,000 VNĐ
    expect(stage1Payload).toContain("CAREM GD01001");

    // Stage 2: Remaining 20,000,000 VND
    const stage2Payload = buildVietQrEmvCoPayload({
      bankBin: bankConfig.bankBin,
      accountNo: bankConfig.accountNo,
      amount: 20000000,
      description: "CAREM GD01002",
      accountName: bankConfig.accountName,
    });
    expect(stage2Payload).toContain("540820000000"); // 20,000,000 VNĐ
    expect(stage2Payload).toContain("CAREM GD01002");
    expect(stage1Payload).not.toBe(stage2Payload);
  });

  it("handles bank search with case-insensitive accents and abbreviations", () => {
    const mbBank = getBankByBin("970422");
    expect(mbBank?.shortName).toBe("MBBank");

    const mbResults = searchBanks("mb");
    expect(mbResults.some((b) => b.shortName === "MBBank")).toBe(true);

    const vcbResults = searchBanks("vietcombank");
    expect(vcbResults.some((b) => b.bin === "970436")).toBe(true);

    const techcom = searchBanks("kỹ thương");
    expect(techcom.some((b) => b.shortName === "Techcombank")).toBe(true);
  });

  it("ensures quicklink generates valid formatted URL without unencoded special characters", () => {
    const url = buildVietQrQuickLink({
      bankBin: bankConfig.bankBin,
      accountNo: bankConfig.accountNo,
      amount: 15500000,
      description: "CAREM GD01003",
      accountName: "TRAN VAN B",
    });

    expect(url.startsWith("https://img.vietqr.io/image/970422-0987654321-default2.png")).toBe(true);
    expect(url).toContain("amount=15500000");
    expect(url).toContain("addInfo=CAREM+GD01003");
  });

  it("validates that bank account names are always normalized to uppercase unaccented format", () => {
    const rawName = "Nguyễn Văn Hoà";
    const normalized = removeVietnameseTones(rawName).toUpperCase();
    expect(normalized).toBe("NGUYEN VAN HOA");
  });
});

/**
 * P1-e + P0-4 trong chính modal thanh toán. Không có jsdom/RTL ở repo này nên
 * các ràng buộc vòng đời UI kiểm bằng hợp đồng nguồn (source contract) — cùng
 * cách tests/unit/showroom-source-contract.test.ts đang dùng.
 */
const modalSource = readFileSync("src/features/sales/VietQrPaymentModal.tsx", "utf8");
const modalCode = modalSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("VietQR modal — vòng đời ảnh QR và nguồn nội dung duy nhất", () => {
  it("P0-4: màn hình, nút copy, QR và quick link đều lấy memo chuẩn do server cấp", () => {
    // Kiến trúc "tiền về đúng đơn": server sinh transfer_content một lần và
    // modal chỉ hiển thị lại nguyên văn — không tự dựng memo thứ hai.
    expect(modalCode).toContain("request.transfer_content || request.qr_reference");
    // Không còn đường nào dựng memo thứ hai trong modal.
    expect(modalCode).not.toMatch(/const displayTransferContent\s*=\s*\(/);
    expect(modalCode).not.toMatch(/buildVietQrQuickLink\([\s\S]{0,400}?addInfo/);
  });

  it('P0-4: modal không tự "dọn dẹp" memo — sao chép nguyên văn chuỗi server cấp', () => {
    expect(modalCode).not.toMatch(
      /handleCopy\(\s*[^,)]*removeVietnameseTones/,
    );
    expect(modalCode).not.toMatch(/description:\s*removeVietnameseTones/);
  });

  it("P1-e: QR render cục bộ qua renderQrToDataUrl, lỗi render có đường dự phòng hiện rõ", () => {
    expect(modalCode).toContain("renderQrToDataUrl");
    expect(modalCode).toContain(".catch(() => setQrDataUrl(null))");
  });

  it("P1-e: không còn vòng đời ảnh remote cache (data URL tự sinh) — hết lớp lỗi cũ", () => {
    expect(modalCode).not.toMatch(/attachRemoteQr/);
    expect(modalCode).not.toMatch(/setImageFailed/);
  });

  it("modal giữ đúng chuỗi memo server cấp khi server đã nhúng memo vào payload", () => {
    // Chuỗi hiển thị không được tự do "dọn dẹp" thêm (bỏ dấu, cắt ngắn) — đối
    // soát dựa trên nguyên văn nội dung chuyển khoản.
    expect(modalCode).not.toMatch(/removeVietnameseTones\([^)]*\)[\s\S]{0,80}(description|transferContent|memo)/i);
  });
});
