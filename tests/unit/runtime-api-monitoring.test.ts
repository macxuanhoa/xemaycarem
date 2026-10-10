import { beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError, FunctionsFetchError } from "@supabase/supabase-js";
const { rpc, invoke, reportRuntimeIssue } = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  reportRuntimeIssue: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc, functions: { invoke } } }));
vi.mock("@/lib/runtimeMonitoring", () => ({ reportRuntimeIssue }));
import { api } from "@/lib/api";
beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  reportRuntimeIssue.mockReset();
  vi.stubGlobal("navigator", { onLine: true });
});
describe("safe API failure monitoring", () => {
  it("reports server failures without arguments or raw details", async () => {
    const error = {
      code: "XX000",
      message: "SECRET CCCD079123456789",
      details: "PRIVATE DATA",
    };
    rpc.mockResolvedValue({ data: null, error, status: 500 });
    await expect(api.call("get_vehicle", { p_id: "PRIVATE-ID" })).rejects.toBe(
      error,
    );
    expect(reportRuntimeIssue).toHaveBeenCalledExactlyOnceWith(
      "rpc",
      "RPC_SERVER_ERROR",
      "get_vehicle",
    );
  });
  it("ignores expected business validation, conflicts and access denials", async () => {
    for (const [code, status] of [
      ["22023", 400],
      ["40001", 409],
      ["42501", 403],
    ]) {
      rpc.mockResolvedValue({
        data: null,
        error: { code, message: "PRIVATE" },
        status,
      });
      await expect(
        api.call("save_vehicle", { payload: "PRIVATE" }),
      ).rejects.toBeDefined();
    }
    expect(reportRuntimeIssue).not.toHaveBeenCalled();
  });
  it("reports unexpected network loss but never recursively reports monitoring failures", async () => {
    rpc.mockRejectedValue(new TypeError("SECRET FETCH URL"));
    await expect(api.call("get_vehicle")).rejects.toThrow("SECRET");
    expect(reportRuntimeIssue).toHaveBeenCalledExactlyOnceWith(
      "rpc",
      "NETWORK_ERROR",
      "get_vehicle",
    );
    reportRuntimeIssue.mockClear();
    await expect(api.call("list_client_issues")).rejects.toThrow("SECRET");
    expect(reportRuntimeIssue).not.toHaveBeenCalled();
  });
  it("reports edge 5xx but excludes expected edge 4xx", async () => {
    for (const status of [503, 403]) {
      invoke.mockResolvedValue({
        data: null,
        error: new FunctionsHttpError(
          new Response(JSON.stringify({ message: "PRIVATE" }), { status }),
        ),
      });
      await expect(api.assist({ photo: "PRIVATE" })).rejects.toThrow("PRIVATE");
    }
    expect(reportRuntimeIssue).toHaveBeenCalledExactlyOnceWith(
      "edge",
      "EDGE_SERVER_ERROR",
      "ai-assist",
    );
  });
  it("records only a generic edge network code", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: new FunctionsFetchError("SECRET URL"),
    });
    await expect(api.assist({ photo: "PRIVATE" })).rejects.toThrow("kết nối");
    expect(reportRuntimeIssue).toHaveBeenCalledExactlyOnceWith(
      "edge",
      "NETWORK_ERROR",
      "ai-assist",
    );
  });
});
