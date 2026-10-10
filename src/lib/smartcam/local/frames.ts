/**
 * Canvas helpers for on-device recognition. Everything here is deliberately
 * cheap (small canvases, one pass over pixels) because it runs inside the
 * live camera loop on a phone. Grayscale + contrast stretching does more for
 * Tesseract on stamped metal than any fancy filter that would burn frames.
 */

import {
  analyzeGray,
  deskewGeometry,
  type DetectedRegion,
  type FrameAnalysis,
} from "./regions";

export type Gray = { data: Uint8ClampedArray; width: number; height: number };

/** Localize plausible text before OCR and calculate conservative capture guidance. */
export function analyzeFrame(canvas: HTMLCanvasElement): FrameAnalysis | null {
  const gray = toGray(canvas);
  return gray ? analyzeGray(gray) : null;
}

/** Crop content-based bounds, straighten a mild text tilt and retain safe borders. */
export function regionCanvas(
  canvas: HTMLCanvasElement,
  region: DetectedRegion,
  targetWidth = 1080,
): HTMLCanvasElement | null {
  if (
    !canvas.width ||
    !canvas.height ||
    !canvas.getContext("2d", { willReadFrequently: true })
  )
    return null;
  const x = Math.max(0, region.bounds.x),
    y = Math.max(0, region.bounds.y);
  const width = Math.min(canvas.width - x, region.bounds.width),
    height = Math.min(canvas.height - y, region.bounds.height);
  if (width < 4 || height < 4) return null;
  const geometry = deskewGeometry({ x, y, width, height }, region.angleDegrees);
  const border = Math.max(8, region.characterHeight * 0.18);
  const scale = Math.min(
    4,
    targetWidth / (geometry.width + border * 2),
    640 / (geometry.height + border * 2),
    Math.max(1, 48 / region.characterHeight),
  );
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.ceil((geometry.width + border * 2) * scale));
  out.height = Math.max(1, Math.ceil((geometry.height + border * 2) * scale));
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.save();
  ctx.translate(out.width / 2, out.height / 2);
  ctx.scale(scale, scale);
  ctx.rotate(geometry.radians);
  ctx.drawImage(
    canvas,
    x,
    y,
    width,
    height,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  ctx.restore();
  const gray = toGray(out);
  if (gray) stretchInto(gray, ctx, out);
  return out;
}

/** Draw the current video frame (or any canvas/photo) down to a bounded canvas. */
export function sourceCanvas(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  maxEdge = 640,
): HTMLCanvasElement | null {
  const width =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLImageElement
        ? source.naturalWidth
        : source.width;
  const height =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLImageElement
        ? source.naturalHeight
        : source.height;
  if (!width || !height) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function toGray(canvas: HTMLCanvasElement): Gray | null {
  if (!canvas.width || !canvas.height) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < gray.length; i++)
    gray[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { data: gray, width, height };
}

/** Linear stretch between the 2nd/98th percentile luma — fades noise to ends. */
function stretchInto(
  gray: Gray,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
): void {
  const sorted = Uint8Array.from(gray.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
  const hi = sorted[Math.floor(sorted.length * 0.98)] ?? 255;
  const span = Math.max(1, hi - lo);
  const out = ctx.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < gray.data.length; i++) {
    const value = ((gray.data[i] - lo) * 255) / span;
    out.data[i * 4] =
      out.data[i * 4 + 1] =
      out.data[i * 4 + 2] =
        value < 0 ? 0 : value > 255 ? 255 : value;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Crop a horizontal band (default the lower-middle where plates and steering
 * stamps sit), upscale it toward `targetWidth` and grayscale-stretch it — the
 * single-line OCR pass input.
 */
export function bandCanvas(
  canvas: HTMLCanvasElement,
  opts: { top?: number; height?: number; targetWidth?: number } = {},
): HTMLCanvasElement | null {
  const top = opts.top ?? 0.4;
  const bandHeight = opts.height ?? 0.45;
  const targetWidth = opts.targetWidth ?? 880;
  if (!canvas.getContext("2d", { willReadFrequently: true })) return null;
  const sy = Math.max(0, Math.round(canvas.height * top));
  const sh = Math.min(
    canvas.height - sy,
    Math.round(canvas.height * bandHeight),
  );
  if (sh < 8) return null;
  const scale = Math.min(4, Math.max(1, targetWidth / canvas.width));
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(sh * scale);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, out.width, out.height);
  const gray = toGray(out);
  if (gray) stretchInto(gray, ctx, out);
  return out;
}

/** Grayscale-contrast copy of a whole canvas for the sparse-text OCR pass. */
export function preprocessedFull(
  canvas: HTMLCanvasElement,
  targetWidth = 720,
): HTMLCanvasElement | null {
  const scale = Math.min(2, Math.max(1, targetWidth / canvas.width));
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  const gray = toGray(out);
  if (gray) stretchInto(gray, ctx, out);
  return out;
}

/**
 * 8×8 average-luma signature of a frame for motion/scene-change detection.
 * Cheap enough to compute every tick; big deltas mean the user moved on and
 * the candidate vote should not carry over.
 */
export function sceneSignature(gray: Gray): Float32Array {
  const sig = new Float32Array(64);
  const cellW = gray.width / 8;
  const cellH = gray.height / 8;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let sum = 0;
      let count = 0;
      for (
        let y = Math.floor(cy * cellH);
        y < Math.floor((cy + 1) * cellH);
        y++
      )
        for (
          let x = Math.floor(cx * cellW);
          x < Math.floor((cx + 1) * cellW);
          x++
        ) {
          sum += gray.data[y * gray.width + x] ?? 0;
          count++;
        }
      sig[cy * 8 + cx] = count ? sum / count : 0;
    }
  }
  return sig;
}

/** Normalized mean absolute difference between two signatures (0..1). */
export function motionScore(
  prev: Float32Array | null,
  next: Float32Array,
): number {
  if (!prev || prev.length !== next.length) return 1;
  let sum = 0;
  for (let i = 0; i < prev.length; i++) sum += Math.abs(prev[i] - next[i]);
  return Math.min(1, sum / prev.length / 128);
}
