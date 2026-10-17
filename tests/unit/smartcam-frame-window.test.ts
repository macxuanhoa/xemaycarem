import { describe, expect, it } from "vitest";
import { cameraViewportBounds } from "../../src/lib/smartcam/capture";
import {
  appendScanSample,
  bestScanSample,
  SCAN_WINDOW_SIZE,
  type ScanSample,
} from "../../src/lib/smartcam/local/frameWindow";
import type { FrameAnalysis } from "../../src/lib/smartcam/local/regions";
const analysis = (score: number) => ({ quality: { score } }) as FrameAnalysis;
const sample = (slots: number, value: number, score: number) => ({
  slots,
  value,
  analysis: analysis(score),
});
describe("bounded scan evidence", () => {
  it("keeps a bounded window and chooses the clearest frame of the same shape", () => {
    let window: ScanSample<number>[] = [sample(9, 1, 0.9)];
    for (const i of [2, 3, 4, 5, 6, 7])
      window = appendScanSample(window, sample(9, i, i / 10));
    expect(window).toHaveLength(SCAN_WINDOW_SIZE);
    expect(window.map((x) => x.value)).toEqual([3, 4, 5, 6, 7]);
    expect(bestScanSample(window)?.value).toBe(7);
    expect(
      bestScanSample([sample(9, 1, 0.9), sample(9, 2, 0.2)])?.value,
    ).toBe(1);
  });
  it("keeps frames that differ by one glyph, because the vote decides", () => {
    // The old key was the exact string, so a single wobbling character threw
    // away every sharp frame before it. Shape alone keeps the window.
    const window = appendScanSample(
      [sample(9, 1, 1), sample(9, 2, 0.8)],
      sample(9, 3, 0.6),
    );
    expect(window.map((x) => x.value)).toEqual([1, 2, 3]);
  });
  it("discards old evidence on a different shape or a frame that read nothing", () => {
    expect(appendScanSample([sample(9, 1, 1)], sample(8, 2, 0.1)).map((x) => x.value)).toEqual([2]);
    expect(appendScanSample([sample(9, 1, 1)], sample(0, 3, 0.1)).map((x) => x.value)).toEqual([3]);
  });
  it("uses the latest frame when quality analysis is unavailable", () => {
    expect(
      bestScanSample([
        { slots: 0, analysis: null, value: 1 },
        { slots: 0, analysis: null, value: 2 },
      ])?.value,
    ).toBe(2);
    expect(bestScanSample([])).toBeUndefined();
  });
});
describe("camera visible viewport", () => {
  it("reads all visible pixels and excludes hidden object-fit cover edges", () => {
    expect(cameraViewportBounds(1920, 1080, 320, 240, false)).toEqual({
      x: 240,
      y: 0,
      width: 1440,
      height: 1080,
    });
    expect(cameraViewportBounds(1080, 1920, 400, 250, false)).toEqual({
      x: 0,
      y: 622.5,
      width: 1080,
      height: 675,
    });
  });
  it("retains the smaller QR/CCCD guide mapping", () => {
    const bounds = cameraViewportBounds(1280, 800, 640, 400, true)!;
    expect({ ...bounds, height: Math.round(bounds.height) }).toEqual({
      x: 128,
      y: 176,
      width: 1024,
      height: 464,
    });
    expect(cameraViewportBounds(0, 800, 640, 400, false)).toBeNull();
  });
});
