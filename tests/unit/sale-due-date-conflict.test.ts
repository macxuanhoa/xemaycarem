import { afterEach, expect, it, vi } from "vitest";
import { friendlyError } from "@/lib/errors";

afterEach(() => vi.unstubAllGlobals());

it("shows a clear unsaved conflict for a Supabase plain-object error", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(friendlyError({ code: "40001", message: "SALE_DUE_DATE_CONFLICT" }))
    .toBe("Giao dịch đã được cập nhật. Hạn trả của bạn chưa được lưu; hãy đóng, tải lại danh sách công nợ và đối chiếu trước khi sửa tiếp.");
});

it("shows the expense conflict without suggesting an automatic money retry", () => {
  vi.stubGlobal("navigator", { onLine: true });
  expect(friendlyError({ code: "40001", message: "EXPENSE_EDIT_CONFLICT" }))
    .toBe("Chi phí đã được người khác cập nhật. Thay đổi của bạn chưa được lưu; hãy đóng, tải lại danh sách và đối chiếu trước khi sửa tiếp.");
});
