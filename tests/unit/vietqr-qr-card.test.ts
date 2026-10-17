import { describe, expect, it } from "vitest";
import {
  planQrCardLayout,
  wrapText,
  type MeasureText,
  type QrCardModel,
  type QrTextOp,
} from "@/lib/vietqr/qrCardImage";
import { composeTransferCopyLine } from "@/lib/vietqr/transferContent";

/**
 * Ảnh thẻ chuyển khoản được kiểm ở tầng BỐ CỤC (planQrCardLayout là hàm thuần),
 * vì trình vẽ canvas thật chỉ chạy trên trình duyệt. Nhánh ngẫu nhiên rải chữ ký
 * cũng tất định theo `seedKey` nên những ràng buộc dưới đây ổn định qua mỗi lần chạy.
 */
const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  // Allura gầy, mono/jakarta rộng hơn: 0.42em là đủ để so chỗ đặt chữ.
  return text.length * size * 0.42;
};

const model = (overrides: Partial<QrCardModel> = {}): QrCardModel => ({
  amountLabel: "35.000.000 ₫",
  transferContent: "CAREM GD00123 (Xe tay ga)",
  bankName: "Vietcombank",
  accountNo: "0987654321",
  accountName: "CA REM TEST",
  seedKey: "CAREM GD00123|35000000|CAREM GD00123 (Xe tay ga)",
  ...overrides,
});

const texts = (
  layout: ReturnType<typeof planQrCardLayout>,
  role: QrTextOp["role"],
): QrTextOp[] =>
  layout.ops.filter(
    (op): op is QrTextOp => op.kind === "text" && op.role === role,
  );

/** Hộp bao của một dòng chữ nghiêng quanh tâm — cùng phép tính với bộ rải chữ ký. */
function boxOf(op: QrTextOp) {
  const width = measure(op.text, op.font);
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(op.font)?.[1] ?? 16);
  const rad = ((op.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const height = size * 0.95;
  const boxWidth = width * cos + height * sin;
  const boxHeight = width * sin + height * cos;
  return {
    x0: op.x - boxWidth / 2,
    y0: op.y - boxHeight / 2,
    x1: op.x + boxWidth / 2,
    y1: op.y + boxHeight / 2,
  };
}

describe("vietqr/qrCardImage — số tiền và nội dung nằm trong ảnh", () => {
  it("đưa đúng số tiền và nguyên văn nội dung chuyển khoản vào tấm ảnh", () => {
    const layout = planQrCardLayout(model(), measure);
    expect(texts(layout, "amount")).toHaveLength(1);
    expect(texts(layout, "amount")[0].text).toBe("35.000.000 ₫");
    // Memo ngắn đi một hàng: nguyên văn, không thêm bớt ký tự.
    const content = texts(layout, "content");
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe("CAREM GD00123 (Xe tay ga)");
    expect(layout.ops.filter((op) => op.kind === "qr")).toHaveLength(1);
  });

  it("memo dài trần Napas 130 ký tự vẫn nguyên văn, ảnh chỉ cao thêm", () => {
    const longMemo = `${"CAREM GD00123 (Honda Gold Wing Tour 2026 màu xám xanh".padEnd(
      128,
      "x",
    )})`;
    const layout = planQrCardLayout(
      model({ transferContent: longMemo, seedKey: `long|${longMemo}` }),
      measure,
    );
    const joined = texts(layout, "content")
      .map((line) => line.text)
      .join(" ");
    // Hàng mới được ngắt tại khoảng trắng: so bỏ khoảng trắng để chốt không mất ký tự nào.
    expect(joined.replace(/\s+/g, "")).toBe(longMemo.replace(/\s+/g, ""));
    expect(texts(layout, "content").length).toBeGreaterThan(1);
  });

  it("hàng nội dung không bao giờ rộng quá khổ ảnh", () => {
    const layout = planQrCardLayout(
      model({ transferContent: "CAREMGD00123XETAYGASIÊUDÀI".repeat(5) }),
      measure,
    );
    const inner = layout.width - 72;
    for (const line of texts(layout, "content"))
      expect(measure(line.text, line.font)).toBeLessThanOrEqual(inner);
  });
});

describe('vietqr/qrCardImage — dấu "Cà Rem" rải quanh mã', () => {
  it("nhiều bản sao, không bản nào đè lên mã QR", () => {
    const layout = planQrCardLayout(model(), measure);
    const marks = texts(layout, "watermark");
    expect(marks.length).toBeGreaterThanOrEqual(3);
    expect(marks.every((mark) => mark.text === "Cà Rem")).toBe(true);
    const qr = layout.qr;
    for (const mark of marks) {
      const box = boxOf(mark);
      const overlapsQr =
        box.x0 < qr.x + qr.size &&
        qr.x < box.x1 &&
        box.y0 < qr.y + qr.size &&
        qr.y < box.y1;
      expect(overlapsQr).toBe(false);
    }
  });

  it("không đặt chữ phía dưới mã — chỗ đó của số tiền và nội dung", () => {
    const layout = planQrCardLayout(model(), measure);
    const qrBottom = layout.qr.y + layout.qr.size;
    for (const mark of texts(layout, "watermark"))
      expect(boxOf(mark).y1).toBeLessThanOrEqual(qrBottom);
  });

  it("chữ ký không chồng nhau và không lọt ra ngoài mép ảnh", () => {
    const layout = planQrCardLayout(model(), measure);
    const boxes = texts(layout, "watermark").map(boxOf);
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(
          false,
        );
      }
    for (const box of boxes) {
      expect(box.x0).toBeGreaterThanOrEqual(0);
      expect(box.y0).toBeGreaterThanOrEqual(0);
      expect(box.x1).toBeLessThanOrEqual(layout.width);
      expect(box.y1).toBeLessThanOrEqual(layout.height);
    }
  });

  it("cùng một mã QR ra đúng một bố cục; mã khác đi chữ ký khác chỗ", () => {
    const first = planQrCardLayout(model(), measure);
    const again = planQrCardLayout(model(), measure);
    expect(texts(again, "watermark").map(boxOf)).toEqual(
      texts(first, "watermark").map(boxOf),
    );
    const other = planQrCardLayout(
      model({
        transferContent: "CAREM GD00999 (Xe tay ga)",
        seedKey: "CAREM GD00999|35000000|CAREM GD00999 (Xe tay ga)",
      }),
      measure,
    );
    const shift = texts(first, "watermark").map((mark, i) => {
      const next = texts(other, "watermark")[i];
      return next ? Math.abs(next.x - mark.x) + Math.abs(next.y - mark.y) : 1;
    });
    expect(Math.max(...shift)).toBeGreaterThan(0);
  });

  it("mờ nhẹ như dấu nước và xoay nghiêng như chữ ký tay", () => {
    for (const mark of texts(planQrCardLayout(model(), measure), "watermark")) {
      expect(mark.opacity ?? 0).toBeGreaterThan(0);
      expect(mark.opacity ?? 1).toBeLessThan(0.4);
      expect(Math.abs(mark.rotate ?? 0)).toBeLessThanOrEqual(22);
    }
  });
});

describe("vietqr/qrCardImage — tách hàng", () => {
  it("một từ đơn dài hơn khổ bị cắt theo ký tự chứ không tràn ra ngoài", () => {
    const lines = wrapText(
      measure,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "500 20px x",
      40,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(measure(line, "500 20px x")).toBeLessThanOrEqual(40);
    expect(lines.join("")).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("giữ nguyên khoảng trắng giữa các từ khi vừa khổ", () => {
    expect(
      wrapText(measure, "CAREM GD00123 (Xe tay ga)", "500 20px x", 400),
    ).toEqual(["CAREM GD00123 (Xe tay ga)"]);
  });
});

describe("vietqr/transferContent — một click chép cả câu", () => {
  it("ghép số tiền với nội dung thành đúng một chuỗi gửi được", () => {
    expect(
      composeTransferCopyLine("35.000.000 ₫", "CAREM GD00123 (Xe tay ga)"),
    ).toBe("35.000.000 ₫ - CAREM GD00123 (Xe tay ga)");
  });

  it("thiếu một vế thì trả vế còn lại, không sinh dấu nối thừa", () => {
    expect(composeTransferCopyLine("", "CAREM GD00123")).toBe("CAREM GD00123");
    expect(composeTransferCopyLine("35.000.000 ₫", "")).toBe("35.000.000 ₫");
    expect(composeTransferCopyLine("", "")).toBe("");
  });
});
