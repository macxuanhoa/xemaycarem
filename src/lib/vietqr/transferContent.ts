/**
 * NỘI DUNG CHUYỂN KHOẢN VietQR — MỘT nguồn duy nhất.
 *
 * Ba thứ bắt buộc trùng nhau từng ký tự:
 *   1. chuỗi nhúng vào mã QR (EMVCo tag 62 / sub-tag 08) mà app ngân hàng tự điền khi quét;
 *   2. chuỗi `addInfo` của ảnh img.vietqr.io;
 *   3. chuỗi màn hình hiển thị + nút "Sao chép nội dung chuyển khoản".
 *
 * Trước đây màn hình tự "dựng lại" một memo dài còn mã QR chỉ nhúng mỗi mã đối
 * soát, nên khách quét mã thì thấy một nội dung, nhân viên đọc hoặc bấm sao chép
 * cho khách lại một nội dung khác — khi đối chiếu trên màn hình Đối soát, hai bên
 * không khớp nhau. Vì vậy không được phép có hai hàm sinh memo: mọi đường đều
 * đi qua `resolveTransferContent()` rồi dùng đúng chuỗi đó cho cả mã lẫn chữ.
 */
import {
  EMVCO_MEMO_BYTE_LIMIT,
  TRANSFER_CONTENT_LIMIT,
} from "@/lib/vietqr/emvco";

const UTF8 = new TextEncoder();

/** Độ dài UTF-8 — đúng thước mà thẻ TLV của EMVCo dùng. */
export const utf8Length = (value: string) => UTF8.encode(value).length;

const BYTES_READER = new TextDecoder();
const decode = (bytes: Uint8Array) => BYTES_READER.decode(bytes);

/**
 * Một thẻ TLV: ID (2 byte) + độ dài (2 byte, chữ số) + giá trị. Trả null khi
 * chuỗi cụt hoặc độ dài không phải đúng hai chữ số — payload khi đó không phải
 * EMVCo hợp lệ, thà báo "không đọc được" còn hơn đoán mò memo.
 */
function readTlv(
  source: Uint8Array,
  start: number,
): { tag: string; value: Uint8Array; next: number } | null {
  if (start + 4 > source.length) return null;
  const header = decode(source.subarray(start, start + 4));
  const rawLength = header.slice(2, 4);
  if (!/^\d{2}$/.test(rawLength)) return null;
  const length = Number(rawLength);
  const next = start + 4 + length;
  if (next > source.length) return null;
  return {
    tag: header.slice(0, 2),
    value: source.subarray(start + 4, next),
    next,
  };
}

/** Cắt theo byte, không bao giờ chia đôi một ký tự nhiều byte (tiếng Việt). */
function takeBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let out = "";
  let used = 0;
  for (const character of value) {
    const size = UTF8.encode(character).length;
    if (used + size > maxBytes) break;
    out += character;
    used += size;
  }
  return out.trimEnd();
}

/** Nội dung tối thiểu khi không có bất kỳ dữ liệu nào (giống chốt server). */
export const FALLBACK_TRANSFER_CONTENT = "Thanh toan tien xe";

/**
 * Nén memo đúng như `ingest_bank_transaction`: bỏ mọi ký tự phân tách, đổi hoa.
 * Mã có ít nhất 5 chữ số; không được coi một phần của mã dài hơn là cùng mã.
 */
export const referenceKey = (value: string) =>
  (value || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

/** Memo có chứa mã đối soát hay không? Thiếu mã = tiền về vẫn rơi vào UNMATCHED. */
export const containsReference = (memo: string, qrReference: string) => {
  const ref = referenceKey(qrReference);
  const normalized = (memo || "")
    .replace(/\s+\(/g, "X(")
    .toUpperCase()
    .replace(/[^0-9A-Z(]/g, "");
  // Không đoán dấu ngoặc liền sau mã là tên xe hay phần tiếp của dãy số.
  if (
    /(C\(*A\(*R\(*E\(*M\(*G\(*D\(*[0-9](?:\(*[0-9]){4,17})\(/.test(normalized)
  ) {
    return false;
  }
  const references = normalized
    .replace(/[^0-9A-Z]/g, "")
    .match(/CAREMGD[0-9]{5,18}(?![0-9])/g);
  return !!ref && !!references?.includes(ref);
};

/**
 * Đọc lại nội dung chuyển khoản (tag 62 → sub-tag 08) từ một payload EMVCo có
 * sẵn. Duyệt trên BYTE, không duyệt trên ký tự: độ dài tag EMVCo tính bằng byte
 * (xem `emvFormat`), nên cắt theo ký tự sẽ lệch ngay với memo tiếng Việt có dấu.
 * Dùng khi server đã cấp `qr_payload`: mã đó là thứ khách sẽ quét, nên màn hình
 * phải hiển thị đúng memo nằm trong nó.
 */
export function transferContentFromPayload(
  payload: string | null | undefined,
): string | null {
  if (!payload || !payload.startsWith("000201")) return null;
  const source = UTF8.encode(payload);

  for (let i = 0; ;) {
    const entry = readTlv(source, i);
    if (!entry) return null;
    if (entry.tag !== "62") {
      if (entry.next >= source.length) return null;
      i = entry.next;
      continue;
    }
    for (let j = 0; ;) {
      const sub = readTlv(entry.value, j);
      if (!sub) return null;
      if (sub.tag === "08") return decode(sub.value).trim() || null;
      if (sub.next >= entry.value.length) return null;
      j = sub.next;
    }
  }
}

/**
 * Nội dung chuyển khoản: mã đối soát nguyên vẹn, sau đó chỉ tên xe trong ngoặc.
 * Chỉ rút ngắn tên xe khi cần để cùng chuỗi vừa ảnh VietQR và payload EMVCo.
 */
export function composeTransferContent(input: {
  reference: string;
  payerName?: string | null;
  vehicleName?: string | null;
  internalCode?: string | null;
}): string {
  const ref = (input.reference || "").trim();
  if (!ref) return FALLBACK_TRANSFER_CONTENT;
  const head = `${ref} (`;
  const budget =
    Math.min(TRANSFER_CONTENT_LIMIT, EMVCO_MEMO_BYTE_LIMIT) -
    utf8Length(head) -
    1;
  if (budget <= 0) return ref;
  const vehicleName = takeBytes(
    (input.vehicleName || "").trim() || "xe",
    budget,
  );
  return vehicleName ? `${head}${vehicleName})` : ref;
}

export type TransferContentRequest = {
  qr_reference?: string | null;
  transfer_content?: string | null;
  qr_payload?: string | null;
  payer_name?: string | null;
};

/** Tên loại xe trong danh mục; không dùng biển số hay mã kho thay thế. */
export type TransferContentFallback = {
  reference?: string | null;
  payerName?: string | null;
  vehicleName?: string | null;
  internalCode?: string | null;
};

/**
 * Chốt cùng một memo ngắn cho màn hình, Copy và QR. Ưu tiên tên xe đã chụp
 * trong memo ngắn của server; memo cũ được dựng lại từ tên xe của màn hình.
 * Không suy tên xe từ tên khách, biển số hoặc câu mô tả cũ.
 */
export function resolveTransferContent(
  request: TransferContentRequest | null | undefined,
  fallback: TransferContentFallback = {},
): string {
  const reference = (request?.qr_reference || fallback.reference || "").trim();
  const fromPayload = transferContentFromPayload(request?.qr_payload);
  const fromServer = (request?.transfer_content || "").trim();

  if (!reference) return fromPayload || fromServer || FALLBACK_TRANSFER_CONTENT;

  const head = `${reference} (`;
  const compactName = (content: string) =>
    content.startsWith(head) && content.endsWith(")")
      ? content.slice(head.length, -1).trim()
      : "";
  return composeTransferContent({
    reference,
    vehicleName:
      compactName(fromServer) ||
      compactName(fromPayload || "") ||
      fallback.vehicleName,
  });
}

/**
 * Memo DUY NHẤT an toàn cho mọi kênh phát hành mã của một giao dịch: ảnh
 * VietQR quick link (trần 130 KÝ TỰ), payload EMVCo vẽ tại máy (trần 95 BYTE)
 * lẫn chữ hiển thị trên màn hình và chuỗi bấm Copy.
 *
 * Mọi đường đều dùng bộ dựng phía trên, kể cả yêu cầu cũ có memo dài hoặc QR
 * nhúng nội dung theo mẫu cũ. QR cũ chỉ được tái dùng khi nội dung trùng chuỗi này.
 */
export function selectQrTransferContent(
  request: TransferContentRequest | null | undefined,
  fallback: TransferContentFallback = {},
): string {
  return resolveTransferContent(request, fallback);
}

/**
 * Chuỗi của một lần bấm sao chép: CẢ số tiền lẫn nội dung, ghép bằng đúng
 * những gì màn hình và tấm ảnh đã hiển thị. Nhân viên gửi cho khách một câu là
 * đủ, không phải chép riêng từng cái. Mã đối soát vẫn nằm nguyên vẹn trong
 * câu, nên nếu khách dán cả câu vào ô nội dung thì `ingest_bank_transaction`
 * vẫn bắt được mỗi một mã CAREMGD… trong memo.
 */
export function composeTransferCopyLine(
  amountLabel: string,
  content: string,
): string {
  const amount = (amountLabel || "").trim();
  const memo = (content || "").trim();
  if (!amount) return memo;
  if (!memo) return amount;
  return `${amount} - ${memo}`;
}
