/**
 * On-device OCR via Tesseract WASM — no image ever leaves the browser here.
 * The worker script and the WASM core are served from /tesseract/ (copied out
 * of node_modules by scripts/prepare-ocr-assets.mjs, git-ignored, regenerated
 * on dev/build). Only the ~2 MB English traineddata is fetched from the
 * jsDelivr CDN on first use and then kept in the browser/service-worker
 * cache; recognition itself is entirely local.
 *
 * The worker lives off the main thread, so the camera UI never freezes while
 * a frame is read. A failed load degrades to "unavailable" once per page
 * lifetime — the loop stops hammering a broken download, and the cloud
 * fallback or manual entry stay available.
 */
import { PSM, createWorker } from "tesseract.js";
import { candidatesFromOcr, bestCandidate, parsePlateCandidates } from "./candidates";
import { bandCanvas, preprocessedFull, sourceCanvas } from "./frames";

type OcrWorker = Awaited<ReturnType<typeof createWorker>>;

export type OcrStage = "idle" | "loading" | "ready" | "unavailable";

/** One identifier pass result: raw text plus the engine's own confidence. */
export type OcrPass = { text: string; confidence: number; ms: number };

/** What the local reader extracted from one frame. */
export type LocalRead = {
  license_plate: string;
  frame_number: string;
  /** Confidence attached to the winning plate (0..100), 0 when none. */
  plateConfidence: number;
  ocrMs: number;
  passes: number;
};

const WORKER_PATH = "/tesseract/worker.min.js";
const CORE_PATH = "/tesseract/core";
/** Digits, plate letters and stamp separators — nothing else can appear. */
const WHITELIST = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.- ";

let workerPromise: Promise<OcrWorker | null> | null = null;
let stage: OcrStage = "idle";
const listeners = new Set<(stage: OcrStage) => void>();

function setStage(next: OcrStage): void {
  stage = next;
  for (const listener of listeners) listener(next);
}

export function ocrStage(): OcrStage {
  return stage;
}

export function onOcrStageChange(listener: (stage: OcrStage) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

async function buildWorker(): Promise<OcrWorker | null> {
  try {
    setStage("loading");
    // OEM 1 = LSTM only; langs 'eng' covers plates and VIN-style stamps
    // (Vietnamese plates are Latin-0-9 only).
    const worker = await createWorker("eng", 1, { workerPath: WORKER_PATH, corePath: CORE_PATH });
    setStage("ready");
    return worker;
  } catch {
    setStage("unavailable");
    return null;
  }
}

/** Ensure the shared worker exists; false = local OCR unavailable this session. */
export async function ensureOcrWorker(): Promise<boolean> {
  if (!workerPromise) workerPromise = buildWorker();
  const worker = await workerPromise;
  if (worker && stage !== "ready") setStage("ready");
  return !!worker;
}

async function recognize(canvas: HTMLCanvasElement, mode: "line" | "sparse"): Promise<OcrPass | null> {
  if (!(await ensureOcrWorker())) return null;
  const worker = await workerPromise;
  if (!worker) return null;
  const started = performance.now();
  try {
    // Built as a variable so no excess-property checks fight the WASM params.
    const params = {
      tessedit_pageseg_mode: mode === "line" ? PSM.SINGLE_LINE : PSM.SPARSE_TEXT,
      tessedit_char_whitelist: WHITELIST,
    };
    await worker.setParameters(params);
    const { data } = await worker.recognize(canvas);
    return { text: data.text ?? "", confidence: data.confidence ?? 0, ms: Math.round(performance.now() - started) };
  } catch {
    return null;
  }
}

/** Free the WASM heap (call when the camera screen unmounts for good). */
export function releaseOcrWorker(): void {
  const pending = workerPromise;
  workerPromise = null;
  stage = "idle";
  void pending?.then((worker) => worker?.terminate());
}

/**
 * Read one live frame locally: an upscaled center band gets the fast
 * single-line pass (plates, steering-neck stamps); only when that yields no
 * plausible plate does the wider sparse-text pass run, keeping per-tick cost
 * bounded on a phone.
 */
export async function localReadFrame(source: HTMLVideoElement | HTMLCanvasElement): Promise<LocalRead | null> {
  const full = source instanceof HTMLCanvasElement ? source : sourceCanvas(source);
  if (!full) return null;
  const empty: LocalRead = { license_plate: "", frame_number: "", plateConfidence: 0, ocrMs: 0, passes: 0 };
  const started = performance.now();
  let best = empty;
  const band = bandCanvas(full);
  const linePass = band ? await recognize(band, "line") : null;
  if (linePass) {
    const parsed = candidatesFromOcr(linePass.text, linePass.confidence);
    const plate = bestCandidate(parsePlateCandidates(linePass.text, linePass.confidence));
    best = { ...parsed, plateConfidence: plate?.confidence ?? 0, ocrMs: Math.round(performance.now() - started), passes: 1 };
  }
  if (!best.license_plate) {
    const widened = preprocessedFull(full);
    const sparsePass = widened ? await recognize(widened, "sparse") : null;
    if (sparsePass) {
      const parsed = candidatesFromOcr(sparsePass.text, sparsePass.confidence);
      const plate = parsed.license_plate
        ? bestCandidate(parsePlateCandidates(sparsePass.text, sparsePass.confidence))
        : null;
      best = {
        license_plate: parsed.license_plate,
        // Keep the band-pass frame number when both found something: the band
        // is the closer, higher-resolution read.
        frame_number: best.frame_number || parsed.frame_number,
        plateConfidence: plate?.confidence ?? 0,
        ocrMs: Math.round(performance.now() - started),
        passes: best.passes + 1,
      };
    }
  }
  return best.passes ? best : null;
}
