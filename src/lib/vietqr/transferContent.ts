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
  return { tag: header.slice(0, 2), value: source.subarray(start + 4, next), next };
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
 * Server khớp giao dịch bằng cách tìm "CAREMGD<5 số>" ở BẤT KỲ vị trí trong memo.
 */
export const referenceKey = (value: string) =>
  (value || "").toUpperCase().replace(/[^0-9A-Z]/g, "");

/** Memo có chứa mã đối soát hay không? Thiếu mã = tiền về vẫn rơi vào UNMATCHED. */
export const containsReference = (memo: string, qrReference: string) => {
  const ref = referenceKey(qrReference);
  return !!ref && referenceKey(memo).includes(ref);
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

  for (let i = 0; ; ) {
    const entry = readTlv(source, i);
    if (!entry) return null;
    if (entry.tag !== "62") {
      if (entry.next >= source.length) return null;
      i = entry.next;
      continue;
    }
    for (let j = 0; ; ) {
      const sub = readTlv(entry.value, j);
      if (!sub) return null;
      if (sub.tag === "08") return decode(sub.value).trim() || null;
      if (sub.next >= entry.value.length) return null;
      j = sub.next;
    }
  }
}

/**
 * Dựng memo dự phòng cho yêu cầu chưa có `transfer_content` (prod chưa áp
 * migration memo phía server). Theo đúng quy tắc server đã chốt: MÃ ĐỐI SOÁT
 * đứng ĐẦU để sống sót qua lần cắt memo ~70 ký tự của ngân hàng/SePay, theo sau
 * là "(khách) thanh toán tiền xe (tên xe) - (mã xe)".
 *
 * Trần áp dụng cho memo do client dựng là min(130 ký tự Napas, 95 byte EMVCo)
 * vì cùng một chuỗi phải nhúng vừa vào payload vừa vào ảnh VietQR. Khi vượt trần,
 * rút tên khách trước rồi đến tên xe — mã đối soát đầu chuỗi không bao giờ bị cắt.
 */
export function composeTransferContent(input: {
  reference: string;
  payerName?: string | null;
  vehicleName?: string | null;
  internalCode?: string | null;
}): string {
  const ref = (input.reference || "").trim();
  const code = (input.internalCode || "").trim();
  const codePart = code ? ` - ${code}` : "";
  const head = ref ? `${ref} ` : "";
  const budget = Math.min(TRANSFER_CONTENT_LIMIT, EMVCO_MEMO_BYTE_LIMIT) - utf8Length(head);
  const assemble = (payer: string, vehicleName: string) =>
    `${head}${payer} thanh toán tiền xe ${vehicleName}${codePart}`
      .replace(/ {2,}/g, " ")
      .trim();
  const fits = (memo: string) =>
    memo.length <= TRANSFER_CONTENT_LIMIT && utf8Length(memo) <= EMVCO_MEMO_BYTE_LIMIT;

  if (budget <= 0) return ref || FALLBACK_TRANSFER_CONTENT;

  let payer = (input.payerName || "").trim() || "Khách mua xe";
  let vehicleName = ((input.vehicleName || "").trim() || "xe").slice(0, 40);
  let memo = assemble(payer, vehicleName);
  if (fits(memo)) return memo;

  payer = takeBytes(payer, Math.max(0, budget - utf8Length(assemble("", vehicleName))));
  memo = assemble(payer, vehicleName);
  if (fits(memo)) return memo;

  vehicleName = takeBytes(
    vehicleName,
    Math.max(0, budget - utf8Length(assemble(payer, ""))),
  );
  memo = assemble(payer, vehicleName);
  return fits(memo) ? memo : ref || FALLBACK_TRANSFER_CONTENT;
}

export type TransferContentRequest = {
  qr_reference?: string | null;
  transfer_content?: string | null;
  qr_payload?: string | null;
  payer_name?: string | null;
};

/** Dữ liệu màn hình bán hàng dùng khi server chưa cấp memo. */
export type TransferContentFallback = {
  reference?: string | null;
  payerName?: string | null;
  vehicleName?: string | null;
  internalCode?: string | null;
};

/**
 * Chốt nội dung chuyển khoản DUY NHẤT cho một yêu cầu VietQR, theo thứ tự ưu tiên:
 *   1. memo nằm trong `qr_payload` do server cấp — vì đó chính là mã khách quét;
 *   2. `transfer_content` do server sinh — sẽ được nhúng nguyên văn vào mã mới;
 *   3. memo dự phòng dựng theo quy tắc server (mã đứng đầu, capped 130);
 *   4. mã đối soát; 5. câu chữ tiếng Việt không dấu tối thiểu.
 *
 * Kết quả luôn chứa mã đối soát: thiếu mã thì webhook không khớp được, tiền về
 * đúng nhưng giao dịch nằm lại UNMATCHED — lỗi nghiêm trọng hơn một memo cụt.
 */
export function resolveTransferContent(
  request: TransferContentRequest | null | undefined,
  fallback: TransferContentFallback = {},
): string {
  const reference = (request?.qr_reference || fallback.reference || "").trim();
  const fromPayload = transferContentFromPayload(request?.qr_payload);
  const fromServer = (request?.transfer_content || "").trim();

  let content =
    fromPayload ||
    fromServer ||
    (reference
      ? composeTransferContent({
          reference,
          payerName: request?.payer_name || fallback.payerName,
          vehicleName: fallback.vehicleName,
          internalCode: fallback.internalCode,
        })
      : "") ||
    reference ||
    FALLBACK_TRANSFER_CONTENT;

  // Không bao giờ phát hành một memo thiếu mã đối soát.
  if (reference && !containsReference(content, reference)) {
    content = composeTransferContent({
      reference,
      payerName: content,
    });
  }
  return content;
}

/**
 * Memo DUY NHẤT an toàn cho mọi kênh phát hành mã của một giao dịch: ảnh
 * VietQR quick link (trần 130 KÝ TỰ), payload EMVCo vẽ tại máy (trần 95 BYTE)
 * lẫn chữ hiển thị trên màn hình và chuỗi bấm Copy.
 *
 * Server được phép ghi memo dài 130 ký tự, mà tiếng Việt ~= 2 byte/chữ nên rất
 * nhiều memo hợp lệ của server vượt trần byte của thẻ EMVCo. Nếu mỗi kênh tự
 * cắt theo trần riêng thì ảnh QR và mã nội bộ của cùng một đơn hàng sẽ mang hai
 * nội dung khác nhau — khách quét ảnh, nhân viên copy chuỗi cạnh màn hình, tiền
 * về khớp một đằng, đối soát một nẻo. Vì vậy chọn một chuỗi duy nhất vừa cả hai
 * trần ngay từ đầu, luôn giữ mã đối soát đứng đầu để webhook trích được.
 */
export function selectQrTransferContent(
  request: TransferContentRequest | null | undefined,
  fallback: TransferContentFallback = {},
): string {
  const content = resolveTransferContent(request, fallback);
  const reference = (request?.qr_reference || fallback.reference || "").trim();
  if (!reference) return content;
  if (utf8Length(content) <= EMVCO_MEMO_BYTE_LIMIT && content.length <= TRANSFER_CONTENT_LIMIT) {
    return content;
  }
  return composeTransferContent({
    reference,
    payerName: request?.payer_name || fallback.payerName,
    vehicleName: fallback.vehicleName,
    internalCode: fallback.internalCode,
  });
}
