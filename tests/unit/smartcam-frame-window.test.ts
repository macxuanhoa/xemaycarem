import { describe, expect, it } from "vitest";
import { cameraViewportBounds } from "../../src/lib/smartcam/capture";
import {
  appendScanSample,
  bestScanSample,
  type ScanSample,
} from "../../src/lib/smartcam/local/frameWindow";
import type { FrameAnalysis } from "../../src/lib/smartcam/local/regions";
const analysis = (score: number) => ({ quality: { score } }) as FrameAnalysis;
const sample = (key: string, value: number, score: number) => ({
  key,
  value,
  analysis: analysis(score),
});
describe("bounded scan evidence", () => {
  it("keeps at most three frames and chooses the clearest among the same identifier", () => {
    let window: ScanSample<number>[] = [sample("A", 1, 0.9)];
    for (const i of [2, 3, 4])
      window = appendScanSample(window, sample("A", i, i / 10));
    expect(window.map((x) => x.value)).toEqual([2, 3, 4]);
    expect(bestScanSample(window)?.value).toBe(4);
    expect(
      bestScanSample([sample("A", 1, 0.9), sample("A", 2, 0.2)])?.value,
    ).toBe(1);
  });
  it("discards old evidence immediately on a different or missing identifier", () => {
    expect(
      appendScanSample([sample("A", 1, 1)], sample("B", 2, 0.1)).map(
        (x) => x.value,
      ),
    ).toEqual([2]);
    expect(
      appendScanSample([sample("A", 1, 1)], sample("", 3, 0.1)).map(
        (x) => x.value,
      ),
    ).toEqual([3]);
  });
  it("uses the latest frame when quality analysis is unavailable", () => {
    expect(
      bestScanSample([
        { key: "", analysis: null, value: 1 },
        { key: "", analysis: null, value: 2 },
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
