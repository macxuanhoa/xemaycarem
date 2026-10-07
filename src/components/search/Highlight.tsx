import { memo, type ReactNode } from "react";

/**
 * Highlights substrings of `text` that match the user's search query.
 *
 * The search is accent- and case-insensitive (e.g., typing "den" matches "Đen",
 * "wave" matches "Wave"). In addition, multi-word queries (e.g. "wave 29a")
 * match each individual token as well as the full phrase.
 *
 * It maps matches back onto the ORIGINAL characters — the mark always shows the
 * real, correctly spelled text, never the folded form.
 */
const foldChar = (ch: string): string =>
  ch
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

/** Returns non-overlapping [startChar, endChar) ranges (in original code points). */
function findMatchRanges(text: string, query: string): [number, number][] {
  const trimmed = (query ?? "").trim();
  if (!trimmed || !text) return [];

  const chars = Array.from(text);
  let foldedText = "";
  const owner: number[] = []; // folded position → index of the original char
  chars.forEach((ch, ci) => {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) owner.push(ci);
    foldedText += f;
  });

  const rawTokens = trimmed
    .split(/\s+/)
    .map((t) => fold(t).trim())
    .filter(Boolean);
  const fullFolded = fold(trimmed);

  // Match full phrase first if non-empty, then individual tokens
  const needles = Array.from(new Set([fullFolded, ...rawTokens])).filter(
    (n) => n.length > 0,
  );

  const rawRanges: [number, number][] = [];
  for (const needle of needles) {
    let from = 0;
    let idx = foldedText.indexOf(needle, from);
    while (idx !== -1 && rawRanges.length < 200) {
      const startChar = owner[idx];
      const endChar = owner[idx + needle.length - 1] + 1;
      rawRanges.push([startChar, endChar]);
      from = idx + needle.length;
      idx = foldedText.indexOf(needle, from);
    }
  }

  if (rawRanges.length === 0) return [];

  // Sort ranges by start position, then by end desc
  rawRanges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  // Merge overlapping or adjacent ranges
  const merged: [number, number][] = [rawRanges[0]];
  for (let i = 1; i < rawRanges.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = rawRanges[i];
    if (curr[0] <= prev[1]) {
      if (curr[1] > prev[1]) {
        prev[1] = curr[1];
      }
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

// Bounded in-memory LRU cache to make repetitive table renders 0ms
const matchRangesCache = new Map<string, [number, number][]>();
const MAX_CACHE_SIZE = 1000;

function getCachedMatchRanges(text: string, query: string): [number, number][] {
  const cacheKey = `${text}\0${query}`;
  const hit = matchRangesCache.get(cacheKey);
  if (hit) return hit;

  const result = findMatchRanges(text, query);
  if (matchRangesCache.size >= MAX_CACHE_SIZE) {
    const keys = matchRangesCache.keys();
    for (let i = 0; i < 200; i++) {
      const k = keys.next().value;
      if (k) matchRangesCache.delete(k);
    }
  }
  matchRangesCache.set(cacheKey, result);
  return result;
}

export const Highlight = memo(function Highlight({
  text,
  query,
}: {
  text?: string | null;
  query?: string | null;
}): ReactNode {
  if (text == null) return null;
  const str = String(text);
  if (!str) return "";
  const q = typeof query === "string" ? query : "";
  if (!q.trim()) return str;

  const chars = Array.from(str);
  const ranges = getCachedMatchRanges(str, q);
  if (!ranges.length || !chars.length) return str;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], n) => {
    if (start > cursor) nodes.push(chars.slice(cursor, start).join(""));
    nodes.push(
      <mark key={n} className="search-hit">
        {chars.slice(start, end).join("")}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < chars.length) nodes.push(chars.slice(cursor).join(""));
  return nodes;
});
