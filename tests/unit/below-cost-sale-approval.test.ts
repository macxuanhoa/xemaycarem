/**
 * Bán xe dưới giá thu mua — hợp đồng client cho hàng đợi "Chờ duyệt".
 *
 * Phần quyết định thật (giá bán so với giá thu, chặn bán trùng, đối soát dữ
 * liệu cũ) nằm trong migration 20261010000300 và được tests/db kiểm tra. Ở
 * đây kiểm tra đúng ba thứ frontend dễ làm hỏng:
 *   1. tên RPC + hình dạng payload gửi lên server (request_id phải nằm trong p_data);
 *   2. cơ chế chống gửi trùng / chống lưu hai lần của hai thao tác mới;
 *   3. lỗi server được dịch ra tiếng Việt thay vì rơi vào nhãn chung chung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({ supabase: { rpc } }));

import { api } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import {
  executeOperation,
  pendingOperation,
  retainOperation,
} from "@/lib/operationRecovery";
import type { RecoverableOperation } from "@/lib/operationRecovery";
import { actionLabels } from "@/features/vehicles/vehicleSchema";
import {
  auditActionChips,
  auditActionPhrases,
} from "@/features/audit/auditLabels";

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const VEHICLE_ID = "22222222-2222-4222-8222-222222222222";

/** Server errors arrive as a plain { code, message } bag from PostgREST. */
const serverError = (code: string, message: string) => ({ code, message });

describe("below-cost sale approval — RPC contract", () => {
  beforeEach(() => {
    rpc.mockReset();
    vi.stubGlobal("navigator", { onLine: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("files the request as request_sale_below_cost with the request id inside p_data", async () => {
    rpc.mockResolvedValue({ data: APPROVAL_ID, error: null });
    const approvalId = await api.requestSaleBelowCost(
      {
        vehicle_id: VEHICLE_ID,
        customer_name: "Anh Bin",
        sale_price: 15_000_000,
        sale_date: "2026-10-09",
      },
      "33333333-3333-4333-8333-333333333333",
    );
    expect(approvalId).toBe(APPROVAL_ID);
    expect(rpc).toHaveBeenCalledWith("request_sale_below_cost", {
      p_data: {
        vehicle_id: VEHICLE_ID,
        customer_name: "Anh Bin",
        sale_price: 15_000_000,
        sale_date: "2026-10-09",
        request_id: "33333333-3333-4333-8333-333333333333",
      },
    });
  });

  it("resolves with the OWNER action and a top-level request id for the receipt", async () => {
    rpc.mockResolvedValue({
      data: { approval_id: APPROVAL_ID, action: "APPROVE", sale_id: "sale-1" },
      error: null,
    });
    const result = await api.resolveSaleApproval(
      APPROVAL_ID,
      "APPROVE",
      "Chấp nhận bán lỗ",
      "44444444-4444-4444-8444-444444444444",
    );
    // APPROVE completes the sale in the same transaction, so the client has to
    // get the new sale id back to route the OWNER to the receipt.
    expect(result.sale_id).toBe("sale-1");
    expect(rpc).toHaveBeenCalledWith("resolve_sale_approval", {
      p_approval_id: APPROVAL_ID,
      p_action: "APPROVE",
      p_note: "Chấp nhận bán lỗ",
      p_request_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("sends a null note and reason instead of undefined keys", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await api.resolveSaleApproval(
      APPROVAL_ID,
      "REJECT",
      undefined,
      "55555555-5555-4555-8555-555555555555",
    );
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: "REJECT", p_note: null });
    await api.cancelSaleApproval(APPROVAL_ID);
    expect(rpc).toHaveBeenLastCalledWith("cancel_sale_approval", {
      p_approval_id: APPROVAL_ID,
      p_reason: null,
    });
  });

  it("keeps the two new operations in the recoverable whitelist", () => {
    const operations: RecoverableOperation[] = [
      "request_sale_below_cost",
      "resolve_sale_approval",
    ];
    expect(operations).toHaveLength(2);
  });
});

describe("below-cost sale approval — double-save protection", () => {
  const records = new Map<string, string>();

  beforeEach(() => {
    records.clear();
    rpc.mockReset();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("replays the committed request instead of filing a second one", async () => {
    const requestId = retainOperation(
      "actor",
      "request_sale_below_cost",
      VEHICLE_ID,
    );
    // The first attempt committed server-side but the response was lost.
    rpc.mockImplementation((name: string) =>
      name === "get_operation_result"
        ? Promise.resolve({
            data: { confirmed: true, result: APPROVAL_ID },
            error: null,
          })
        : Promise.reject(new Error(`unexpected write ${name}`)),
    );
    const send = vi.fn(() => api.requestSaleBelowCost({ vehicle_id: VEHICLE_ID }, requestId));
    await expect(
      executeOperation("actor", "request_sale_below_cost", VEHICLE_ID, send),
    ).resolves.toBe(APPROVAL_ID);
    expect(send).not.toHaveBeenCalled();
    expect(
      pendingOperation("actor", "request_sale_below_cost", VEHICLE_ID),
    ).toBeNull();
  });

  it("re-sends the retained request id when the server never recorded the first attempt", async () => {
    const send = vi.fn((id: string) =>
      api.requestSaleBelowCost({ vehicle_id: VEHICLE_ID }, id),
    );
    rpc.mockImplementationOnce(() => Promise.reject(new Error("network")));
    await expect(
      executeOperation("actor", "request_sale_below_cost", VEHICLE_ID, send),
    ).rejects.toThrow("network");
    // Nothing was committed, so the retry re-uses the same UUID: the server
    // receipt turns a dropped response into an idempotent replay.
    rpc.mockImplementation((name: string) =>
      name === "get_operation_result"
        ? Promise.resolve({ data: { confirmed: false, result: null }, error: null })
        : Promise.resolve({ data: APPROVAL_ID, error: null }),
    );
    await expect(
      executeOperation("actor", "request_sale_below_cost", VEHICLE_ID, send),
    ).resolves.toBe(APPROVAL_ID);
    const ids = rpc.mock.calls
      .filter((args) => args[0] === "request_sale_below_cost")
      .map((args) => args[1].p_data.request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(rpc.mock.calls.map((args) => args[0])).toContain("get_operation_result");
  });

  it("replays a committed approval instead of selling the vehicle twice", async () => {
    let writes = 0;
    rpc.mockImplementation((name: string) => {
      if (name === "resolve_sale_approval") {
        // The sale row is created but the response never reaches the browser.
        writes += 1;
        return Promise.reject(new Error("network"));
      }
      if (name === "get_operation_result")
        return Promise.resolve({
          data: {
            confirmed: writes > 0,
            result:
              writes > 0
                ? { approval_id: APPROVAL_ID, action: "APPROVE", sale_id: "sale-1" }
                : null,
          },
          error: null,
        });
      return Promise.reject(new Error(`unexpected rpc ${name}`));
    });
    const run = () =>
      executeOperation("actor", "resolve_sale_approval", APPROVAL_ID, (id) =>
        api.resolveSaleApproval(APPROVAL_ID, "APPROVE", undefined, id),
      );
    await expect(run()).rejects.toThrow("network");
    await expect(run()).resolves.toMatchObject({ sale_id: "sale-1" });
    // One write only: the second click reads the receipt instead of re-selling.
    expect(writes).toBe(1);
    expect(
      pendingOperation("actor", "resolve_sale_approval", APPROVAL_ID),
    ).toBeNull();
  });
});

describe("below-cost sale approval — server errors in Vietnamese", () => {
  beforeEach(() => vi.stubGlobal("navigator", { onLine: true }));
  afterEach(() => vi.unstubAllGlobals());

  const cases: Array<[string, RegExp]> = [
    ["SALE_BELOW_COST_APPROVAL_REQUIRED", /Gửi yêu cầu duyệt/],
    ["SALE_APPROVAL_PENDING", /chờ chủ duyệt/],
    ["ALREADY_PENDING", /trùng/],
    ["ALREADY_RESOLVED", /đã được xử lý/],
    ["APPROVAL_STALE_DATA", /thay đổi sau khi gửi đơn/],
    ["SALE_NOT_BELOW_COST", /không cần duyệt/],
    ["APPROVAL_NOT_FOUND", /không còn trong danh sách chờ duyệt/],
    ["PURCHASE_PRICE_REQUIRED", /giá thu mua/],
  ];

  it.each(cases)("%s maps to its own guidance", (code, expected) => {
    expect(friendlyError(serverError("22023", code))).toMatch(expected);
  });

  it("never shows the raw SQLCODE or the generic 'cannot sell' fallback", () => {
    for (const [code] of cases) {
      const message = friendlyError(serverError("22023", code));
      expect(message).not.toContain(code);
      expect(message).not.toBe(
        "Không thể bán xe. Xe có thể đã được bán hoặc thay đổi bởi người dùng khác.",
      );
    }
  });

  it("keeps access denial readable for a non-OWNER approver", () => {
    expect(
      friendlyError(serverError("42501", "ACCESS_DENIED: only OWNER may resolve")),
    ).toMatch(/quyền/);
  });
});

describe("below-cost sale approval — activity labels", () => {
  const actions = [
    "REQUEST_SALE_BELOW_COST",
    "APPROVE_SALE_BELOW_COST",
    "REJECT_SALE_BELOW_COST",
    "CANCEL_SALE_BELOW_COST",
  ] as const;

  it("labels every queue action in the vehicle timeline and audit log", () => {
    for (const action of actions) {
      expect(actionLabels[action]).toBeTruthy();
      expect(auditActionChips[action]).toBeTruthy();
      expect(auditActionPhrases[action]).toBeTruthy();
    }
    expect(actionLabels.APPROVE_SALE_BELOW_COST).toMatch(/duyệt/i);
    expect(auditActionPhrases.REJECT_SALE_BELOW_COST).toMatch(/từ chối/i);
  });
});
