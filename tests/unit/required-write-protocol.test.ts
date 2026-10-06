import { afterEach, expect, it, vi } from "vitest";
import { friendlyError } from "@/lib/errors";

afterEach(() => vi.unstubAllGlobals());

it("explains the required client upgrade without reporting success or blind retry", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(friendlyError({ code: "22023", message: "CLIENT_UPGRADE_REQUIRED" }))
    .toBe("Phiên bản đang mở chưa hỗ trợ lưu giao dịch an toàn. Thao tác chưa được ghi nhận; hãy cập nhật ứng dụng, tải lại dữ liệu và đối soát lịch sử trước khi gửi lại.");
});
