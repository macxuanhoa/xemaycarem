/**
 * Camera device-control helpers: the torch constraint shapes real phones
 * report (boolean vs Android's numeric range vs absent), re-reading the TRUE
 * flash state after driver resets, and the lens-flip planner behind the
 * labelled "Camera trước / Camera sau" button.
 */
import { describe, expect, it } from "vitest";
import {
  applyTorch,
  cameraFlipLabel,
  nextCameraPlan,
  torchMode,
  torchStateFromSettings,
} from "../../src/lib/smartcam/capture";

describe("torch capability handling", () => {
  it("detects the constraint shape each device family reports", () => {
    expect(torchMode({ torch: true })).toBe("boolean");
    expect(torchMode({ torch: { min: 0, max: 2 } })).toBe("number");
    expect(torchMode({ torch: { min: 0, max: 0 } })).toBe("none");
    expect(torchMode({ torch: false })).toBe("none");
    expect(torchMode({})).toBe("none");
    expect(torchMode(undefined)).toBe("none");
  });
  it("reads the real torch state from track settings, number or boolean", () => {
    expect(torchStateFromSettings({ getSettings: () => ({ torch: true }) })).toBe(true);
    expect(torchStateFromSettings({ getSettings: () => ({ torch: 1 }) })).toBe(true);
    expect(torchStateFromSettings({ getSettings: () => ({ torch: false }) })).toBe(false);
    expect(torchStateFromSettings({ getSettings: () => ({ torch: 0 }) })).toBe(false);
    expect(torchStateFromSettings({ getSettings: () => ({}) })).toBe(false);
  });
  it("applies the constraint in the shape the device accepts", async () => {
    const seen: unknown[] = [];
    const track = { applyConstraints: async (c: unknown) => { seen.push(c); } };
    await applyTorch(track, "boolean", true);
    await applyTorch(track, "number", true);
    await applyTorch(track, "number", false);
    expect(seen[0]).toEqual({ advanced: [{ torch: true }] });
    expect(seen[1]).toEqual({ advanced: [{ torch: 1 }] });
    expect(seen[2]).toEqual({ advanced: [{ torch: 0 }] });
  });
});

describe("camera flip planner", () => {
  const back = { deviceId: "b1", label: "Back camera" };
  const back2 = { deviceId: "b2", label: "Rear 2" };
  const front = { deviceId: "f1", label: "Front camera" };

  it("toggles rear ↔ front on a normal two-lens phone", () => {
    expect(nextCameraPlan([back, front], "b1", "environment")).toEqual({ deviceId: "f1" });
    expect(nextCameraPlan([back, front], "f1", "user")).toEqual({ deviceId: "b1" });
  });
  it("cycles list order when there is no front lens to flip to", () => {
    expect(nextCameraPlan([back, back2, front], "b1", "environment")).toEqual({ deviceId: "f1" });
    const rearOnly = [back, back2];
    expect(nextCameraPlan(rearOnly, "b1", "environment")).toEqual({ deviceId: "b2" });
    expect(nextCameraPlan(rearOnly, "b2", "environment")).toEqual({ deviceId: "b1" });
  });

  it("falls back to facing-mode constraints when ids are unusable", () => {
    // Before permission, labels are blank and deviceId can be empty.
    const anon = [{ deviceId: "", label: "" }];
    expect(nextCameraPlan(anon, "", "environment")).toEqual({ facing: "user" });
    expect(nextCameraPlan(anon, "", "user")).toEqual({ facing: "environment" });
    expect(nextCameraPlan([], "x", "environment")).toEqual({ facing: "user" });
  });

  it("labels the button with the lens it switches TO", () => {
    expect(cameraFlipLabel("environment")).toBe("Camera trước");
    expect(cameraFlipLabel("user")).toBe("Camera sau");
  });
});
