/**
 * Camera device-control helpers: the torch constraint shapes real phones
 * report (boolean sequence vs boolean vs numeric range vs absent), re-reading the TRUE
 * flash state after driver resets, and the lens-flip planner behind the
 * labelled "Camera trước / Camera sau" button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyContinuousFocus,
  applyTorch,
  applyZoom,
  cameraFlipLabel,
  currentZoomLevel,
  loadCameraSettings,
  nextCameraPlan,
  supportsContinuousFocus,
  torchMode,
  torchStateFromSettings,
  viewfinderCanvas,
  zoomCapability,
} from "../../src/lib/smartcam/capture";

afterEach(() => vi.unstubAllGlobals());

describe("camera settings migration", () => {
  it.each(["scan", "photo", "qr", "identity"])("restores %s while enabling built-in scan features", (mode) => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({
      mode, sound: false, localOcr: false, autoOpen: false, cloudMode: "manual",
    }) });
    expect(loadCameraSettings()).toEqual({ mode, sound: true, localOcr: true, autoOpen: true, cloudMode: "off" });
  });

  it("preserves explicit automatic AI consent without restoring old opt-outs", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ mode: "photo", cloudMode: "auto", sound: false }) });
    expect(loadCameraSettings()).toEqual({ mode: "photo", sound: true, localOcr: true, autoOpen: true, cloudMode: "auto" });
  });

  it.each([null, "invalid JSON", JSON.stringify({ mode: "old-recognition-mode" })])("uses safe defaults for absent or invalid saved settings: %s", (saved) => {
    vi.stubGlobal("localStorage", { getItem: () => saved });
    expect(loadCameraSettings()).toEqual({ mode: "scan", sound: true, localOcr: true, autoOpen: true, cloudMode: "off" });
  });
});

describe("viewfinder capture follows the visible camera guide", () => {
  it.each([
    {
      name: "landscape video cropped into a portrait preview",
      source: [1920, 1080], preview: [300, 400],
      crop: [636, 237.6, 648, 626.4], output: [648, 626],
    },
    {
      name: "portrait video cropped into a landscape preview",
      source: [1080, 1920], preview: [640, 360],
      crop: [108, 789.9, 864, 352.35], output: [864, 352],
    },
    {
      name: "large landscape video remains bounded after portrait cropping",
      source: [3840, 2160], preview: [300, 400],
      crop: [1272, 475.2, 1296, 1252.8], output: [1280, 1237],
    },
  ])("maps the guide accurately for $name", ({ source, preview, crop, output }) => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
    vi.stubGlobal("document", { createElement: () => canvas });
    const video = { videoWidth: source[0], videoHeight: source[1], clientWidth: preview[0], clientHeight: preview[1] } as HTMLVideoElement;

    expect(viewfinderCanvas(video)).toBe(canvas);
    expect([canvas.width, canvas.height]).toEqual(output);
    const args = drawImage.mock.calls[0];
    expect(args[0]).toBe(video);
    for (let index = 0; index < crop.length; index++) expect(args[index + 1]).toBeCloseTo(crop[index], 6);
    expect(args.slice(5)).toEqual([0, 0, ...output]);
    // On the displayed preview, the source crop must land exactly inside
    // the guide at 10%/22% with 80% width and 58% height despite cover clipping.
    const coverScale = Math.max(preview[0] / source[0], preview[1] / source[1]);
    const offsetX = (source[0] * coverScale - preview[0]) / 2;
    const offsetY = (source[1] * coverScale - preview[1]) / 2;
    expect(args[1] * coverScale - offsetX).toBeCloseTo(preview[0] * 0.1, 6);
    expect(args[2] * coverScale - offsetY).toBeCloseTo(preview[1] * 0.22, 6);
    expect(args[3] * coverScale).toBeCloseTo(preview[0] * 0.8, 6);
    expect(args[4] * coverScale).toBeCloseTo(preview[1] * 0.58, 6);
  });
});

describe("torch capability handling", () => {
  it("detects the constraint shape each device family reports", () => {
    expect(torchMode({ torch: true })).toBe("boolean");
    expect(torchMode({ torch: { min: 0, max: 2 } })).toBe("number");
    expect(torchMode({ torch: { min: 0, max: 0 } })).toBe("none");
    expect(torchMode({ torch: false })).toBe("none");
    expect(torchMode({})).toBe("none");
    expect(torchMode(undefined)).toBe("none");
  });
  it("accepts the supported boolean states defined by Image Capture", () => {
    expect(torchMode({ torch: [false, true] })).toBe("boolean");
    expect(torchMode({ torch: [true, false] })).toBe("boolean");
    expect(torchMode({ torch: [true] })).toBe("boolean");
    expect(torchMode({ torch: [false] })).toBe("none");
    expect(torchMode({ torch: [] })).toBe("none");
    expect(torchMode({ torch: ["true"] })).toBe("none");
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

  it.each(["environment", "user"] as const)("requests the opposite facing with incomplete device information from %s", (facing) => {
    const opposite = facing === "environment" ? "user" : "environment";
    for (const cameras of [
      [back],
      [back, { deviceId: "", label: "Front camera" }],
      [back, { ...back, label: "Duplicate rear lens" }],
      [{ deviceId: "b1", label: "" }, { deviceId: "f1", label: "" }],
      [{ deviceId: "b1", label: "Camera 1" }, { deviceId: "f1", label: "Camera 2" }],
    ]) expect(nextCameraPlan(cameras, "b1", facing)).toEqual({ facing: opposite });
    expect(nextCameraPlan([back, front], "unknown", facing)).toEqual({ facing: opposite });
    expect(nextCameraPlan([back, front], "", facing)).toEqual({ facing: opposite });
  });

  it("does not mistake an unidentified alternate lens for the front camera", () => {
    expect(nextCameraPlan([back, { deviceId: "other", label: "Camera 2" }], "b1", "environment")).toEqual({ facing: "user" });
  });

  it("labels the button with the lens it switches TO", () => {
    expect(cameraFlipLabel("environment")).toBe("Camera trước");
    expect(cameraFlipLabel("user")).toBe("Camera sau");
  });
});

describe("zoom capability handling", () => {
  it("detects valid zoom ranges reported by camera hardware", () => {
    expect(zoomCapability({ zoom: { min: 1, max: 4, step: 0.1 } })).toEqual({
      min: 1,
      max: 4,
      step: 0.1,
    });
    expect(zoomCapability({ zoom: { min: 1, max: 1 } })).toBeNull();
    expect(zoomCapability({ zoom: false })).toBeNull();
    expect(zoomCapability({})).toBeNull();
    expect(zoomCapability(undefined)).toBeNull();
  });

  it("reads current zoom level from track settings", () => {
    expect(currentZoomLevel({ getSettings: () => ({ zoom: 2 }) })).toBe(2);
    expect(currentZoomLevel({ getSettings: () => ({ zoom: 1 }) })).toBe(1);
    expect(currentZoomLevel({ getSettings: () => ({}) })).toBe(1);
  });

  it("applies zoom constraints to track", async () => {
    const seen: unknown[] = [];
    const track = {
      applyConstraints: async (c: unknown) => {
        seen.push(c);
      },
    };
    await applyZoom(track, 2);
    expect(seen[0]).toEqual({ advanced: [{ zoom: 2 }] });
  });
});

describe("continuous focus capability handling", () => {
  it("detects continuous focus support", () => {
    expect(
      supportsContinuousFocus({ focusMode: ["continuous", "manual"] }),
    ).toBe(true);
    expect(supportsContinuousFocus({ focusMode: ["manual"] })).toBe(false);
    expect(supportsContinuousFocus({})).toBe(false);
    expect(supportsContinuousFocus(undefined)).toBe(false);
  });

  it("applies continuous focus constraints with optional points of interest", async () => {
    const seen: unknown[] = [];
    const track = {
      applyConstraints: async (c: unknown) => {
        seen.push(c);
      },
    };
    await applyContinuousFocus(track);
    await applyContinuousFocus(track, { x: 0.5, y: 0.5 });
    expect(seen[0]).toEqual({ advanced: [{ focusMode: "continuous" }] });
    expect(seen[1]).toEqual({
      advanced: [
        { focusMode: "continuous", pointsOfInterest: [{ x: 0.5, y: 0.5 }] },
      ],
    });
  });
});

