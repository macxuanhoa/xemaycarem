// Tests cho phần "soi trước" mô tả tự do ở bước 2 của Đăng bài từ kho xe.
// Đây là gợi ý giao diện, KHÔNG phải hàng rào an ninh (máy chủ vẫn quét lại),
// nên test chỉ bắt buộc hai điều: đừng dọa sai chuyện và đừng bịa thêm cảnh báo.

import { describe, expect, it } from "vitest";

import { briefSuggestions } from "@/features/poststudio/briefSuggestions";
import { briefRiskHint, describeBriefRisks } from "@/features/poststudio/briefSignals";

describe("briefSignals nhắc sớm đúng thứ Cà Rem không đăng công khai", () => {
  it("im lặng với mô tả sạch, kể cả biển số và năm xe trông giống con số", () => {
    expect(describeBriefRisks("Viết bài cảm ơn anh khách đã mua Wave Alpha, biển 43D1-111.22")).toEqual([]);
    expect(describeBriefRisks("Xe Vision 2023 đen, ghé quán xem thực tế nhé bà con")).toEqual([]);
    expect(briefRiskHint("Xe Vision 2023 đen")).toBe("");
  });
  it("hotline công khai không bị coi là số điện thoại riêng", () => {
    expect(describeBriefRisks("Kêu khách gọi 0914.92.92.92 hoặc +84 914 929 292")).toEqual([]);
  });
  it("bắt số điện thoại lạ, link, CCCD 12 số và con số tiền", () => {
    expect(describeBriefRisks("Alo 0988.123.456 nha")).toContain("số điện thoại");
    expect(describeBriefRisks("Dán link https://shopee.vn/xe-nhe")).toContain("đường link");
    expect(describeBriefRisks("Khách 079099988877 làm hợp đồng")).toContain("số giấy tờ (CCCD/CMND)");
    for (const money of ["Nhấn giá 25tr5", "Xe 35 triệu thôi", "Giá 300 đồng", "Chỉ 18.500.000đ"]) {
      expect(describeBriefRisks(money), money).toContain("giá hoặc con số tiền");
    }
  });
  it("bắt từ nhạy cảm về tiền dù không có con số nào", () => {
    for (const phrase of ["Khách hỏi trả góp được không", "Nhắc công nợ cũ", "Nêu giá thu cao"]) {
      expect(describeBriefRisks(phrase), phrase).toContain("từ nhạy cảm về tiền (trả góp, công nợ, giá thu, giá vốn…)");
    }
  });
  it("một mô tả phạm nhiều thứ thì liệt kê một lượt, không trùng lặp", () => {
    const risks = describeBriefRisks("Giá 25tr5, alo 0988123456, xem tại https://facebook.com/xe");
    expect(risks).toHaveLength(3);
    expect(new Set(risks).size).toBe(3);
  });
  it("câu hint nói rõ trợ lý sẽ bỏ những thứ đó và gợi ý sửa tay", () => {
    const hint = briefRiskHint("Nhấn giá 25tr5 cho khách dễ hình dung");
    expect(hint).toContain("giá hoặc con số tiền");
    expect(hint).toContain("trợ lý sẽ cố ý bỏ");
    expect(hint.length).toBeLessThan(320);
  });
  it("không vỡ khi người dùng chưa gõ gì", () => {
    expect(describeBriefRisks("")).toEqual([]);
    expect(describeBriefRisks(undefined as unknown as string)).toEqual([]);
    expect(briefRiskHint("")).toBe("");
  });
});

// Lời mồi là thứ người dùng bấm nguyên văn, nên nếu chính nó phạm quy tắc thì
// một cú click đủ làm cả lượt tạo bài bị máy chủ chặn. Test này giữ cho kho gợi ý
// không bao giờ chứa những chữ mà Cà Rem cấm đăng công khai.
describe("gợi ý mở lời luôn qua nổi bộ quét", () => {
  it("không gợi ý nào chứa giá, số điện thoại, link hay từ tài chính nhạy cảm", () => {
    expect(briefSuggestions.length).toBeGreaterThanOrEqual(5);
    for (const suggestion of briefSuggestions) {
      expect(describeBriefRisks(suggestion.text), `${suggestion.label}: ${suggestion.text}`).toEqual([]);
      expect(suggestion.label.length).toBeGreaterThan(2);
    }
  });
});
