import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { call } }));
import { confirmOperation, executeOperation, pendingOperation, retainOperation } from "@/lib/operationRecovery";

describe("durable operation recovery", () => {
  const records = new Map<string, string>();
  beforeEach(() => {
    records.clear(); call.mockReset();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => records.set(key, value),
      removeItem: (key: string) => records.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("persists only UUIDs with actor, operation and scope isolation", () => {
    const id = retainOperation("actor", "acquire_vehicle", "new");
    expect(retainOperation("actor", "acquire_vehicle", "new")).toBe(id);
    expect(pendingOperation("other", "acquire_vehicle", "new")).toBeNull();
    expect(pendingOperation("actor", "sell_vehicle", "new")).toBeNull();
    expect([...records.values()]).toEqual([id]);
    confirmOperation("actor", "acquire_vehicle", "new", crypto.randomUUID());
    expect(pendingOperation("actor", "acquire_vehicle", "new")).toBe(id);
  });
  it("reconciles a previously committed outcome instead of creating another mutation", async () => {
    retainOperation("actor", "import_vehicles", "batch");
    call.mockResolvedValue({ confirmed: true, result: { imported_count: 2 } });
    const send = vi.fn();
    expect(await executeOperation("actor", "import_vehicles", "batch", send)).toEqual({ imported_count: 2 });
    expect(send).not.toHaveBeenCalled();
    expect(records.size).toBe(0);
  });
  it("retains the same UUID after loss and checks server before retry", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue("saved");
    await expect(executeOperation("actor", "sell_vehicle", "vehicle", send)).rejects.toThrow("network");
    const id = pendingOperation("actor", "sell_vehicle", "vehicle");
    call.mockResolvedValue({ confirmed: false, result: null });
    expect(await executeOperation("actor", "sell_vehicle", "vehicle", send)).toBe("saved");
    expect(send.mock.calls.map(args => args[0])).toEqual([id, id]);
    expect(records.size).toBe(0);
  });
  it("does not submit when storage is full or a pending UUID is corrupted", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    const send = vi.fn();
    await expect(executeOperation("actor", "acquire_vehicle", "new", send)).rejects.toThrow(/chưa được gửi/);
    expect(send).not.toHaveBeenCalled();
    vi.stubGlobal("localStorage", { getItem: () => "corrupted" });
    await expect(executeOperation("actor", "acquire_vehicle", "new", send)).rejects.toThrow(/không hợp lệ/);
    expect(send).not.toHaveBeenCalled();
  });
});
