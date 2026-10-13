/**
 * Off-main-thread frame analysis. The live scan loop transfers one
 * ImageBitmap per tick here; everything expensive — viewport crop,
 * downscale, greyscale, 8×8 scene signature and the full Otsu/BFS text
 * localization — runs against an OffscreenCanvas in this worker, so the
 * phone's main thread only paints the camera preview and the UI.
 *
 * The math mirrors cameraViewportCanvas() on the main thread exactly:
 * identical crop bounds, identical 1600 px cap, identical rounding — so the
 * returned region coordinates line up with the canvas OCR crops from.
 */
import { grayFromRgba, sceneSignature } from "./frames";
import { analyzeGray, type FrameAnalysis } from "./regions";

export type WorkerCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type AnalysisRequest = {
  id: number;
  bitmap: ImageBitmap;
  /** null = decode the whole bitmap. */
  crop: WorkerCrop | null;
  maxEdge: number;
};
export type AnalysisReply = {
  id: number;
  signature: Float32Array | null;
  analysis: FrameAnalysis | null;
  width: number;
  height: number;
};

// Minimal worker-scope view: the project's tsconfig lib is DOM-only, so the
// DedicatedWorkerGlobalScope type is not available at compile time.
const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage: (message: AnalysisReply) => void;
};
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext("2d", { willReadFrequently: true });

workerSelf.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const { id, bitmap, crop, maxEdge } = event.data;
  const reply: AnalysisReply = {
    id,
    signature: null,
    analysis: null,
    width: 0,
    height: 0,
  };
  try {
    const source: WorkerCrop = crop ?? {
      x: 0,
      y: 0,
      width: bitmap.width,
      height: bitmap.height,
    };
    const shrink = Math.min(1, maxEdge / Math.max(source.width, source.height));
    const width = Math.round(source.width * shrink);
    const height = Math.round(source.height * shrink);
    if (context && width > 0 && height > 0) {
      canvas.width = width;
      canvas.height = height;
      context.drawImage(
        bitmap,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        width,
        height,
      );
      const image = context.getImageData(0, 0, width, height);
      const gray = grayFromRgba(image.data, width, height);
      reply.signature = sceneSignature(gray);
      reply.analysis = analyzeGray(gray);
      reply.width = width;
      reply.height = height;
    }
  } catch {
    /* A broken frame yields a null reply; the caller falls back to the main thread. */
  } finally {
    bitmap.close();
    workerSelf.postMessage(reply);
  }
};
