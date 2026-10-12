import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { friendlyError } from "@/lib/errors";

const network = vi.hoisted(() => ({
  online: true,
  browserOnline: true,
  listeners: new Set<() => void>(),
  failure: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/networkStatus", () => ({
  isOnline: () => network.online,
  getNetworkStatus: () => ({ browserOnline: network.browserOnline }),
  reportNetworkFailure: network.failure,
  reportNetworkSuccess: network.success,
  subscribeNetworkStatus: (listener: () => void) => {
    network.listeners.add(listener);
    return () => network.listeners.delete(listener);
  },
}));
import { networkFetch, NetworkRequestError } from "@/lib/networkRequest";

const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  network.online = true;
  network.browserOnline = true;
  network.failure.mockClear();
  network.success.mockClear();
  network.listeners.clear();
  transport.mockReset();
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", transport);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function waitUntilAborted() {
  transport.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
}

describe("bounded network transport", () => {
  it("rejects an offline write immediately without queuing or sending", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(networkFetch("https://server.test/rpc/sell", { method: "POST" }))
      .rejects.toThrow("Giao dịch chưa được gửi");
    vi.stubGlobal("navigator", { onLine: true });
    for (const listener of network.listeners) listener();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport).not.toHaveBeenCalled();
    expect(network.failure).not.toHaveBeenCalled();
  });

  it("blocks requests while WiFi is online but server recovery is unconfirmed", async () => {
    network.online = false;
    await expect(networkFetch("https://server.test/rpc/sell", { method: "POST" }))
      .rejects.toThrow("Yêu cầu chưa được gửi");
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports a lost response once and never claims the write was not committed", async () => {
    transport.mockRejectedValue(new TypeError("Failed to fetch"));
    const operation = networkFetch("https://server.test/rpc/sell", { method: "POST" });
    await expect(operation).rejects.toBeInstanceOf(NetworkRequestError);
    await expect(operation).rejects.toThrow("chưa được xác nhận");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(network.failure).toHaveBeenCalledTimes(1);
    expect(network.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops an unresponsive request after 30 seconds and releases resources", async () => {
    waitUntilAborted();
    const operation = networkFetch("https://server.test/rpc/payment", { method: "POST" });
    const assertion = expect(operation).rejects.toThrow("phản hồi quá lâu");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(network.failure).toHaveBeenCalledTimes(1);
    expect(network.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives image uploads 60 seconds without retrying the upload", async () => {
    waitUntilAborted();
    const operation = networkFetch("https://server.test/storage/v1/object/vehicle-images/image", { method: "POST" });
    const assertion = expect(operation).rejects.toThrow("phản hồi quá lâu");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(network.failure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline alive when HTTP 200 headers arrive but the body stalls", async () => {
    const cancelBody = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":'));
      },
      cancel: cancelBody,
    });
    transport.mockResolvedValue(new Response(body, { status: 200 }));
    const operation = networkFetch("https://server.test/rpc/payment", { method: "POST" });
    const assertion = expect(operation).rejects.toThrow("chưa được xác nhận");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(network.success).not.toHaveBeenCalled();
    expect(network.failure).toHaveBeenCalledTimes(1);
    expect(network.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("waits for the entire body and returns a still-readable original response", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('{"confirmed":'));
      },
    });
    const response = new Response(body, { status: 200 });
    transport.mockResolvedValue(response);
    const operation = networkFetch("https://server.test/rpc/payment", { method: "POST" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(network.success).not.toHaveBeenCalled();
    bodyController!.enqueue(new TextEncoder().encode("true}"));
    bodyController!.close();
    const completed = await operation;
    expect(completed).toBe(response);
    expect(await completed.json()).toEqual({ confirmed: true });
    expect(network.success).toHaveBeenCalledExactlyOnceWith(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a transport that ignores the abort signal", async () => {
    transport.mockImplementation(() => new Promise(() => {}));
    const assertion = expect(networkFetch("https://server.test/rpc/payment", { method: "POST" }))
      .rejects.toThrow("phản hồi quá lâu");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(network.failure).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("cancels in-flight work on browser disconnect without replaying on reconnect", async () => {
    waitUntilAborted();
    const operation = networkFetch("https://server.test/rpc/sell", { method: "POST" });
    const assertion = expect(operation).rejects.toThrow("chưa được xác nhận");
    network.browserOnline = false;
    for (const listener of network.listeners) listener();
    await assertion;
    network.browserOnline = true;
    for (const listener of network.listeners) listener();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(network.failure).toHaveBeenCalledTimes(1);
    expect(network.listeners.size).toBe(0);
  });

  it("preserves caller cancellation without reporting a connection failure", async () => {
    waitUntilAborted();
    const controller = new AbortController();
    const reason = new DOMException("Navigation", "AbortError");
    const request = new Request("https://server.test/profiles", { signal: controller.signal });
    const operation = networkFetch(request);
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(network.failure).not.toHaveBeenCalled();
    expect(network.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 401, 403, 500, 503])("passes HTTP %i through to existing error handling", async (status) => {
    const response = new Response("{}", { status });
    transport.mockResolvedValue(response);
    await expect(networkFetch("https://server.test/rpc/check")).resolves.toBe(response);
    expect(network.success).toHaveBeenCalledExactlyOnceWith(status);
    expect(network.failure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an uncertain-write message through the real Supabase SDK", async () => {
    transport.mockRejectedValue(new TypeError("Failed to fetch"));
    const client = createClient("https://network-test.supabase.co", "public-test", {
      global: { fetch: networkFetch },
      db: { retry: false },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await client.rpc("sell_vehicle", { p_data: { name: "Synthetic" } });
    expect(result.status).toBe(0);
    expect(friendlyError(result.error)).toContain("chưa được xác nhận");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(network.failure).toHaveBeenCalledTimes(1);
  });
});
