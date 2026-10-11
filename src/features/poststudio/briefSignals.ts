// Người bán mô tả tự do "viết bài bán xe giá 25tr, alo 09xx...". Trợ lý AI bị
// cấm đưa giá / số điện thoại lạ / link vào bài công khai (scanPublicText phía
// máy chủ), nên những gì người dùng gõ ở ô mô tả rất dễ khiến một lượt tạo bài
// thất bại khó hiểu.
//
// File này SOI TRƯỚC ở phía giao diện để nhắc sớm, KHÔNG phải hàng rào an ninh:
// máy chủ vẫn kiểm tra lại toàn bộ, và xoá/né ở đây không có nghĩa là dữ liệu
// đã "an toàn để đăng". Vì vậy chỉ gợi ý, không chặn nút tạo bài, không sửa chữ
// người dùng đã gõ.

export type BriefRisk = "MONEY" | "PHONE" | "URL" | "ID" | "FINANCIAL_TERM";

const RISK_LABELS: Record<BriefRisk, string> = {
  MONEY: "giá hoặc con số tiền",
  PHONE: "số điện thoại",
  URL: "đường link",
  ID: "số giấy tờ (CCCD/CMND)",
  FINANCIAL_TERM: "từ nhạy cảm về tiền (trả góp, công nợ, giá thu, giá vốn…)",
};

/** Hotline công khai duy nhất của Cà Rem — cùng giá trị với máy chủ (contracts.ts). */
const PUBLIC_HOTLINE_DIGITS = "0914929292";

/** Trả về nhãn tiếng Việt của các loại thông tin không nên xuất hiện công khai. */
export function describeBriefRisks(brief: string): string[] {
  const text = brief ?? "";
  const risks: BriefRisk[] = [];
  if (/https?:\/\/\S/i.test(text)) risks.push("URL");
  if (/\d{12}/.test(text)) risks.push("ID");
  const phones = text.match(/(0|\+84)\d[\d\s.-]{7,12}\d/g) ?? [];
  if (phones.some((phone) => phone.replace(/\D/g, "").replace(/^\+?84/, "0") !== PUBLIC_HOTLINE_DIGITS)) {
    risks.push("PHONE");
  }
  if (
    /\d[\d.,\s]{0,12}\s?(tri[eệ]u|tr|c[kk]?|k)(?![\p{L}\p{M}])/iu.test(text) ||
    /\d[\d.,\s]{0,12}\s?(đồng|₫)/i.test(text) ||
    /\d{1,3}([.,]\d{3}){2,}/.test(text)
  ) {
    risks.push("MONEY");
  }
  // Biển số xe dạng "43D1-111.22" hợp lệ và được phép nhắc công khai: nếu phần
  // bị nghi là "tiền" nằm gọn trong một biển số thì không dọa người dùng.
  if (risks.includes("MONEY") && /^\s*\d{2,3}[A-Z]{1,2}\d{1,2}-\d{1,2}\.\d{1,2}\s*$/i.test(text)) {
    risks.splice(risks.indexOf("MONEY"), 1);
  }
  // Từ vựng tài chính: máy chủ chặn cả lượt tạo bài khi thấy những chữ này.
  if (/(giá thu|giá vốn|l[iấ]u nhuận|công n[ợo]|trả góp|còn thi[eế]u)/i.test(text)) {
    risks.push("FINANCIAL_TERM");
  }
  return [...new Set(risks)].map((risk) => RISK_LABELS[risk]);
}

/** Một câu nhắc gọn, đủ để đặt cạnh ô mô tả. rỗng khi không có gì đáng lo. */
export function briefRiskHint(brief: string): string {
  const risks = describeBriefRisks(brief);
  if (!risks.length) return "";
  return `Mô tả đang có ${risks.join(", ")} — trợ lý sẽ cố ý bỏ những thứ đó khỏi bài vì Cà Rem không đăng công khai giá, số điện thoại riêng, link hay chuyện trả góp/công nợ. Hãy sửa tay nếu bài thiếu ý bạn muốn.`;
}
