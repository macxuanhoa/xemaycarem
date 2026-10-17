import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/features/auth/AuthProvider", () => ({
  useAuth: () => ({
    profile: { id: "u1", full_name: "Chủ quán", role: "OWNER", active: true, can_view_financials: true },
    signOut: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    call: vi.fn(async () => ({})),
    listBankTransactions: vi.fn(async () => ({ items: [], total: 0, pending_count: 0 })),
    confirmBankTransaction: vi.fn(async () => ({})),
    linkBankTransaction: vi.fn(async () => ({})),
    ignoreBankTransaction: vi.fn(async () => ({})),
  },
}));

import BankReconciliationPage from "@/features/reconciliation/BankReconciliationPage";

describe("BankReconciliationPage — bộ lọc gộp còn hai nhóm + Tất cả", () => {
  it("mặc định mở 'Cần bạn xử lý', không còn bảy tab trạng thái rời rạc", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BankReconciliationPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Cần bạn xử lý");
    expect(html).toContain("Lịch sử");
    expect(html).toContain("Tất cả");
    // Tab đầu (ATTENTION) phải là tab đang bật khi vừa mở trang.
    expect(html).toMatch(/aria-pressed="true"[^>]*>[\s\S]*?<span>Cần bạn xử lý<\/span>/);
    // Nhãn bảy tab cũ không được sót lại dưới dạng nhãn lọc.
    for (const label of [">Chờ xác nhận<", ">Rà soát<", ">Chờ hợp đồng<", ">Chưa khớp<", ">Đã ghi nhận<", ">Đã bỏ qua<"]) {
      expect(html).not.toContain(label);
    }
  });

  it("header và mô tả trang giữ nguyên nghiệp vụ đối soát", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BankReconciliationPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Đối soát chuyển khoản");
    expect(html).toContain("Chỉ ghi nhận tiền khi bạn chắc chắn đã thực thu");
  });
});
