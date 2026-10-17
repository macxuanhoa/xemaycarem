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
    getBankWebhookState: vi.fn(async () => ({ provider: "", webhook_enabled: false, auto_match_enabled: true, account_configured: false })),
    listBankTransactions: vi.fn(async () => ({ items: [], total: 0, pending_count: 0 })),
    checkBankWebhookHealth: vi.fn(async () => "NOT_CONFIGURED"),
  },
}));

import {
  deriveConnectionStatus,
  buildChecklist,
  buildAdvancedSavePayload,
  PaymentAutomationCard,
  type CheckItem,
} from "@/features/settings/PaymentAutomationCard";

describe("deriveConnectionStatus — trung thực, không báo thành công giả", () => {
  it("chưa chọn nhà cung cấp → Chưa thiết lập", () => {
    const r = deriveConnectionStatus({ provider: "", accountConfigured: true, webhookEnabled: true, health: "CONFIGURED", anyTxnReceived: true });
    expect(r.label).toBe("Chưa thiết lập");
    expect(r.tone).toBe("neutral");
  });
  it("endpoint CONFIGURED nhưng chưa có giao dịch thật → KHÔNG được nói đã kiểm thử", () => {
    const r = deriveConnectionStatus({ provider: "SEPAY", accountConfigured: true, webhookEnabled: true, health: "CONFIGURED", anyTxnReceived: false });
    expect(r.label).toBe("Đã cấu hình, chưa kiểm thử");
    expect(r.tone).toBe("info");
    expect(r.label).not.toMatch(/thành công|đã kiểm thử nhận/i);
  });
  it("CONFIGURED + đã nhận giao dịch thật → Đã kiểm thử nhận webhook", () => {
    const r = deriveConnectionStatus({ provider: "SEPAY", accountConfigured: true, webhookEnabled: true, health: "CONFIGURED", anyTxnReceived: true });
    expect(r.label).toBe("Đã kiểm thử nhận webhook");
    expect(r.tone).toBe("success");
  });
  it("webhook tắt → Đã tạm dừng", () => {
    const r = deriveConnectionStatus({ provider: "SEPAY", accountConfigured: true, webhookEnabled: false, health: "CONFIGURED", anyTxnReceived: true });
    expect(r.label).toBe("Đã tạm dừng");
    expect(r.tone).toBe("warning");
  });
  it("endpoint không gọi được → Đang gặp lỗi", () => {
    const r = deriveConnectionStatus({ provider: "SEPAY", accountConfigured: true, webhookEnabled: true, health: "UNREACHABLE", anyTxnReceived: null });
    expect(r.tone).toBe("danger");
  });
  it("endpoint sống nhưng thiếu secret → Đang gặp lỗi", () => {
    const r = deriveConnectionStatus({ provider: "SEPAY", accountConfigured: true, webhookEnabled: true, health: "NOT_CONFIGURED", anyTxnReceived: null });
    expect(r.tone).toBe("danger");
  });
});

describe("buildChecklist — 5 tầng tách bạch, không gộp trạng thái", () => {
  const base = { provider: "SEPAY", accountConfigured: true, webhookEnabled: true };
  it("chưa kiểm gì (health null) → các tầng unknown", () => {
    const c = buildChecklist({ ...base, health: null, anyTxnReceived: null }, { matched: 0, recorded: 0 });
    expect(c.find((x: CheckItem) => x.label === "Điểm cuối hoạt động")!.state).toBe("unknown");
    expect(c.find((x: CheckItem) => x.label === "Đã nhận giao dịch thật")!.state).toBe("unknown");
  });
  it("CONFIGURED + có tiền về + đã ghi nhận → done cả 5 tầng", () => {
    const c = buildChecklist({ ...base, health: "CONFIGURED", anyTxnReceived: true }, { matched: 2, recorded: 1 });
    expect(c.every((x: CheckItem) => x.state === "done")).toBe(true);
  });
  it("CONFIGURED nhưng chưa có giao dịch → nhận-thật = pending, ghi-nhận = unknown", () => {
    const c = buildChecklist({ ...base, health: "CONFIGURED", anyTxnReceived: false }, { matched: 0, recorded: 0 });
    expect(c.find((x: CheckItem) => x.label === "Đã nhận giao dịch thật")!.state).toBe("pending");
    // Chưa nhận đồng nào thì chưa thể khẳng định chuyện ghi nhận → unknown, không phải pending giả.
    expect(c.find((x: CheckItem) => x.label === "Đã ghi nhận khoản thu")!.state).toBe("unknown");
  });
  it("UNREACHABLE → điểm cuối fail", () => {
    const c = buildChecklist({ ...base, health: "UNREACHABLE", anyTxnReceived: null }, { matched: 0, recorded: 0 });
    expect(c.find((x: CheckItem) => x.label === "Điểm cuối hoạt động")!.state).toBe("fail");
  });
});

describe("buildAdvancedSavePayload — chỉ 3 cờ kết nối thanh toán", () => {
  it("không chứa cờ cảm ơn hay tin nhắn", () => {
    const p = buildAdvancedSavePayload({ provider: "SEPAY", webhookEnabled: true, autoMatch: false });
    expect(p).toEqual({ bank_provider: "SEPAY", bank_webhook_enabled: true, bank_auto_match_enabled: false });
    expect(p).not.toHaveProperty("thankyou_manual_enabled");
  });
});

function seedClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["bank-webhook-state"], { provider: "SEPAY", webhook_enabled: true, auto_match_enabled: true, account_configured: true });
  client.setQueryData(["bank-recon-summary"], { byStatus: { MATCHED_PENDING: 2, MANUAL_REVIEW: 1, UNMATCHED: 3, RECORDED: 5 }, totalAll: 11 });
  return client;
}

describe("PaymentAutomationCard render (SSR)", () => {
  it("chỉ còn khối kết nối + nâng cao — không trùng tài khoản nhận/đối soát, không báo thành công giả", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={seedClient()}>
        <MemoryRouter>
          <PaymentAutomationCard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Kết nối ngân hàng");
    expect(html).toContain("Cài đặt nâng cao");
    // Tài khoản nhận tiền và hàng đợi đối soát có tab/trang riêng — không lặp lại ở đây.
    expect(html).not.toContain("Đối soát thanh toán");
    expect(html).not.toContain("Mở trang đối soát");
    expect(html).not.toContain("Thay đổi tài khoản");
    expect(html).not.toContain("1234567890"); // không lộ số tài khoản
    // health null lúc SSR → chưa kiểm → không được khẳng định đã nhận webhook.
    expect(html).not.toContain("Đã kiểm thử nhận webhook");
  });

  it("không còn bất kỳ UI lời cảm ơn / tin nhắn chăm sóc nào", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={seedClient()}>
        <MemoryRouter>
          <PaymentAutomationCard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).not.toMatch(/cảm ơn|tin nhắn|zalo|messenger|mẫu tin/iu);
  });
});
