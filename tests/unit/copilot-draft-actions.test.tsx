import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { detectDraftAction } from "@/lib/shorthand/draftActions";
import { DraftActionCard } from "@/features/copilot/DraftActionCard";
import type { DraftAction } from "@/lib/shorthand/draftActions";

let testRole = "OWNER";

vi.mock("@/features/auth/AuthProvider", () => ({
  useAuth: () => ({
    profile: {
      id: "u1",
      full_name: "Admin User",
      role: testRole,
      active: true,
      can_view_financials: true,
    },
    signOut: vi.fn(),
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    call: vi.fn(async () => ({
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          brand: "Honda",
          model: "SH 150",
          license_plate: "59-B1 123.45",
          frame_number: "RLH1234567890",
        },
      ],
      total: 1,
    })),
    copilot: vi.fn(),
  },
}));

describe("copilot draft-action detection is deterministic and strict", () => {
  it("reads an expense command with shorthand money and a real plate", () => {
    const action = detectDraftAction("chi 500k thay nhớt cho xe 59-B1 123.45");
    expect(action).toMatchObject({
      kind: "ADD_VEHICLE_EXPENSE",
      license_plate: "59-B1 123.45",
      amount: 500_000,
      expense_type: "REPAIR",
    });
    expect(action.kind === "ADD_VEHICLE_EXPENSE" && action.description).toMatch(/nhớt/i);
  });

  it("keeps phone numbers out of the amount pool", () => {
    const action = detectDraftAction("chi 500k thay nen xe 59-B1 123.45 goi 0905123456");
    expect(action).toMatchObject({ kind: "ADD_VEHICLE_EXPENSE", amount: 500_000 });
  });

  it("reads transport and paperwork spending on a plated bike", () => {
    expect(
      detectDraftAction("chi 2tr5 chuyen xe tu bien hoa ve 59-B1 123.45")?.kind,
    ).toBe("ADD_VEHICLE_EXPENSE");
    const paperwork = detectDraftAction("nop 300k phi tru ba dang ky 59-B1 123.45");
    expect(paperwork).toMatchObject({ kind: "ADD_VEHICLE_EXPENSE", amount: 300_000 });
  });

  it("extracts a sale draft with customer, price and plate", () => {
    const action = detectDraftAction("bán cho anh Bình 30tr xe 59-B1 123.45");
    expect(action).toMatchObject({
      kind: "PREPARE_SALE",
      license_plate: "59-B1 123.45",
      customer_name: "Bình",
      sale_price: 30_000_000,
    });
  });

  it("hands shorthand purchase lines to the existing intake parser", () => {
    const action = detectDraftAction("thu mua con wave dai loan 18tr5");
    expect(action).toMatchObject({ kind: "CREATE_ACQUISITION" });
    expect(action?.kind === "CREATE_ACQUISITION" && action.seed_text).toContain("wave");
  });

  it("rejects questions and business vocabulary", () => {
    for (const question of [
      "Doanh thu tháng này là bao nhiêu?",
      "Thống kê xe tồn kho",
      "Tình hình cửa hàng hôm nay?",
      "Xe nào tồn lâu nhất?",
      "Thu tiền hôm nay ra sao?",
      "doanh thu tháng 9",
    ]) {
      expect(detectDraftAction(question), question).toBeNull();
    }
  });

  it("never misreads spare-part spending as buying a bike", () => {
    expect(detectDraftAction("chi 500k mua lop xe")).toBeNull();
    expect(detectDraftAction("thay nhớt 500k")).toBeNull(); // expense verb but no plate to bind
    expect(detectDraftAction("bán xe 59-B1 123.45")).toBeNull(); // no customer nor price
  });
});

describe("copilot draft card only prefills the existing confirmed forms", () => {
  const expense: DraftAction = {
    kind: "ADD_VEHICLE_EXPENSE",
    license_plate: "59-B1 123.45",
    amount: 500_000,
    description: "thay nhớt",
    expense_type: "REPAIR",
  };

  const renderCard = (action: DraftAction) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <DraftActionCard action={action} />
        </QueryClientProvider>
      </MemoryRouter>,
    );

  it("shows the reviewed draft fields and the review-first notice", () => {
    const html = renderCard(expense);
    expect(html).toContain("Cà Rem đề xuất thao tác");
    expect(html).toContain("59-B1 123.45");
    expect(html).toContain("500.000");
    expect(html).toContain("Sửa chữa");
    expect(html).toContain("Kiểm tra");
    // The card never writes: every save stays behind the modal's own confirm.
    expect(html).toContain("chỉ gợi ý");
  });

  it("renders nothing for a staff member on the expense path", () => {
    testRole = "STAFF";
    try {
      expect(renderCard(expense)).toBe("");
    } finally {
      testRole = "OWNER";
    }
  });
});
