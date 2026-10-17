/**
 * Pure parsing of raw OCR text into candidate identifiers. No canvas, no
 * worker, no network — this is the layer unit tests exercise against the
 * character confusions a real Vietnamese plate/frame stamp produces
 * (O/0, I/1, S/5, dots and dashes eaten or invented by the engine).
 *
 * The old implementation folded confusable glyphs in one direction and kept
 * the result at full confidence. Folding now happens in `decoder.ts`, where
 * every reading is a competing hypothesis scored against `grammar.ts`; this
 * module only finds the lexical windows and carries the ranking through.
 */
import { isValidMotorbikePlate, normalizePlate } from "@/lib/plate";
import { DIGIT_LIKE_GLYPHS, FRAME_WMI } from "./grammar";
import {
  autoLockEligible,
  decodeFrame,
  decodePlateRun,
  type Glyph,
} from "./decoder";

/** Risk indexes count letters/digits only, matching the cloud OCR contract. */
export type Candidate = {
  value: string;
  confidence: number;
  uncertainCharacters?: number[];
  /** Original compact glyphs, for associating Tesseract symbol confidence. */
  rawValue?: string;
  /** Weight share of the winning reading, 0..100 (a tie is 50). */
  margin?: number;
  /** Runner-up readings, best first — what the CONFIRM strip offers. */
  alternatives?: string[];
  /** Grammar says this needs no human check (see `autoLockEligible`). */
  autoEligible?: boolean;
};

const CONFUSABLE = /[OQILSBZ012568]/;

export function riskyGlyphs(value: string, confidence: number): number[] {
  const compact = value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return [...compact].flatMap((character, index) => confidence < 55 || (confidence < 78 && CONFUSABLE.test(character)) ? [index] : []);
}

/**
 * License-plate candidates from free text, e.g. "59B1-234.56", "59B123456",
 * "59-B1-234.56". Returns canonical forms only (isValidMotorbikePlate gates).
 * `glyphs` is the Tesseract symbol stream when the caller has one, so a single
 * unclear character discounts its own position instead of the whole read.
 */
export function parsePlateCandidates(
  text: string,
  confidence: number,
  glyphs?: readonly Glyph[],
): Candidate[] {
  const upper = text.toUpperCase();
  const digit = `[${DIGIT_LIKE_GLYPHS}]`;
  const pattern = new RegExp(
    `(?<![A-Z0-9])(${digit}{2})[\\s\\-._]*([A-Z]{1,2}?)[\\s\\-._]*(${digit})[\\s\\-._]*(${digit}{2,3})[\\s\\-._]*(${digit}{2})(?![A-Z0-9])`,
    "g",
  );
  const found = new Map<string, Candidate>();
  for (const match of upper.matchAll(pattern)) {
    const decoded = decodePlateRun(match[0], confidence, glyphs);
    const top = decoded.top;
    // Only a reading the app's own validator canonicalizes, and only the
    // winner: a contested decode stays a candidate but never an auto-lock.
    if (!top || !normalizePlate(top.compact) || !isValidMotorbikePlate(top.value))
      continue;
    const candidate: Candidate = {
      value: top.value,
      confidence: top.confidence,
      uncertainCharacters: [
        ...new Set([...top.disputed, ...riskyGlyphs(top.value, confidence)]),
      ],
      rawValue: top.compact,
      margin: decoded.margin,
      alternatives: decoded.alternatives.map((item) => item.value),
      autoEligible: autoLockEligible(decoded),
    };
    const previous = found.get(candidate.value);
    if (!previous || previous.confidence < candidate.confidence)
      found.set(candidate.value, candidate);
  }
  return [...found.values()];
}

function foldText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "D").toUpperCase();
}

const FRAME_LABEL = /(?:SO\s*KHUNG|KHUNG|CHASSIS|FRAME(?:\s*NO)?|VIN)\s*[:#=.-]?\s*$/;

/** Accept whole stamped tokens; never slide a window through joined page text. */
export function parseFrameCandidates(text: string, confidence: number): Candidate[] {
  const upper = foldText(text);
  const found = new Map<string, Candidate>();
  const pattern = /(?<![A-Z0-9])[A-Z0-9](?:[A-Z0-9.*-]{9,24})[A-Z0-9](?![A-Z0-9])/g;
  const add = (raw: string, labelled: boolean) => {
    const observed = raw.replace(/[^A-Z0-9]/g, "");
    if (observed.length < 11 || observed.length > 18) return;
    if ((observed.match(/\d/g) ?? []).length < 4 || (observed.match(/[A-Z]/g) ?? []).length < 2) return;
    if (parsePlateCandidates(observed, confidence).length) return;
    if (!labelled && !FRAME_WMI.test(observed) && !/^[A-Z0-9]{2,4}\d/.test(observed)) return;
    if (!labelled && !FRAME_WMI.test(observed) && /[A-Z]{4,}/.test(observed)) return;
    if (/^(?:TEL|PHONE|HOTLINE|DATE|MODEL|HONDA|YAMAHA|SUZUKI|PARKING|BIENSO)/.test(observed)) return;
    // ISO 3779 bans I, O and Q in a chassis code, so seeing one is proof of a
    // misread; the digit reading is the only legal hypothesis and the position
    // stays flagged for the human either way.
    const read = decodeFrame(observed);
    if (!read) return;
    const folds = read.disputed.length;
    const value = read.compact;
    const candidate: Candidate = {
      value,
      confidence:
        confidence * (folds ? Math.max(0.65, 1 - folds * 0.08) : 1) *
        (read.verdict.valid ? 1 : 0.94),
      uncertainCharacters: [...new Set([...read.disputed, ...riskyGlyphs(value, confidence)])],
      rawValue: value,
      margin: read.autoEligible ? 100 : 0,
      alternatives: [],
      autoEligible: read.autoEligible,
    };
    const previous = found.get(value);
    if (!previous || previous.confidence < candidate.confidence) found.set(value, candidate);
  };
  for (const match of upper.matchAll(pattern)) {
    const preceding = upper.slice(Math.max(0, match.index! - 30), match.index);
    add(match[0], FRAME_LABEL.test(preceding));
  }
  // OCR spaces inside a stamp are accepted only after a chassis label.
  const labelled = /(?:SO\s*KHUNG|KHUNG|CHASSIS|FRAME(?:\s*NO)?|VIN)\s*[:#=.-]?\s*([^\r\n:]{11,45})/g;
  for (const match of upper.matchAll(labelled)) {
    const groups = match[1].trim().split(/\s+/);
    if (groups[0].replace(/[^A-Z0-9]/g, "").length >= 11) continue;
    let raw = "";
    for (const group of groups) {
      if (!/^[A-Z0-9.*-]+$/.test(group) || /^[A-Z]{4,}$/.test(group)) break;
      raw += group;
    }
    add(raw, true);
  }
  // A real metal stamp has no printed "số khung" label. A known maker prefix
  // at the beginning of an OCR line also provides enough context to join
  // spaces the reader inserted, while unrelated page words remain separate.
  for (const line of upper.split(/[\r\n]+/)) {
    const groups = line.trim().split(/\s+/);
    if (groups.length < 2 || !FRAME_WMI.test(groups[0]) || groups[0].length > 6) continue;
    if (groups.some((group) => !/^[A-Z0-9.*-]+$/.test(group) || /^[A-Z]{4,}$/.test(group))) continue;
    add(groups.join(""), true);
  }
  return [...found.values()];
}

/** Pick the highest-confidence candidate; ties prefer the first seen. */
export function bestCandidate(candidates: Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates)
    if (!best || candidate.confidence > best.confidence) best = candidate;
  return best;
}

/**
 * Competing identifiers require another focused scan, never first-hit
 * selection. When every pass agrees, the tier signals are merged
 * *conservatively*: one pass that had to substitute a glyph, or that found a
 * rival reading, is enough to send the whole field to a human.
 */
export function uniqueCandidate(candidates: Candidate[]): Candidate | null {
  const values = new Set(candidates.map((candidate) => candidate.value));
  const best = values.size === 1 ? bestCandidate(candidates) : null;
  if (!best) return null;
  return {
    ...best,
    margin: Math.min(...candidates.map((candidate) => candidate.margin ?? 0)),
    autoEligible: candidates.every((candidate) => !!candidate.autoEligible),
    uncertainCharacters: [
      ...new Set(candidates.flatMap((candidate) => candidate.uncertainCharacters ?? [])),
    ].sort((a, b) => a - b),
    alternatives: [
      ...new Set(candidates.flatMap((candidate) => candidate.alternatives ?? [])),
    ],
  };
}

/**
 * Raw OCR output → the field draft `normalizeScan` understands.
 * Bộ đọc tại máy chỉ còn biển số + số khung: cột `engine_number` đã bị xoá
 * vĩnh viễn nên đọc ra cũng không có chỗ lưu.
 */
export function candidatesFromOcr(text: string, confidence: number): {
  license_plate: string;
  frame_number: string;
} {
  return {
    license_plate: uniqueCandidate(parsePlateCandidates(text, confidence))?.value ?? "",
    frame_number: uniqueCandidate(parseFrameCandidates(text, confidence))?.value ?? "",
  };
}
