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

function drawScaled(
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
) {
  const width =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source instanceof HTMLCanvasElement
        ? source.width
        : source.naturalWidth;
  const height =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source instanceof HTMLCanvasElement
        ? source.height
        : source.naturalHeight;
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
    gray[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const lap =
        4 * gray[i] -
        gray[i - 1] -
        gray[i + 1] -
        gray[i - size] -
        gray[i + size];
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

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality),
  );
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
export async function captureVideoFrame(
  video: HTMLVideoElement | HTMLCanvasElement,
): Promise<CapturedFrame | null> {
  const canvas = drawScaled(video);
  if (!canvas) return null;
  const clarity = frameSharpness(canvas);
  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToJpeg(canvas, quality);
    if (!blob || blob.size > MAX_JPEG_BYTES) continue;
    const base64 = await blobToBase64(blob);
    return {
      jpegBase64: base64,
      dataUrl: `data:image/jpeg;base64,${base64}`,
      clarity,
    };
  }
  return null;
}

/** Same pipeline for a photo chosen from the gallery (fallback path). */
export async function captureFromFile(
  file: File,
): Promise<CapturedFrame | null> {
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
    return {
      jpegBase64: base64,
      dataUrl: `data:image/jpeg;base64,${base64}`,
      clarity,
    };
  }
  return null;
}

/** Turn an approved camera photo back into a File for the storage gateway. */
export async function dataUrlToFile(
  dataUrl: string,
  name: string,
): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, {
    type: blob.type || "image/jpeg",
    lastModified: Date.now(),
  });
}

/** Decode a dataURL (gallery fallback path) into a bounded canvas for local OCR. */
export async function dataUrlToCanvas(
  dataUrl: string,
): Promise<HTMLCanvasElement | null> {
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
  return sourceCanvas(image, 1280);
}

let audioContext: AudioContext | null = null;

/** Called during the camera/upload gesture so completion tones can play later. */
export function prepareScanAudio(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Ctor) {
      audioContext ??= new Ctor();
      void audioContext.resume();
    }
  } catch {
    /* Visual results remain available when sound is blocked. */
  }
}

/** Map the visible guide through object-fit: cover before cropping the camera. */
export function viewfinderCanvas(
  video: HTMLVideoElement,
): HTMLCanvasElement | null {
  return cameraViewportCanvas(video, true);
}

/** Identifiers may appear anywhere in the visible preview, outside its guide. */
export function visibleCameraCanvas(
  video: HTMLVideoElement,
): HTMLCanvasElement | null {
  return cameraViewportCanvas(video, false);
}

export function cameraViewportBounds(
  width: number,
  height: number,
  clientWidth: number,
  clientHeight: number,
  guide: boolean,
) {
  if (
    ![width, height, clientWidth, clientHeight].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return null;
  const scale = Math.max(clientWidth / width, clientHeight / height);
  const visibleWidth = clientWidth / scale;
  const visibleHeight = clientHeight / scale;
  return {
    x: (width - visibleWidth) / 2 + (guide ? visibleWidth * 0.1 : 0),
    y: (height - visibleHeight) / 2 + (guide ? visibleHeight * 0.22 : 0),
    width: visibleWidth * (guide ? 0.8 : 1),
    height: visibleHeight * (guide ? 0.58 : 1),
  };
}

function cameraViewportCanvas(
  video: HTMLVideoElement,
  guide: boolean,
): HTMLCanvasElement | null {
  const {
    videoWidth: width,
    videoHeight: height,
    clientWidth,
    clientHeight,
  } = video;
  if (!width || !height || !clientWidth || !clientHeight)
    return sourceCanvas(video, 1280);
  const bounds = cameraViewportBounds(
    width,
    height,
    clientWidth,
    clientHeight,
    guide,
  );
  if (!bounds) return null;
  const { x: sx, y: sy, width: sw, height: sh } = bounds;
  const canvas = document.createElement("canvas");
  const shrink = Math.min(1, 1280 / Math.max(sw, sh));
  canvas.width = Math.round(sw * shrink);
  canvas.height = Math.round(sh * shrink);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Short confirmation tones. WebAudio only — no audio assets, and completely
 * silent when the browser blocks audio (the visual result card is the
 * authoritative feedback anyway).
 */
export function scanTone(pattern: "match" | "new" | "review"): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    const ctx = audioContext;
    void ctx.resume?.();
    const notes =
      pattern === "match"
        ? [880, 1320]
        : pattern === "new"
          ? [660]
          : [520, 392];
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "square";
      oscillator.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.45, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.2);
    });
  } catch {
    /* Sound is a convenience, never a requirement. */
  }
}

/**
 * Device-control helpers (torch + lens choice). Pure over capability-shaped
 * inputs so they are unit-testable without a real camera. Phones differ in
 * ways that used to break the flash button: `torch` can be a boolean sequence,
 * a boolean, or a numeric range, Chrome resets torch on its own
 * (the UI must re-sync from track settings, never from a remembered click),
 * and device labels are blank before permission — so the camera flip is
 * planned by facing mode and can always fall back to `{facingMode}`
 * constraints even when enumeration returns unusable ids.
 */
export type TorchMode = "boolean" | "number" | "none";

export type NextCameraPlan =
  { facing: "environment" | "user" } | { deviceId: string } | null;

/** Which torch constraint shape the active track actually accepts. */
export function torchMode(caps: unknown): TorchMode {
  const torch = (caps as { torch?: unknown } | null | undefined)?.torch;
  if (torch === true) return "boolean";
  // Image Capture defines torch capabilities as a sequence of supported states.
  if (Array.isArray(torch)) return torch.includes(true) ? "boolean" : "none";
  if (typeof torch === "object" && torch !== null) {
    const range = torch as { min?: unknown; max?: unknown };
    if (
      typeof range.min === "number" &&
      typeof range.max === "number" &&
      range.max > 0
    )
      return "number";
  }
  return "none";
}

/** Read the REAL torch state off the track — the only truth after driver resets. */
export function torchStateFromSettings(track: {
  getSettings(): { torch?: unknown };
}): boolean {
  const torch = track.getSettings().torch;
  if (typeof torch === "number") return torch > 0;
  return torch === true;
}

export async function applyTorch(
  track: { applyConstraints(c: MediaTrackConstraints): Promise<void> },
  mode: TorchMode,
  on: boolean,
): Promise<void> {
  const torch = mode === "number" ? (on ? 1 : 0) : on;
  await track.applyConstraints({
    advanced: [{ torch } as unknown as MediaTrackConstraintSet],
  });
}

export type ZoomCapability = {
  min: number;
  max: number;
  step: number;
};

/** Detect optical or hardware digital zoom capability reported by track capabilities. */
export function zoomCapability(caps: unknown): ZoomCapability | null {
  const zoom = (caps as { zoom?: unknown } | null | undefined)?.zoom;
  if (
    zoom &&
    typeof zoom === "object" &&
    "min" in zoom &&
    "max" in zoom &&
    typeof (zoom as { min: unknown }).min === "number" &&
    typeof (zoom as { max: unknown }).max === "number"
  ) {
    const min = (zoom as { min: number }).min;
    const max = (zoom as { max: number }).max;
    const step =
      typeof (zoom as { step?: unknown }).step === "number"
        ? (zoom as unknown as { step: number }).step
        : 0.1;
    if (max > min) return { min, max, step };
  }
  return null;
}

/** Read current zoom level from track settings, defaulting to 1x. */
export function currentZoomLevel(track: {
  getSettings(): { zoom?: unknown };
}): number {
  const zoom = track.getSettings().zoom;
  return typeof zoom === "number" && zoom >= 1 ? zoom : 1;
}

/** Apply target zoom level to track constraints. */
export async function applyZoom(
  track: { applyConstraints(c: MediaTrackConstraints): Promise<void> },
  zoom: number,
): Promise<void> {
  await track.applyConstraints({
    advanced: [{ zoom } as unknown as MediaTrackConstraintSet],
  });
}

/** Detect if continuous focus mode is supported. */
export function supportsContinuousFocus(caps: unknown): boolean {
  const focusMode = (caps as { focusMode?: unknown } | null | undefined)
    ?.focusMode;
  if (Array.isArray(focusMode)) {
    return focusMode.includes("continuous");
  }
  return false;
}

/** Request continuous focus, optionally targeting a tapped coordinate point. */
export async function applyContinuousFocus(
  track: { applyConstraints(c: MediaTrackConstraints): Promise<void> },
  point?: { x: number; y: number },
): Promise<void> {
  const constraint: Record<string, unknown> = { focusMode: "continuous" };
  if (point) {
    constraint.pointsOfInterest = [{ x: point.x, y: point.y }];
  }
  await track.applyConstraints({
    advanced: [constraint as unknown as MediaTrackConstraintSet],
  });
}


/**
 * Decide which lens the flip button should open next. With a real camera list
 * it toggles rear ↔ front; several rear lenses cycle with a "+1" hint on the
 * label. Incomplete enumeration or unidentified lenses use facing mode so the
 * browser can select the other camera rather than reopen the current device.
 */
export function nextCameraPlan(
  cameras: { deviceId: string; label: string }[],
  activeDeviceId: string,
  activeFacing: "environment" | "user",
): NextCameraPlan {
  const fallback = {
    facing:
      activeFacing === "environment"
        ? ("user" as const)
        : ("environment" as const),
  };
  const available = cameras.filter(
    (camera, index) =>
      camera.deviceId &&
      cameras.findIndex(
        (candidate) => candidate.deviceId === camera.deviceId,
      ) === index,
  );
  const current = available.find(
    (camera) => camera.deviceId === activeDeviceId,
  );
  if (available.length < 2 || !current) return fallback;
  const isRear = (label: string) => /back|rear|environment/i.test(label);
  const isFront = (label: string) => /front|user|facetime/i.test(label);
  if (!isRear(current.label) && !isFront(current.label)) return fallback;
  const alternatives = available.filter(
    (camera) => camera.deviceId !== activeDeviceId,
  );
  const opposite = alternatives.find((camera) =>
    activeFacing === "user" ? isRear(camera.label) : isFront(camera.label),
  );
  if (opposite) return { deviceId: opposite.deviceId };
  // Preserve cycling for phones exposing several explicitly labelled rear lenses.
  if (activeFacing === "environment" && isRear(current.label)) {
    const currentIndex = available.indexOf(current);
    const ordered = [
      ...available.slice(currentIndex + 1),
      ...available.slice(0, currentIndex),
    ];
    const nextRear = ordered.find((camera) => isRear(camera.label));
    if (nextRear) return { deviceId: nextRear.deviceId };
  }
  return fallback;
}

/** Text for the flip button — always states which lens you are switching TO. */
export function cameraFlipLabel(activeFacing: "environment" | "user"): string {
  return activeFacing === "user" ? "Camera sau" : "Camera trước";
}

export type CaptureMode = "scan" | "photo" | "qr" | "identity";

export type CameraSettings = {
  /** Photo uses a shutter; the other three modes scan automatically. */
  mode: CaptureMode;
  sound: boolean;
  autoOpen: boolean;
  /** On-device Tesseract OCR — free, offline, no image ever uploaded. */
  localOcr: boolean;
  /** When the paid ai-assist provider may be consulted. */
  cloudMode: "auto" | "off";
};

const SETTINGS_KEY = "xe_crm_smartcam_settings";

export function loadCameraSettings(): CameraSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null");
    if (raw && typeof raw === "object")
      return {
        // Migrate old opt-out flags: reading, sound and opening verified
        // matches are now built-in; AI remains the only optional setting.
        mode: ["photo", "qr", "identity"].includes(raw.mode)
          ? raw.mode
          : "scan",
        sound: true,
        autoOpen: true,
        localOcr: true,
        // A former manual AI preference does not authorize automatic uploads.
        cloudMode: raw.cloudMode === "auto" ? "auto" : "off",
      };
  } catch {
    /* defaults below */
  }
  return {
    mode: "scan",
    sound: true,
    autoOpen: true,
    localOcr: true,
    cloudMode: "off",
  };
}

export function saveCameraSettings(settings: CameraSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* Optional storage. */
  }
}
