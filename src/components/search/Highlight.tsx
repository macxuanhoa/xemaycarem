import type { ReactNode } from "react";

/**
 * Highlights the substring of `text` that matched the user's search term.
 *
 * The global search is accent- and case-insensitive (staff type "den" and get
 * "Đen", "wave" matches "Wave"), so matching here folds both sides the same way
 * and then maps the match back onto the ORIGINAL characters — the mark always
 * shows the real, correctly spelled text, never the folded form. Purely visual:
 * it never changes what was searched or where a click goes.
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
function findMatchRanges(text: string, needle: string): [number, number][] {
  const q = fold(needle).trim();
  if (!q || !text) return [];
  const chars = Array.from(text);
  let folded = "";
  const owner: number[] = []; // folded position → index of the original char
  chars.forEach((ch, ci) => {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) owner.push(ci);
    folded += f;
  });
  const ranges: [number, number][] = [];
  let from = 0;
  let idx = folded.indexOf(q, from);
  while (idx !== -1 && ranges.length < 200) {
    ranges.push([owner[idx], owner[idx + q.length - 1] + 1]);
    from = idx + q.length;
    idx = folded.indexOf(q, from);
  }
  return ranges;
}

export function Highlight({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  const chars = Array.from(text);
  const ranges = findMatchRanges(text, query);
  if (!ranges.length || !chars.length) return text;

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
}
