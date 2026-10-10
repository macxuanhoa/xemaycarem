/**
 * Pure parsing of raw OCR text into candidate identifiers. No canvas, no
 * worker, no network — this is the layer unit tests exercise against the
 * character confusions a real Vietnamese plate/frame stamp produces
 * (O/0, I/1, S/5, dots and dashes eaten or invented by the engine).
 */
import { isValidMotorbikePlate, normalizePlate } from "@/lib/plate";

/** Risk indexes count letters/digits only, matching the cloud OCR contract. */
export type Candidate = {
  value: string;
  confidence: number;
  uncertainCharacters?: number[];
  /** Original compact glyphs, for associating Tesseract symbol confidence. */
  rawValue?: string;
};

const DIGIT_GLYPHS: Record<string, string> = { O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };
const CONFUSABLE = /[OQILSBZ012568]/;

export function riskyGlyphs(value: string, confidence: number): number[] {
  const compact = value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return [...compact].flatMap((character, index) => confidence < 55 || (confidence < 78 && CONFUSABLE.test(character)) ? [index] : []);
}

function digits(raw: string): { value: string; risks: number[] } | null {
  let value = "";
  const risks: number[] = [];
  for (const [index, character] of [...raw].entries()) {
    if (/\d/.test(character)) value += character;
    else if (DIGIT_GLYPHS[character]) {
      value += DIGIT_GLYPHS[character];
      risks.push(index);
    } else return null;
  }
  return { value, risks };
}

/**
 * License-plate candidates from free text, e.g. "59B1-234.56", "59B123456",
 * "59-B1-234.56". Returns canonical forms only (isValidMotorbikePlate gates).
 */
export function parsePlateCandidates(text: string, confidence: number): Candidate[] {
  const upper = text.toUpperCase();
  const pattern = /(?<![A-Z0-9])([0-9OQILSBZ]{2})[\s\-._]*([A-Z]{1,2}?)[\s\-._]*([0-9OQILSBZ])[\s\-._]*([0-9OQILSBZ]{2,3})[\s\-._]*([0-9OQILSBZ]{2})(?![A-Z0-9])/g;
  const found = new Map<string, Candidate>();
  for (const match of upper.matchAll(pattern)) {
    const province = digits(match[1]);
    const series = digits(match[3]);
    const serial = digits(match[4] + match[5]);
    if (!province || !series || !serial || Number(province.value) < 11 || Number(province.value) > 99) continue;
    const prefix = province.value + match[2];
    const canonical = normalizePlate(prefix + series.value + serial.value);
    if (!canonical || !isValidMotorbikePlate(canonical)) continue;
    const corrected = [...province.risks, ...series.risks.map((index) => prefix.length + index), ...serial.risks.map((index) => prefix.length + 1 + index)];
    const score = confidence * (corrected.length ? Math.max(0.65, 1 - corrected.length * 0.08) : 1);
    const candidate: Candidate = {
      value: canonical,
      confidence: score,
      uncertainCharacters: [...new Set([...corrected, ...riskyGlyphs(canonical, confidence)])],
      rawValue: match[0].replace(/[^A-Z0-9]/g, ""),
    };
    const previous = found.get(canonical);
    if (!previous || previous.confidence < score) found.set(canonical, candidate);
  }
  return [...found.values()];
}

function foldText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "D").toUpperCase();
}

const FRAME_LABEL = /(?:SO\s*KHUNG|KHUNG|CHASSIS|FRAME(?:\s*NO)?|VIN)\s*[:#=.-]?\s*$/;
const KNOWN_FRAME_PREFIX = /^(?:RL[ACHMST]|JH2|JYA|JKA|JS1|KM4|MLH|ME1|LC2|LBB|LAL|ZD4)/;

/** Accept whole stamped tokens; never slide a window through joined page text. */
export function parseFrameCandidates(text: string, confidence: number): Candidate[] {
  const upper = foldText(text);
  const found = new Map<string, Candidate>();
  const pattern = /(?<![A-Z0-9])[A-Z0-9](?:[A-Z0-9.*-]{9,24})[A-Z0-9](?![A-Z0-9])/g;
  const add = (raw: string, labelled: boolean) => {
    const value = raw.replace(/[^A-Z0-9]/g, "");
    if (value.length < 11 || value.length > 18) return;
    if ((value.match(/\d/g) ?? []).length < 4 || (value.match(/[A-Z]/g) ?? []).length < 2) return;
    if (parsePlateCandidates(value, confidence).length) return;
    if (!labelled && !KNOWN_FRAME_PREFIX.test(value) && !/^[A-Z0-9]{2,4}\d/.test(value)) return;
    if (!labelled && !KNOWN_FRAME_PREFIX.test(value) && /[A-Z]{4,}/.test(value)) return;
    if (/^(?:TEL|PHONE|HOTLINE|DATE|MODEL|HONDA|YAMAHA|SUZUKI|PARKING|BIENSO)/.test(value)) return;
    const candidate: Candidate = { value, confidence, uncertainCharacters: riskyGlyphs(value, confidence), rawValue: value };
    const previous = found.get(value);
    if (!previous || previous.confidence < confidence) found.set(value, candidate);
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
    if (groups.length < 2 || !KNOWN_FRAME_PREFIX.test(groups[0]) || groups[0].length > 6) continue;
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

/** Competing identifiers require another focused scan, never first-hit selection. */
export function uniqueCandidate(candidates: Candidate[]): Candidate | null {
  const values = new Set(candidates.map((candidate) => candidate.value));
  return values.size === 1 ? bestCandidate(candidates) : null;
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
