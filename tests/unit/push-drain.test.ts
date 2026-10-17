// bumpPushDrain: realtime báo tin mới → hàng đợi Web Push được rút ngay, nhưng
// PHẢI gom burst thành đúng một lời gọi push-dispatch (chi phí invoke + chống
// trùng lô). Kèm điều kiện: trình duyệt không có PushManager thì im lặng.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../src/lib/supabase", () => ({
  get supabase() {
    return { functions: { invoke } };
  },
}));
vi.mock("../../src/lib/api", () => ({ api: { call: vi.fn() } }));
vi.mock("../../src/lib/errors", () => ({
  AppError: class AppError extends Error {},
  friendlyError: (e: unknown) => e,
}));

import { bumpPushDrain } from "../../src/lib/push";

// Node (vitest env mặc định) không có window/PushManager — gán trực tiếp lên
// globalThis để mô phỏng browser tại nơi push.ts nhìn vào.
const g = globalThis as unknown as { window?: unknown; PushManager?: unknown };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ data: null, error: null });
  vi.useFakeTimers();
  g.window = globalThis;
});

afterEach(() => {
  vi.useRealTimers();
  delete g.window;
  delete g.PushManager;
});

describe("bumpPushDrain", () => {
  it("unsupported browser (no PushManager) never triggers an invoke", async () => {
    bumpPushDrain(10);
    await vi.advanceTimersByTimeAsync(100);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a burst of realtime events coalesces into exactly one push-dispatch call", async () => {
    g.PushManager = class {};
    bumpPushDrain(20);
    bumpPushDrain(20);
    bumpPushDrain(20);
    await vi.advanceTimersByTimeAsync(5);
    expect(invoke).not.toHaveBeenCalled(); // còn trong ô cửa gom
    await vi.advanceTimersByTimeAsync(30);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("push-dispatch", { body: {} });
  });

  it("a later event after the window opens a fresh drain (not lost)", async () => {
    g.PushManager = class {};
    bumpPushDrain(10);
    await vi.advanceTimersByTimeAsync(10);
    bumpPushDrain(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("dispatch failure is swallowed — the DB queue keeps the work for next time", async () => {
    g.PushManager = class {};
    invoke.mockRejectedValue(new Error("offline"));
    bumpPushDrain(10);
    await vi.advanceTimersByTimeAsync(10); // không được ném ra ngoài
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
