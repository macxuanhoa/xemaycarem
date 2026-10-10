// Bộ fallback template chạy trong trình duyệt phải AN TOÀN Y HỆU AI:
// mọi caption sinh ra được dẫn qua đúng máy quét scanPublicText của Edge
// Function post-ai — không giá, không số điện thoại lạ, không URL, không
// thuật ngữ tài chính — để khi AI hết hạn mức, quán vẫn đăng bài không rủi ro.
import { describe, expect, it } from "vitest";
import {
  buildTemplateCaptions,
  PUBLIC_HOTLINE,
} from "@/features/poststudio/captionTemplates";
import type { StudioContext } from "@/lib/postStudioApi";
import {
  postChannels,
  postKinds,
  scanPublicText,
  tones,
} from "../../supabase/functions/post-ai/contracts";

const vision: StudioContext = {
  id: "3f2a1b6c-0000-4000-8000-000000000001",
  internal_code: "CR-118",
  license_plate: "92D1-118.77",
  frame_number: "RLHJF3212PF012345",
  vehicle_type: "Vision",
  year: 2023,
  color: "Đen",
  status: "IN_STOCK",
  vehicle_title: "Honda Vision 2023",
  vehicle_subtitle: "Xe tay ga, nước còn thơm",
  images: [],
  store: { store_name: "Cà Rem", phone: PUBLIC_HOTLINE },
};

const airblade: StudioContext = {
  ...vision,
  id: "3f2a1b6c-0000-4000-8000-000000000002",
  license_plate: "92B1-234.56",
  vehicle_type: "Air Blade",
  year: 2021,
  color: "Trắng",
  vehicle_title: "Honda Air Blade 2021",
};

describe("buildTemplateCaptions — hình thái", () => {
  it("luôn trả đúng 3 caption khác nhau, không rỗng cho mọi tổ hợp", () => {
    for (const kind of postKinds) {
      for (const channel of postChannels) {
        for (const tone of tones) {
          for (const vehicle of [vision, airblade, null]) {
            const captions = buildTemplateCaptions(vehicle, kind, channel, tone);
            expect(captions, `${kind}/${channel}/${tone}`).toHaveLength(3);
            for (const caption of captions) {
              expect(caption.trim().length).toBeGreaterThan(20);
            }
            expect(new Set(captions).size, captions.join(" | ")).toBe(3);
          }
        }
      }
    }
  });

  it("variation xoay vòng: bấm 'Tạo lại' cho bộ caption khác", () => {
    const first = buildTemplateCaptions(vision, "NEW_STOCK", "FACEBOOK", "THAN_THIEN", 0);
    const second = buildTemplateCaptions(vision, "NEW_STOCK", "FACEBOOK", "THAN_THIEN", 1);
    expect(second).not.toEqual(first);
    // Xoay đủ một vòng thì lặp lại chu kỳ (3 opener × 3 closer đều xoay).
    const wrap = buildTemplateCaptions(vision, "BUYBACK", "ZALO", "VUI_VANG", 3);
    const base = buildTemplateCaptions(vision, "BUYBACK", "ZALO", "VUI_VANG", 0);
    expect(wrap).toEqual(base);
  });

  it("mỗi caption đều có kết bài điều hướng về quán/hotline công khai", () => {
    for (const kind of postKinds) {
      for (const channel of postChannels) {
        for (const caption of buildTemplateCaptions(vision, kind, channel, "NGAN_GON")) {
          const lower = caption.toLowerCase();
          const hasAnchor =
            lower.includes("cà rem") ||
            lower.includes("ghé quán") ||
            lower.includes("inbox") ||
            lower.includes("zalo") ||
            caption.includes(PUBLIC_HOTLINE);
          expect(hasAnchor, caption).toBe(true);
        }
      }
    }
  });

  it("BUYBACK không bịa chi tiết xe dù không chọn xe", () => {
    const captions = buildTemplateCaptions(null, "BUYBACK", "FACEBOOK", "THAN_THIEN");
    for (const caption of captions) {
      expect(caption).not.toContain("92D1");
      expect(caption).not.toContain("Vision");
      expect(caption).not.toContain("2023");
    }
  });
});

describe("buildTemplateCaptions — an toàn như cổng AI", () => {
  it("mọi caption qua scanPublicText với 0 vi phạm", () => {
    for (const kind of postKinds) {
      for (const channel of postChannels) {
        for (const tone of tones) {
          for (const vehicle of [vision, airblade, null]) {
            for (const caption of buildTemplateCaptions(vehicle, kind, channel, tone)) {
              expect(scanPublicText(caption), `${kind}/${channel}/${tone}: ${caption}`).toEqual([]);
            }
          }
        }
      }
    }
  });

  it("biển số và đời xe thật không bị nhận nhầm là số tiền/số điện thoại", () => {
    // Chính các chuỗi dễ gây nhầm: "118.77", "92B1-234.56", "đời 2023".
    for (const vehicle of [vision, airblade]) {
      for (const caption of buildTemplateCaptions(vehicle, "NEW_STOCK", "FB_GROUP", "CHUYEN_NGHIA")) {
        expect(scanPublicText(caption)).toEqual([]);
      }
    }
  });

  it("chứa hotline công khai duy nhất, không lộ số thu mua nội bộ", () => {
    const all = postChannels.flatMap((channel) =>
      buildTemplateCaptions(vision, "MULTI", channel, "THAN_THIEN"),
    );
    const withPhone = all.filter((caption) => /09\d{9}|0914\.92\.92\.92/.test(caption));
    for (const caption of withPhone) {
      expect(caption).toContain(PUBLIC_HOTLINE);
    }
    expect(withPhone.length).toBeGreaterThan(0);
  });
});
