import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameAnalysis } from "../../src/lib/smartcam/local/regions";

const doubles = vi.hoisted(() => ({
  recognize: vi.fn(),
  setParameters: vi.fn(),
  terminate: vi.fn(),
  analyzeFrame: vi.fn(),
  regionCanvas: vi.fn(),
  bandCanvas: vi.fn(),
  preprocessedFull: vi.fn(),
  sourceCanvas: vi.fn(),
}));
vi.mock("tesseract.js", () => ({
  PSM: { SINGLE_LINE: 7, SINGLE_BLOCK: 6, SPARSE_TEXT: 11 },
  createWorker: vi.fn(async () => ({
    recognize: doubles.recognize,
    setParameters: doubles.setParameters,
    terminate: doubles.terminate,
  })),
}));
vi.mock("../../src/lib/smartcam/local/frames", () => ({
  analyzeFrame: doubles.analyzeFrame,
  regionCanvas: doubles.regionCanvas,
  bandCanvas: doubles.bandCanvas,
  preprocessedFull: doubles.preprocessedFull,
  sourceCanvas: doubles.sourceCanvas,
}));
import {
  localReadFrame,
  releaseOcrWorker,
} from "../../src/lib/smartcam/local/ocr";

class FrameCanvas {
  width = 640;
  height = 400;
}
const source = new FrameCanvas() as HTMLCanvasElement;
const analysis = (count = 1): FrameAnalysis => ({
  width: 640,
  height: 400,
  regions: Array.from({ length: count }, (_, index) => ({
    bounds: { x: 10, y: 20 + index * 70, width: 260, height: 50 },
    normalized: {
      x: 10 / 640,
      y: (20 + index * 70) / 400,
      width: 260 / 640,
      height: 50 / 400,
    },
    kind: index === 1 ? "block" : "line",
    confidence: 0.8,
    characterHeight: 30,
    angleDegrees: 12,
  })),
  quality: {
    score: 0.9,
    meanLuma: 150,
    contrast: 200,
    sharpness: 0.4,
    darkFraction: 0.1,
    brightFraction: 0.1,
    issues: [],
    message: "",
  },
});
const observation = (text: string) => ({
  data: { text, confidence: 95, blocks: [] },
});

beforeEach(() => {
  vi.stubGlobal("HTMLCanvasElement", FrameCanvas);
  doubles.recognize.mockReset();
  doubles.setParameters.mockReset();
  doubles.analyzeFrame.mockReset();
  doubles.regionCanvas.mockReset();
  doubles.bandCanvas.mockReset();
  doubles.preprocessedFull.mockReset();
  doubles.analyzeFrame.mockReturnValue(analysis());
  doubles.regionCanvas.mockReturnValue({
    width: 600,
    height: 120,
    region: true,
  });
  doubles.bandCanvas.mockReturnValue({ width: 880, height: 180, band: true });
  doubles.preprocessedFull.mockReturnValue({
    width: 1080,
    height: 675,
    full: true,
  });
});
afterEach(async () => {
  releaseOcrWorker();
  await Promise.resolve();
  vi.unstubAllGlobals();
});

describe("localized OCR with complete-photo safeguards", () => {
  it("reads a detected crop then always checks the full image for a conflicting plate", async () => {
    doubles.recognize
      .mockResolvedValueOnce(observation("59B1-234.56"))
      .mockResolvedValueOnce(observation("59B1-234.56\n61A1-777.77"));
    const read = await localReadFrame(source);
    expect(read?.license_plate).toBe("");
    expect(read?.ambiguous).toEqual(["license_plate"]);
    expect(read?.passes).toBe(2);
    expect(doubles.bandCanvas).not.toHaveBeenCalled();
    expect(doubles.preprocessedFull).toHaveBeenCalledWith(source, 1080);
    expect(read?.analysis?.regions).toHaveLength(1);
  });

  it("bounds focused work to two crops plus one full pass and preserves both identifiers", async () => {
    const frameAnalysis = analysis(4);
    doubles.recognize
      .mockResolvedValueOnce(observation("RLH160KD12345"))
      .mockResolvedValueOnce(observation("59-B1\n234.56"))
      .mockResolvedValueOnce(observation("59-B1\n234.56\nRLH160KD12345"));
    const read = await localReadFrame(source, { analysis: frameAnalysis });
    expect(doubles.analyzeFrame).not.toHaveBeenCalled();
    expect(doubles.regionCanvas).toHaveBeenCalledTimes(2);
    expect(doubles.recognize).toHaveBeenCalledTimes(3);
    expect(
      doubles.setParameters.mock.calls.map(
        ([params]) => params.tessedit_pageseg_mode,
      ),
    ).toEqual([7, 6, 11]);
    expect(read?.license_plate).toBe("59B1-234.56");
    expect(read?.frame_number).toBe("RLH160KD12345");
    expect(read?.ambiguous).toEqual([]);
  });

  it("keeps both legacy passes when the pixel locator finds no usable region", async () => {
    doubles.analyzeFrame.mockReturnValue(analysis(0));
    doubles.recognize
      .mockResolvedValueOnce(observation(""))
      .mockResolvedValueOnce(observation("RLH160KD12345"));
    const read = await localReadFrame(source);
    expect(doubles.bandCanvas).toHaveBeenCalledWith(source);
    expect(doubles.regionCanvas).not.toHaveBeenCalled();
    expect(doubles.preprocessedFull).toHaveBeenCalledWith(source, 1080);
    expect(read?.frame_number).toBe("RLH160KD12345");
    expect(read?.passes).toBe(2);
  });

  it("recomputes analysis when a caller passes bounds from another image size", async () => {
    doubles.recognize.mockResolvedValue(observation(""));
    await localReadFrame(source, { analysis: { ...analysis(), width: 320 } });
    expect(doubles.analyzeFrame).toHaveBeenCalledWith(source);
  });

  it("reads both live crops in parallel and skips the full-frame pass once a crop is confident", async () => {
    doubles.recognize
      .mockResolvedValueOnce(observation("59B1-234.56"))
      .mockResolvedValueOnce(observation(""));
    const read = await localReadFrame(source, {
      analysis: analysis(2),
      fast: true,
    });
    expect(doubles.regionCanvas).toHaveBeenCalledTimes(2);
    expect(doubles.recognize).toHaveBeenCalledTimes(2);
    // The merged crops clear the confidence gate — the expensive sparse pass
    // must not run, and the plate still passes the same validator.
    expect(doubles.preprocessedFull).not.toHaveBeenCalled();
    expect(read?.license_plate).toBe("59B1-234.56");
    expect(read?.passes).toBe(2);
  });
});
