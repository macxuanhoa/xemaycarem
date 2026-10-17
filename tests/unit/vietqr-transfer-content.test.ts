import { describe, expect, it } from "vitest";
import {
  buildVietQrEmvCoPayload,
  buildVietQrQuickLink,
  TRANSFER_CONTENT_LIMIT,
} from "@/lib/vietqr/emvco";
import {
  composeTransferContent,
  containsReference,
  FALLBACK_TRANSFER_CONTENT,
  resolveTransferContent,
  selectQrTransferContent,
  transferContentFromPayload,
  utf8Length,
} from "@/lib/vietqr/transferContent";

const BIN = "970422";
const ACCOUNT_NO = "0987654321";
const ACCOUNT_NAME = "Cua Hang Xe May Ca Rem";
const REF = "CAREM GD00123";

/** Đúng bối cảnh màn hình bán hàng cấp cho memo dự phòng. */
const screenContext = {
  payerName: "Nguyễn Thị Cà Rem",
  vehicleName: "Honda Wave Alpha",
  internalCode: "CR-0417",
};

/** Phần `addInfo` của ảnh img.vietqr.io — `+` là dấu cách đã encode. */
function addInfoFromQuickLink(url: string): string | null {
  const raw = new URL(url).searchParams.get("addInfo");
  return raw === null ? null : raw;
}

describe("vietqr/transferContent — đọc lại memo từ payload EMVCo", () => {
  it("đọc đúng memo có dấu, không cắt mà payload vừa nhúng (tag 62 / sub-tag 08)", () => {
    const memo = `${REF} Nguyễn Thị Cà Rem thanh toán tiền xe Honda Wave Alpha - CR-0417`;
    const payload = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 32_500_000,
      description: memo,
      accountName: ACCOUNT_NAME,
    });

    expect(transferContentFromPayload(payload)).toBe(memo);
  });

  it("trả null khi payload không có tag 62, không nhầm dữ liệu bên trong thành tag", () => {
    const noMemo = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 1_000_000,
      description: "",
    });
    expect(transferContentFromPayload(noMemo)).toBeNull();
  });

  it("đọc theo byte nên memo có dấu vẫn nguyên văn dù độ dài TLV lớn hơn độ dài ký tự", () => {
    const memo = `${REF} Hoàng Thị Thúy thanh toán tiền xe Honda Vision 2023`;
    const payload = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 32_500_000,
      description: memo,
    });
    expect(utf8Length(memo)).toBeGreaterThan(memo.length);
    expect(transferContentFromPayload(payload)).toBe(memo);
  });

  it("chối chuỗi không phải EMVCo hoặc dài giả mạo thay vì ném lỗi", () => {
    expect(transferContentFromPayload("")).toBeNull();
    expect(transferContentFromPayload(null)).toBeNull();
    expect(transferContentFromPayload("00020103")).toBeNull();
    // tag 62 khai dài 99 nhưng chuỗi cụt: phải dừng an toàn.
    expect(transferContentFromPayload("000201" + "6299" + "0801A")).toBeNull();
  });
});

describe("vietqr/transferContent — MỘT nguồn duy nhất cho mã và màn hình", () => {
  it("yêu cầu chưa có memo — màn hình và QR cùng dùng mã và tên xe trong ngoặc", () => {
    const request = {
      qr_reference: REF,
      transfer_content: "",
      qr_payload: "",
      payer_name: "Nguyễn Thị Cà Rem",
    };
    const description = resolveTransferContent(request, screenContext);
    const payload = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 32_500_000,
      description,
      accountName: ACCOUNT_NAME,
    });
    const imageUrl = buildVietQrQuickLink(
      { bankBin: BIN, accountNo: ACCOUNT_NO, amount: 32_500_000, description, accountName: ACCOUNT_NAME },
      "default2",
    );

    expect(transferContentFromPayload(payload)).toBe(description);
    expect(addInfoFromQuickLink(imageUrl)).toBe(description);
    expect(description).toBe(`${REF} (Honda Wave Alpha)`);
  });

  it("giữ tên xe chụp trong memo ngắn của server dù tên trên màn hình đã đổi", () => {
    const serverMemo = `${REF} (Yamaha NVX)`;
    const request = {
      qr_reference: REF,
      transfer_content: serverMemo,
      qr_payload: "",
      payer_name: "Khác",
    };

    expect(resolveTransferContent(request, screenContext)).toBe(serverMemo);
  });

  it("đọc tên xe từ payload ngắn khi server chưa cấp memo", () => {
    const scannedMemo = `${REF} (Vario)`;
    const payload = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 45_000_000,
      description: scannedMemo,
      accountName: ACCOUNT_NAME,
    });

    expect(
      resolveTransferContent(
        {
          qr_reference: REF,
          transfer_content: "transfer_content lệch với payload",
          qr_payload: payload,
          payer_name: "Ai đó",
        },
        screenContext,
      ),
    ).toBe(scannedMemo);
  });

  it("thiếu mọi dữ liệu vẫn có memo tối thiểu, không rỗng", () => {
    expect(resolveTransferContent(null, {})).toBe(FALLBACK_TRANSFER_CONTENT);
    expect(resolveTransferContent({ qr_reference: "" }, {})).toBe(FALLBACK_TRANSFER_CONTENT);
  });

  it("không phát hành memo thiếu mã đối soát — webhook sẽ rơi vào UNMATCHED", () => {
    const memo = resolveTransferContent(
      { qr_reference: REF, transfer_content: "Thanh toan mua xe", qr_payload: "", payer_name: "" },
      screenContext,
    );

    expect(memo).not.toBe("Thanh toan mua xe");
    expect(containsReference(memo, REF)).toBe(true);
    expect(transferContentFromPayload(
      buildVietQrEmvCoPayload({ bankBin: BIN, accountNo: ACCOUNT_NO, amount: 1000, description: memo }),
    )).toBe(memo);
  });
});

describe("vietqr/transferContent — memo dự phòng theo quy tắc server", () => {
  it("giữ nguyên mã, chỉ thêm tên xe trong ngoặc; bỏ tên khách và mã kho", () => {
    const memo = composeTransferContent({
      reference: REF,
      payerName: "Nguyễn Thị Cà Rem",
      vehicleName: "Honda Wave Alpha",
      internalCode: "CR-0417",
    });

    expect(memo.startsWith(`${REF} `)).toBe(true);
    expect(memo).toBe(`${REF} (Honda Wave Alpha)`);
  });

  it("chỉ rút gọn tên xe quá dài, giữ nguyên mã và ngoặc đóng", () => {
    const memo = composeTransferContent({
      reference: REF,
      payerName: "Khách hàng có cái tên cực kỳ dài ".repeat(8),
      vehicleName: "Honda Wave Alpha màu xanh dương ".repeat(8),
      internalCode: "CR-0417",
    });

    expect(memo.length).toBeLessThanOrEqual(TRANSFER_CONTENT_LIMIT);
    // memo phải nhúng vừa thẻ EMVCo (2 chữ số độ dài) — không phát hành mã lệch.
    expect(utf8Length(memo)).toBeLessThanOrEqual(95);
    expect(memo.startsWith(`${REF} `)).toBe(true);
    expect(memo.endsWith(")")).toBe(true);
    expect(memo).not.toContain("Khách hàng");
    expect(memo).not.toContain("CR-0417");
    // Memo nén vẫn trích được "CAREMGD<5 số>" đúng như ingest_bank_transaction.
    expect(containsReference(memo, REF)).toBe(true);
    expect(transferContentFromPayload(
      buildVietQrEmvCoPayload({ bankBin: BIN, accountNo: ACCOUNT_NO, amount: 1000, description: memo }),
    )).toBe(memo);
  });

  it("tên xe rỗng dùng xe, không đưa tên khách vào memo", () => {
    expect(composeTransferContent({ reference: REF, payerName: "Trần B" })).toBe(
      `${REF} (xe)`,
    );
  });

  it("nhớ mã đối soát ngay cả khi tên xe quá dài", () => {
    const memo = composeTransferContent({
      reference: REF,
      payerName: "Trần Văn Bảy",
      vehicleName: "Honda Wave Alpha 2024 phiên bản đặc biệt màu xanh dương đỏ đen",
      internalCode: "CR-0417",
    });

    expect(utf8Length(memo)).toBeLessThanOrEqual(95);
    expect(memo.startsWith(`${REF} `)).toBe(true);
    expect(containsReference(memo, REF)).toBe(true);
  });

  it("so khớp memo theo đúng cách nén của ingest_bank_transaction", () => {
    // Memo nén bỏ mọi ký tự phân tách, nên viết hoa/thường và khoảng trắng không ảnh hưởng.
    expect(containsReference("carem gd 00123 khách mua xe", REF)).toBe(true);
    expect(containsReference("Thanh toan don hang 00123", REF)).toBe(false);
    expect(containsReference(REF, "CAREM GD99999")).toBe(false);
    expect(containsReference(REF, "")).toBe(false);
    expect(containsReference(`${REF}1 (Honda Vision)`, REF)).toBe(false);
    expect(containsReference(`${REF} (125cc)`, REF)).toBe(true);
    expect(containsReference("CAREM GD100000 (67)", "CAREM GD100000")).toBe(true);
    expect(containsReference("(c-a.r/e(m) g(d)00123) (125cc)", REF)).toBe(true);
    expect(containsReference("CAREM GD10000(0) (125cc)", "CAREM GD10000")).toBe(false);
    expect(containsReference("CAREM GD100000(125cc)", "CAREM GD100000125")).toBe(false);
    expect(containsReference("CARE(M) GD100000(125cc)", "CAREM GD100000125")).toBe(false);
  });
});

/**
 * Memo từ phiên bản server cũ (`20261014000700_vietqr_full_wording_memo`):
 *   v_content := v_payer_text || ' thanh toán tiền xe ' || tên || ' - ' || mã nội bộ
 *                || ' với giá: ' || giá || '; Mã giao dịch là: ' || v_ref
 * Server chỉ trần 130 KÝ TỰ, còn thẻ EMVCo chứa nổi 95 BYTE. Memo hợp lệ của
 * server vì thế thường KHÔNG nhét vừa mã QR — và bản cũ hiển thị memo dài trong
 * khi mã lại mang chuỗi ngắn hơn. Mẫu mới thay toàn bộ phần mô tả cũ bằng tên
 * xe trong ngoặc và dùng cùng chuỗi cho màn hình, Copy, ảnh và payload.
 */
const LIVE_SERVER_MEMO =
  "Nguyễn Thị Cà Rem thanh toán tiền xe Honda Wave Alpha - CR-0417 với giá: 17.500.000; Mã giao dịch là: " +
  REF;

describe("vietqr/transferContent — P0-4: một memo duy nhất cho mọi kênh phát hành mã", () => {
  it("memo hợp lệ của server thực sự vượt trần byte EMVCo (bằng chứng lỗi gốc)", () => {
    expect(LIVE_SERVER_MEMO.length).toBeLessThanOrEqual(TRANSFER_CONTENT_LIMIT);
    expect(utf8Length(LIVE_SERVER_MEMO)).toBeGreaterThan(95);
    expect(() =>
      buildVietQrEmvCoPayload({
        bankBin: BIN,
        accountNo: ACCOUNT_NO,
        amount: 17_500_000,
        description: LIVE_SERVER_MEMO,
        accountName: ACCOUNT_NAME,
      }),
    ).toThrow();
  });

  it("rút gọn xuống bản vừa cả hai trần nhưng vẫn giữ nguyên mã đối soát", () => {
    const content = selectQrTransferContent(
      { qr_reference: REF, transfer_content: LIVE_SERVER_MEMO, qr_payload: "" },
      screenContext,
    );

    expect(content.length).toBeLessThanOrEqual(TRANSFER_CONTENT_LIMIT);
    expect(utf8Length(content)).toBeLessThanOrEqual(95);
    expect(containsReference(content, REF)).toBe(true);
    expect(content.startsWith(`${REF} `)).toBe(true);
    expect(content).toBe(`${REF} (Honda Wave Alpha)`);
    // Không bao giờ trả về nguyên memo dài của server.
    expect(content).not.toBe(LIVE_SERVER_MEMO);
  });

  it("payload EMVCo vẽ tại máy giải mã ra ĐÚNG chuỗi đang hiển thị", () => {
    const content = selectQrTransferContent(
      { qr_reference: REF, transfer_content: LIVE_SERVER_MEMO, qr_payload: "" },
      screenContext,
    );
    const payload = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 17_500_000,
      description: content,
      accountName: ACCOUNT_NAME,
    });

    expect(transferContentFromPayload(payload)).toBe(content);
  });

  it("ảnh quick link và payload nội bộ mang cùng một nội dung — không còn hai mã lệch nhau", () => {
    const content = selectQrTransferContent(
      { qr_reference: REF, transfer_content: LIVE_SERVER_MEMO, qr_payload: "" },
      screenContext,
    );
    const imageUrl = buildVietQrQuickLink(
      { bankBin: BIN, accountNo: ACCOUNT_NO, amount: 17_500_000, description: content, accountName: ACCOUNT_NAME },
      "default2",
    );
    const emvco = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 17_500_000,
      description: content,
      accountName: ACCOUNT_NAME,
    });

    expect(addInfoFromQuickLink(imageUrl)).toBe(content);
    expect(transferContentFromPayload(emvco)).toBe(addInfoFromQuickLink(imageUrl));
  });

  it("memo ngắn đúng mẫu mới của server giữ nguyên văn", () => {
    const short = `${REF} (Honda Wave Alpha)`;
    expect(utf8Length(short)).toBeLessThanOrEqual(95);
    expect(
      selectQrTransferContent({ qr_reference: REF, transfer_content: short, qr_payload: "" }, screenContext),
    ).toBe(short);
  });

  it("request không có mã đối soát thì giữ nguyên memo server, không bịa mã", () => {
    expect(
      selectQrTransferContent({ qr_reference: "", transfer_content: "Thanh toán theo hợp đồng HD-77", qr_payload: "" }, screenContext),
    ).toBe("Thanh toán theo hợp đồng HD-77");
  });

  it("server chưa cấp memo thì tự dựng memo dự phòng vừa chuẩn, vẫn đối soát được", () => {
    const content = selectQrTransferContent(
      { qr_reference: REF, transfer_content: "", qr_payload: "", payer_name: "Trần Văn Bảy" },
      screenContext,
    );

    expect(utf8Length(content)).toBeLessThanOrEqual(95);
    expect(containsReference(content, REF)).toBe(true);
    expect(content).toBe(`${REF} (Honda Wave Alpha)`);
  });

  it("QR cũ có tên khách được thay bằng mẫu ngắn từ tên xe trên màn hình", () => {
    const embedded = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      amount: 17_500_000,
      description: `${REF} Trần Văn Tám thanh toán tiền xe Yamaha NVX`,
      accountName: ACCOUNT_NAME,
    });

    expect(
      selectQrTransferContent(
        { qr_reference: REF, transfer_content: LIVE_SERVER_MEMO, qr_payload: embedded },
        screenContext,
      ),
    ).toBe(`${REF} (Honda Wave Alpha)`);
  });

  it("memo ngắn từ server được ưu tiên hơn payload cũ", () => {
    const embedded = buildVietQrEmvCoPayload({
      bankBin: BIN,
      accountNo: ACCOUNT_NO,
      description: `${REF} (Vario)`,
    });
    expect(selectQrTransferContent({
      qr_reference: REF,
      transfer_content: `${REF} (Honda Vision)`,
      qr_payload: embedded,
    }, screenContext)).toBe(`${REF} (Honda Vision)`);
  });

  it("không lấy tên từ memo của mã khác hoặc từ tên khách khi thiếu tên xe", () => {
    expect(selectQrTransferContent({
      qr_reference: REF,
      transfer_content: "CAREM GD99999 (Honda Vision)",
      payer_name: "Nguyễn Văn An",
    })).toBe(`${REF} (xe)`);
  });

  it("giữ nguyên mã trên 5 chữ số và tên xe bắt đầu bằng số", () => {
    expect(selectQrTransferContent({ qr_reference: "CAREM GD100000" }, {
      vehicleName: "125cc",
    })).toBe("CAREM GD100000 (125cc)");
  });
});
