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
 * fallback stays available.
 */
import { PSM, createWorker } from "tesseract.js";
import {
  parseFrameCandidates,
  parsePlateCandidates,
  riskyGlyphs,
  uniqueCandidate,
  type Candidate,
} from "./candidates";
import {
  analyzeFrame,
  bandCanvas,
  preprocessedFull,
  regionCanvas,
  sourceCanvas,
} from "./frames";
import type { FrameAnalysis } from "./regions";
import { parseIdentityDocumentText, type IdentityRead } from "./identity";

type OcrWorker = Awaited<ReturnType<typeof createWorker>>;

export type OcrStage = "idle" | "loading" | "ready" | "unavailable";

/** One identifier pass result: raw text plus the engine's own confidence. */
export type OcrPass = {
  text: string;
  confidence: number;
  ms: number;
  glyphs?: { character: string; confidence: number }[];
  /** A focused crop cut through glyphs: this region must not veto the complete photo. */
  clipped?: boolean;
};

/** What the local reader extracted from one frame. */
export type LocalRead = {
  license_plate: string;
  frame_number: string;
  /** Confidence attached to the winning plate (0..100), 0 when none. */
  plateConfidence: number;
  frameConfidence: number;
  /** Zero-based indexes among letters/digits, excluding plate punctuation. */
  warnings: { license_plate: number[]; frame_number: number[] };
  ambiguous: ("license_plate" | "frame_number")[];
  ocrMs: number;
  passes: number;
  /** Analysis of the source frame; regions are pixel-based text hypotheses. */
  analysis?: FrameAnalysis;
};

const WORKER_PATH = "/tesseract/worker.min.js";
const CORE_PATH = "/tesseract/core";
/** Digits, plate letters and stamp separators — nothing else can appear. */
const WHITELIST = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.- ";

let workerPromise: Promise<OcrWorker | null> | null = null;
let recognitionQueue: Promise<void> = Promise.resolve();
let stage: OcrStage = "idle";
const listeners = new Set<(stage: OcrStage) => void>();

function setStage(next: OcrStage): void {
  stage = next;
  for (const listener of listeners) listener(next);
}

export function ocrStage(): OcrStage {
  return stage;
}

export function onOcrStageChange(
  listener: (stage: OcrStage) => void,
): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

async function buildWorker(): Promise<OcrWorker | null> {
  try {
    setStage("loading");
    // OEM 1 = LSTM only; langs 'eng' covers plates and VIN-style stamps
    // (Vietnamese plates are Latin-0-9 only).
    const worker = await createWorker("eng", 1, {
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
    });
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

async function recognizeNow(
  canvas: HTMLCanvasElement,
  mode: "line" | "block" | "sparse",
): Promise<OcrPass | null> {
  if (!(await ensureOcrWorker())) return null;
  const worker = await workerPromise;
  if (!worker) return null;
  const started = performance.now();
  try {
    // Built as a variable so no excess-property checks fight the WASM params.
    const params = {
      tessedit_pageseg_mode:
        mode === "line"
          ? PSM.SINGLE_LINE
          : mode === "block"
            ? PSM.SINGLE_BLOCK
            : PSM.SPARSE_TEXT,
      tessedit_char_whitelist: WHITELIST,
    };
    await worker.setParameters(params);
    const { data } = await worker.recognize(
      canvas,
      {},
      { text: true, blocks: true },
    );
    const glyphs = (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.flatMap((line) =>
          line.words.flatMap((word) =>
            word.symbols.flatMap((symbol) =>
              [...symbol.text.toUpperCase()]
                .filter((character) => /[A-Z0-9]/.test(character))
                .map((character) => ({
                  character,
                  confidence: symbol.confidence,
                })),
            ),
          ),
        ),
      ),
    );
    const clipped =
      mode === "line" &&
      (data.blocks ?? []).some((block) =>
        block.paragraphs.some((paragraph) =>
          paragraph.lines.some((line) =>
            line.words.some((word) =>
              word.symbols.some(
                (symbol) =>
                  /[A-Z0-9]/i.test(symbol.text) &&
                  (symbol.bbox.y0 <= 1 || symbol.bbox.y1 >= canvas.height - 1),
              ),
            ),
          ),
        ),
      );
    return {
      text: data.text ?? "",
      confidence: data.confidence ?? 0,
      ms: Math.round(performance.now() - started),
      glyphs,
      clipped,
    };
  } catch {
    return null;
  }
}

/** A mode switch/upload must not change shared worker parameters mid-read. */
function recognize(
  canvas: HTMLCanvasElement,
  mode: "line" | "block" | "sparse",
): Promise<OcrPass | null> {
  const result = recognitionQueue.then(() => recognizeNow(canvas, mode));
  recognitionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Free the WASM heap (call when the camera screen unmounts for good). */
export function releaseOcrWorker(): void {
  const pending = workerPromise;
  workerPromise = null;
  stage = "idle";
  void pending?.then((worker) => worker?.terminate());
}

/**
 * Associate symbol confidence with a candidate rather than background text.
 */
function withSymbolRisks(candidate: Candidate, pass: OcrPass): Candidate {
  if (!pass.glyphs?.length || !candidate.rawValue) return candidate;
  const start = pass.glyphs
    .map((glyph) => glyph.character)
    .join("")
    .indexOf(candidate.rawValue);
  if (start < 0) return candidate;
  const glyphs = pass.glyphs.slice(start, start + candidate.rawValue.length);
  const value = candidate.value.replace(/[^A-Z0-9]/g, "");
  const corrected = [...candidate.rawValue].flatMap((character, index) =>
    character !== value[index] ? [index] : [],
  );
  const confidence =
    glyphs.reduce((sum, glyph) => sum + glyph.confidence, 0) / glyphs.length;
  return {
    ...candidate,
    confidence:
      confidence *
      (corrected.length ? Math.max(0.65, 1 - corrected.length * 0.08) : 1),
    uncertainCharacters: [
      ...new Set([
        ...corrected,
        ...riskyGlyphs(value, confidence),
        ...glyphs.flatMap((glyph, index) =>
          glyph.confidence < 68 ? [index] : [],
        ),
      ]),
    ],
  };
}

/** Merge every region before selecting, so a second plate in a photo is not ignored. */
export function chooseIdentifierRead(
  passes: OcrPass[],
  target: "plate" | "frame" | "both" = "both",
): LocalRead {
  const complete = passes.filter((pass) => !pass.clipped);
  const plates =
    target === "frame"
      ? []
      : complete.flatMap((pass) =>
          parsePlateCandidates(pass.text, pass.confidence).map((candidate) =>
            withSymbolRisks(candidate, pass),
          ),
        );
  const frames =
    target === "plate"
      ? []
      : complete.flatMap((pass) =>
          parseFrameCandidates(pass.text, pass.confidence).map((candidate) =>
            withSymbolRisks(candidate, pass),
          ),
        );
  const plate = uniqueCandidate(plates);
  const frame = uniqueCandidate(frames);
  return {
    license_plate: plate?.value ?? "",
    frame_number: frame?.value ?? "",
    plateConfidence: plate?.confidence ?? 0,
    frameConfidence: frame?.confidence ?? 0,
    warnings: {
      license_plate: plate?.uncertainCharacters ?? [],
      frame_number: frame?.uncertainCharacters ?? [],
    },
    ambiguous: [
      ...(new Set(plates.map((candidate) => candidate.value)).size > 1
        ? ["license_plate" as const]
        : []),
      ...(new Set(frames.map((candidate) => candidate.value)).size > 1
        ? ["frame_number" as const]
        : []),
    ],
    ocrMs: passes.reduce((sum, pass) => sum + pass.ms, 0),
    passes: passes.length,
  };
}

/** Read the viewfinder crop or full uploaded photo, checking both focused and wider regions. */
export async function localReadFrame(
  source: HTMLVideoElement | HTMLCanvasElement,
  options: {
    target?: "plate" | "frame" | "both";
    analysis?: FrameAnalysis | null;
  } = {},
): Promise<LocalRead | null> {
  const full =
    source instanceof HTMLCanvasElement ? source : sourceCanvas(source);
  if (!full) return null;
  const started = performance.now();
  const passes: OcrPass[] = [];
  const analysis =
    options.analysis?.width === full.width &&
    options.analysis.height === full.height
      ? options.analysis
      : analyzeFrame(full);
  const regions = analysis?.regions.slice(0, 2) ?? [];
  for (const region of regions) {
    const crop = regionCanvas(full, region);
    const pass = crop
      ? await recognize(crop, region.kind === "block" ? "block" : "line")
      : null;
    if (pass) passes.push(pass);
  }
  if (!regions.length) {
    const band = bandCanvas(full);
    const linePass = band ? await recognize(band, "line") : null;
    if (linePass) passes.push(linePass);
  }
  // Always inspect the full photo too. A crop must never hide a conflicting
  // second plate/frame elsewhere, or prevent reading text the locator missed.
  const widened = preprocessedFull(full, 1080);
  const sparsePass = widened ? await recognize(widened, "sparse") : null;
  if (sparsePass) passes.push(sparsePass);
  return passes.length
    ? {
        ...chooseIdentifierRead(passes, options.target),
        ocrMs: Math.round(performance.now() - started),
        ...(analysis ? { analysis } : {}),
      }
    : null;
}

/** Read identity-card text at higher resolution; QR decoding is handled separately. */
export async function localReadIdentity(
  source: HTMLVideoElement | HTMLCanvasElement,
): Promise<IdentityRead | null> {
  const full =
    source instanceof HTMLCanvasElement ? source : sourceCanvas(source, 1080);
  if (!full) return null;
  const started = performance.now();
  const canvas = preprocessedFull(full, 1280);
  const pass = canvas ? await recognize(canvas, "sparse") : null;
  if (!pass) return null;
  const read = parseIdentityDocumentText(pass.text, pass.confidence);
  if (!read) return null;
  const enriched = withSymbolRisks(
    {
      value: read.document_number,
      rawValue: read.document_number,
      confidence: read.confidence,
      uncertainCharacters: read.uncertainCharacters,
    },
    pass,
  );
  return {
    document_number: read.document_number,
    confidence: enriched.confidence,
    uncertainCharacters: enriched.uncertainCharacters ?? [],
    ocrMs: Math.round(performance.now() - started),
  };
}
