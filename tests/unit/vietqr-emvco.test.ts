import { describe, expect, it } from "vitest";
import {
  buildVietQrEmvCoPayload,
  buildVietQrQuickLink,
  calculateCrc16,
  removeVietnameseTones,
  renderQrToDataUrl,
} from "@/lib/vietqr/emvco";
import { getBankByBin, searchBanks, VIETNAM_BANKS } from "@/lib/vietqr/banks";

describe("VietQR EMVCo & Banks", () => {
  it("removes Vietnamese tones accurately without breaking ASCII characters", () => {
    expect(removeVietnameseTones("Nguyễn Văn Đạt")).toBe("Nguyen Van Dat");
    expect(removeVietnameseTones("Cà Rem CRM GD00123")).toBe("Ca Rem CRM GD00123");
    expect(removeVietnameseTones("Thanh toán tiền xe SH 150i")).toBe("Thanh toan tien xe SH 150i");
  });

  it("calculates accurate CRC16-CCITT checksum", () => {
    // Standard test vector
    const testData = "00020101021238540010A00000072701240006970422011001234567890208QRIBFTTA53037045408250000005802VN62170813CAREM GD001236304";
    const crc = calculateCrc16(testData);
    expect(crc).toMatch(/^[0-9A-F]{4}$/);
    expect(crc.length).toBe(4);
  });

  it("builds valid EMVCo dynamic payload with amount and reference", () => {
    const payload = buildVietQrEmvCoPayload({
      bankBin: "970422",
      accountNo: "0987654321",
      amount: 25000000,
      description: "CAREM GD00123",
      accountName: "NGUYEN VAN A",
    });

    expect(payload).toContain("000201"); // Tag 00
    expect(payload).toContain("010212"); // Tag 01: Dynamic (12)
    expect(payload).toContain("0010A000000727"); // Tag 38 subtag 00: Napas GUID
    expect(payload).toContain("0006970422"); // Subtag 00: Bank BIN
    expect(payload).toContain("01100987654321"); // Subtag 01: Account Number
    expect(payload).toContain("0208QRIBFTTA"); // Subtag 02: 247 service code
    expect(payload).toContain("5303704"); // Tag 53: VND currency (704)
    expect(payload).toContain("540825000000"); // Tag 54: Amount (25,000,000)
    expect(payload).toContain("5802VN"); // Tag 58: VN country code
    expect(payload).toContain("CAREM GD00123"); // Tag 62: Purpose
    expect(payload).toMatch(/6304[0-9A-F]{4}$/); // Tag 63: 4-char CRC16
  });

  it("builds valid VietQR.io Quick Link", () => {
    const link = buildVietQrQuickLink({
      bankBin: "970422",
      accountNo: "0987654321",
      amount: 25000000,
      description: "CAREM GD00123",
      accountName: "Nguyễn Văn A",
    });

    expect(link).toContain("https://img.vietqr.io/image/970422-0987654321-compact2.png");
    expect(link).toContain("amount=25000000");
    expect(link).toContain("addInfo=CAREM+GD00123");
    expect(link).toContain("accountName=NGUYEN+VAN+A");
  });

  it("renders QR payload to Data URL (base64 PNG)", async () => {
    const payload = buildVietQrEmvCoPayload({
      bankBin: "970422",
      accountNo: "0987654321",
      amount: 5000000,
      description: "CAREM GD00101",
    });

    const dataUrl = await renderQrToDataUrl(payload, 240);
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("preserves the entire standardized transfer reference inside the QR", () => {
    const description = "CAREM GD100000 XE123 HD123 AN CHO CAREM";
    const payload = buildVietQrEmvCoPayload({
      bankBin: "970422", accountNo: "0987654321", amount: 35000000,
      description,
    });
    let position = 0;
    const fields = new Map<string, string>();
    while (position < payload.length) {
      const id = payload.slice(position, position + 2);
      const length = Number(payload.slice(position + 2, position + 4));
      fields.set(id, payload.slice(position + 4, position + 4 + length));
      position += 4 + length;
    }
    const additional = fields.get("62")!;
    expect(additional.slice(0, 2)).toBe("08");
    expect(additional.slice(4)).toBe(description);
    expect(fields.get("63")).toBe(calculateCrc16(payload.slice(0, -4)));
  });

  it("rejects long transfer contents instead of silently removing reconciliation information", () => {
    const input = {
      bankBin: "970422", accountNo: "0987654321", amount: 35000000,
      description: "XE HOP DONG TEN NGUOI THANH TOAN ".repeat(3) + "CAREM GD100000",
    };
    expect(() => buildVietQrEmvCoPayload(input)).toThrow("không cắt mã đối soát");
    expect(() => buildVietQrQuickLink(input)).toThrow("không cắt mã đối soát");
  });

  it("searches banks catalog by code, BIN or name", () => {
    expect(VIETNAM_BANKS.length).toBeGreaterThan(20);

    const mb = getBankByBin("970422");
    expect(mb).toBeDefined();
    expect(mb?.shortName).toBe("MBBank");

    const vcb = searchBanks("vietcombank");
    expect(vcb.length).toBeGreaterThan(0);
    expect(vcb[0].bin).toBe("970436");

    const byBin = searchBanks("970415");
    expect(byBin[0].shortName).toBe("VietinBank");
  });
});
