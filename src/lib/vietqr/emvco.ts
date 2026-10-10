/**
 * Bộ tạo mã VietQR theo chuẩn EMVCo & Napas 247
 * Hỗ trợ tạo Payload EMVCo chuẩn (quét trực tiếp mọi App ngân hàng offline)
 * và Quick Link VietQR.io (ảnh mẫu thẻ có logo ngân hàng).
 */
import QRCode from "qrcode";

export type VietQrPayloadOptions = {
  bankBin: string;
  accountNo: string;
  amount?: number;
  description: string;
  accountName?: string;
};

/**
 * Loại bỏ dấu tiếng Việt và ký tự đặc biệt theo chuẩn chuyển khoản ngân hàng
 */
export function removeVietnameseTones(str: string): string {
  if (!str) return "";
  let result = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  result = result.replace(/[đĐ]/g, (m) => (m === "đ" ? "d" : "D"));
  // Chỉ giữ chữ cái, chữ số, khoảng trắng và dấu gạch nối cơ bản
  result = result.replace(/[^a-zA-Z0-9\s-_]/g, " ");
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Định dạng tag EMVCo: ID (2 chữ số) + Độ dài (2 chữ số) + Giá trị
 */
function emvFormat(id: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${id}${len}${value}`;
}

/**
 * Thuật toán tính CRC16-CCITT (Polynomial 0x1021, Init 0xFFFF)
 * Chuẩn quốc tế theo EMVCo Specification
 */
export function calculateCrc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data.charCodeAt(i) & 0xff) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Sinh chuỗi EMVCo Payload VietQR (Napas 247)
 * Mọi ứng dụng ngân hàng tại Việt Nam đều quét và tự động điền đầy đủ
 * số tài khoản, ngân hàng, số tiền và nội dung chuyển khoản.
 */
export function buildVietQrEmvCoPayload(options: VietQrPayloadOptions): string {
  const { bankBin, accountNo, amount, description } = options;
  const cleanBin = bankBin.trim();
  const cleanAccount = accountNo.trim();
  const cleanDesc = removeVietnameseTones(description).slice(0, 50);

  // Tag 00: Format Indicator (01)
  const tag00 = emvFormat("00", "01");

  // Tag 01: Initiation Method (12: Dynamic QR - có số tiền cụ thể; 11: Static QR)
  const tag01 = emvFormat("01", amount && amount > 0 ? "12" : "11");

  // Tag 38: Merchant Account Information cho NAPAS
  // Subtag 00: GUID Napas (A000000727)
  const sub00 = emvFormat("00", "A000000727");
  // Subtag 01: Thông tin tài khoản thụ hưởng (Sub-sub 00: Mã BIN ngân hàng 6 số, Sub-sub 01: Số TK)
  const subSub00 = emvFormat("00", cleanBin);
  const subSub01 = emvFormat("01", cleanAccount);
  const sub01 = emvFormat("01", `${subSub00}${subSub01}`);
  // Subtag 02: Mã dịch vụ chuyển khoản nhanh 24/7 (QRIBFTTA)
  const sub02 = emvFormat("02", "QRIBFTTA");
  const tag38 = emvFormat("38", `${sub00}${sub01}${sub02}`);

  // Tag 53: Transaction Currency (704 = Việt Nam Đồng VND)
  const tag53 = emvFormat("53", "704");

  // Tag 54: Transaction Amount (nếu có số tiền)
  let tag54 = "";
  if (amount && amount > 0) {
    tag54 = emvFormat("54", Math.round(amount).toString());
  }

  // Tag 58: Country Code (VN)
  const tag58 = emvFormat("58", "VN");

  // Tag 62: Additional Data Field (Nội dung chuyển khoản - subtag 08)
  let tag62 = "";
  if (cleanDesc) {
    const sub62_08 = emvFormat("08", cleanDesc);
    tag62 = emvFormat("62", sub62_08);
  }

  // Ghép toàn bộ chuỗi trước khi tính CRC
  const rawPayload = `${tag00}${tag01}${tag38}${tag53}${tag54}${tag58}${tag62}6304`;
  const checksum = calculateCrc16(rawPayload);

  return `${rawPayload}${checksum}`;
}

/**
 * Tạo Quick Link ảnh VietQR (chuẩn VietQR.io)
 * Mẫu thẻ có sẵn logo Napas và logo ngân hàng nhận
 */
export function buildVietQrQuickLink(
  options: VietQrPayloadOptions,
  template: "compact2" | "compact" | "qr_only" = "compact2",
): string {
  const { bankBin, accountNo, amount, description, accountName } = options;
  const cleanBin = bankBin.trim();
  const cleanAccount = accountNo.trim();
  const cleanDesc = removeVietnameseTones(description).slice(0, 50);
  const cleanName = accountName ? removeVietnameseTones(accountName).toUpperCase() : "";

  const params = new URLSearchParams();
  if (amount && amount > 0) {
    params.set("amount", Math.round(amount).toString());
  }
  if (cleanDesc) {
    params.set("addInfo", cleanDesc);
  }
  if (cleanName) {
    params.set("accountName", cleanName);
  }

  const query = params.toString();
  return `https://img.vietqr.io/image/${cleanBin}-${cleanAccount}-${template}.png${query ? `?${query}` : ""}`;
}

/**
 * Render chuỗi mã QR sang Data URL (PNG base64) cho Canvas / Ảnh
 */
export async function renderQrToDataUrl(payload: string, width = 360): Promise<string> {
  return QRCode.toDataURL(payload, {
    width,
    margin: 2,
    errorCorrectionLevel: "M",
    color: {
      dark: "#0b261a",
      light: "#ffffff",
    },
  });
}

/**
 * Render chuỗi mã QR sang chuỗi SVG vector sắc nét
 */
export async function renderQrToSvg(payload: string, size = 320): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    width: size,
    margin: 2,
    errorCorrectionLevel: "M",
    color: {
      dark: "#0b261a",
      light: "#ffffff",
    },
  });
}
