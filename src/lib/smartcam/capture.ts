/**
 * Smart Camera device layer — everything that touches <video>, canvas and
 * WebAudio. Kept separate from `recognition.ts` so the business logic stays
 * pure and testable while these helpers can degrade gracefully on browsers
 * (or tests) without cameras and sound.
 */
import { sourceCanvas } from "./local/frames";

export type CapturedFrame = {
  jpegBase64: string;
  dataUrl: string;
  /** Frame sharpness proxy 0..1 — see `frameSharpness`. */
  clarity: number;
};

/** ai-assist rejects images over 2 MB raw bytes; 1.5 MB keeps base64 < 2 MB budget with margin. */
const MAX_JPEG_BYTES = 1_500_000;
const MAX_EDGE = 1280;
const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.48];

function drawScaled(source: HTMLVideoElement | HTMLImageElement) {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Variance of the Laplacian on a small grayscale copy — the classic sharpness
 * proxy, done at 160 px so it costs well under a millisecond per frame and
 * never drains the phone battery. Blurry or covered frames score low.
 */
export function frameSharpness(canvas: HTMLCanvasElement): number {
  const size = 160;
  const work = document.createElement("canvas");
  work.width = size;
  work.height = size;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(canvas, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const gray = new Float32Array(size * size);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - size] - gray[i + size];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (!count) return 0;
  const variance = sumSq / count - (sum / count) ** 2;
  // 1200 variance on this scale already separates "readable plate" from blur.
  return Math.min(1, variance / 1200);
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Không đọc được ảnh."));
    reader.readAsDataURL(blob);
  });
}

/** Grab the current live frame, scaled and JPEG-bounded for the assist contract. */
export async function captureVideoFrame(video: HTMLVideoElement): Promise<CapturedFrame | null> {
  const canvas = drawScaled(video);
  if (!canvas) return null;
  const clarity = frameSharpness(canvas);
  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToJpeg(canvas, quality);
    if (!blob || blob.size > MAX_JPEG_BYTES) continue;
    const base64 = await blobToBase64(blob);
    return { jpegBase64: base64, dataUrl: `data:image/jpeg;base64,${base64}`, clarity };
  }
  return null;
}

/** Same pipeline for a photo chosen from the gallery (fallback path). */
export async function captureFromFile(file: File): Promise<CapturedFrame | null> {
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Không đọc được ảnh."));
      image.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  const canvas = drawScaled(image);
  URL.revokeObjectURL(url);
  if (!canvas) return null;
  const clarity = frameSharpness(canvas);
  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToJpeg(canvas, quality);
    if (!blob || blob.size > MAX_JPEG_BYTES) continue;
    const base64 = await blobToBase64(blob);
    return { jpegBase64: base64, dataUrl: `data:image/jpeg;base64,${base64}`, clarity };
  }
  return null;
}

/** Turn an approved camera photo back into a File for the storage gateway. */
export async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type || "image/jpeg", lastModified: Date.now() });
}

/** Decode a dataURL (gallery fallback path) into a bounded canvas for local OCR. */
export async function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("bad image"));
      image.src = dataUrl;
    });
  } catch {
    return null;
  }
  return sourceCanvas(image);
}

let audioContext: AudioContext | null = null;

/**
 * Short confirmation tones. WebAudio only — no audio assets, and completely
 * silent when the browser blocks audio (the visual result card is the
 * authoritative feedback anyway).
 */
export function scanTone(pattern: "match" | "new" | "review"): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    const ctx = audioContext;
    void ctx.resume?.();
    const notes = pattern === "match" ? [880, 1320] : pattern === "new" ? [660] : [520, 392];
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.13);
    });
  } catch {
    /* Sound is a convenience, never a requirement. */
  }
}

export type CameraSettings = {
  autoCapture: boolean;
  sound: boolean;
  autoOpen: boolean;
  /** On-device Tesseract OCR — free, offline, no image ever uploaded. */
  localOcr: boolean;
  /** When the paid ai-assist provider may be consulted. */
  cloudMode: "auto" | "manual" | "off";
};

const SETTINGS_KEY = "xe_crm_smartcam_settings";

export function loadCameraSettings(): CameraSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (raw && typeof raw === "object")
      return {
        // Continuous local scanning is the headline mode and costs nothing,
        // so it is on by default; it still only acts on sharp stable frames.
        autoCapture: raw.autoCapture !== false,
        sound: raw.sound !== false,
        // Auto-open and cloud stay opt-in: nothing should navigate away or
        // spend provider credit without the user having asked for it.
        autoOpen: raw.autoOpen === true,
        localOcr: raw.localOcr !== false,
        // Cloud stays manual-by-default until billing controls are verified: the
        // server-side throttle (10/user/10 min) is per-isolate in memory and no
        // persistent org-wide budget exists yet. "auto" must be an explicit choice.
        cloudMode: raw.cloudMode === "auto" || raw.cloudMode === "off" ? raw.cloudMode : "manual",
      };
  } catch {
    /* defaults below */
  }
  return { autoCapture: true, sound: true, autoOpen: false, localOcr: true, cloudMode: "manual" };
}

export function saveCameraSettings(settings: CameraSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* Optional storage. */
  }
}
