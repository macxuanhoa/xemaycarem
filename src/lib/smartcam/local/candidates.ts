/**
 * Pure parsing of raw OCR text into candidate identifiers. No canvas, no
 * worker, no network — this is the layer unit tests exercise against the
 * character confusions a real Vietnamese plate/frame stamp produces
 * (O/0, I/1, S/5, dots and dashes eaten or invented by the engine).
 */
import { isValidMotorbikePlate, normalizePlate } from "@/lib/plate";

/** A candidate identifier with the OCR confidence that produced it (0..100). */
export type Candidate = { value: string; confidence: number };

/** Mirror easily-confused glyph pairs; the plate validator does the filtering. */
function glyphVariants(token: string): string[] {
  const seen = new Set<string>();
  const push = (value: string) => seen.add(value.toUpperCase());
  push(token);
  // Only cheap 1:1 substitutions — a phone browser cannot afford a big search.
  const swaps: [RegExp, string][] = [
    [/O/g, "0"],
    [/Q/g, "0"],
    [/I/g, "1"],
    [/L/g, "1"],
    [/S/g, "5"],
    [/B/g, "8"],
    [/Z/g, "2"],
    [/0/g, "O"],
    [/1/g, "I"],
    [/5/g, "S"],
  ];
  for (const [pattern, replacement] of swaps) {
    if (pattern.test(token)) push(token.replace(pattern, replacement));
  }
  return [...seen];
}

/**
 * License-plate candidates from free text, e.g. "59-B1 234.56", "59B123456",
 * "59-B1-234.56". Returns canonical forms only (isValidMotorbikePlate gates).
 */
export function parsePlateCandidates(text: string, confidence: number): Candidate[] {
  const upper = text.toUpperCase();
  // Province code + 1-2 letters + series digit + 4-5 digit serial, with every
  // separator OCR may eat or invent, including multi-space and newlines on 2-line plates:
  // "59-B1 234.56", "59B123456", "29-A1\n1234", "59-A1 \n 234.56".
  const pattern = /\d{2}[\s\-._]*[A-Z]{1,2}[\s\-._]*\d[\s\-._]*\d{2,3}[\s\-._]*\d{2}(?!\d)/g;
  const found = new Map<string, Candidate>();
  for (const match of upper.matchAll(pattern)) {
    const compact = match[0].replace(/[^A-Z0-9]/g, "");
    for (const variant of glyphVariants(compact)) {
      const canonical = normalizePlate(variant);
      if (!canonical || !isValidMotorbikePlate(canonical)) continue;
      // Canonical format is validated by plate.ts; here only exclude prefixes
      // that have never been issued (00–10). Real current and legacy codes
      // start at 11 (Cao Bằng/Lạng Sơn) and run through 99.
      const province = Number(canonical.slice(0, 2));
      if (province < 11 || province > 99) continue;
      const previous = found.get(canonical);
      // A variant that needed no glyph swap keeps the raw confidence; swapped
      // ones are discounted so the stable-frame vote prefers clean reads.
      const score = variant === compact ? confidence : confidence * 0.8;
      if (!previous || previous.confidence < score) found.set(canonical, { value: canonical, confidence: score });
    }
  }
  return [...found.values()];
}

/** Frame numbers: 11-18 alphanumerics with both letters and digits (VIN-like). */
export function parseFrameCandidates(text: string, confidence: number): Candidate[] {
  const compact = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const found = new Map<string, Candidate>();
  for (let i = 0; i + 11 <= compact.length && i < compact.length - 10; i++) {
    const window = compact.slice(i, Math.min(i + 18, compact.length));
    const match = window.match(/^[A-Z0-9]{11,18}/);
    if (!match) continue;
    const value = match[0];
    if (value.length < 11 || value.length > 18) continue;
    const digits = value.replace(/[^0-9]/g, "").length;
    const letters = value.replace(/[^A-Z]/g, "").length;
    // Real stamped frames mix both; pure runs are province/serial artifacts.
    if (digits < 4 || letters < 2) continue;
    if (!found.has(value)) found.set(value, { value, confidence });
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
 * Raw OCR output → the field draft `normalizeScan` understands.
 * Bộ đọc tại máy chỉ còn biển số + số khung: cột `engine_number` đã bị xoá
 * vĩnh viễn nên đọc ra cũng không có chỗ lưu.
 */
export function candidatesFromOcr(text: string, confidence: number): {
  license_plate: string;
  frame_number: string;
} {
  return {
    license_plate: bestCandidate(parsePlateCandidates(text, confidence))?.value ?? "",
    frame_number: bestCandidate(parseFrameCandidates(text, confidence))?.value ?? "",
  };
}
