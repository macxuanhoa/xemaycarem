// Vietnamese color vocabulary used by the "Màu sắc" quick-picker on intake
// forms. Staff typically see the bike and pick a swatch, then the app fills
// the text field with a plain Vietnamese word that reads cleanly on reports
// and print-outs ("Đen", "Trắng ngà", "Xanh navy").
//
// The palette is intentionally close to what actually shows up at Cà Rem
// (mostly Honda/Piaggio/Suzuki/Yamaha colourways) — no "chartreuse", no
// "fuchsia". Anchor hex values are only used for nearest-neighbour lookup
// from the browser's color picker; the stored value is always the Vietnamese
// word (or a compound word like "Đen nhám") so historical rows stay readable.

type Anchor = { word: string; hex: string };

// Ordered roughly by frequency at the shop. Keep in sync with INTERNAL_SOPS.
export const COLOR_ANCHORS: readonly Anchor[] = [
  { word: "Đen", hex: "#111111" },
  { word: "Đen nhám", hex: "#232323" },
  { word: "Trắng", hex: "#f7f7f7" },
  { word: "Trắng ngà", hex: "#efe6d0" },
  { word: "Bạc", hex: "#c9ccd1" },
  { word: "Xám", hex: "#7a7f87" },
  { word: "Xám khói", hex: "#4f545c" },
  { word: "Đỏ", hex: "#c8102e" },
  { word: "Đỏ đô", hex: "#7a1a1f" },
  { word: "Cam", hex: "#f28020" },
  { word: "Vàng", hex: "#f5c518" },
  { word: "Kem", hex: "#e6d3a3" },
  { word: "Nâu", hex: "#7b4a2a" },
  { word: "Hồng", hex: "#f4a6b8" },
  { word: "Tím", hex: "#5c3d99" },
  { word: "Xanh lá", hex: "#2ea44f" },
  { word: "Xanh mint", hex: "#7ddfc0" },
  { word: "Xanh ngọc", hex: "#22b8cf" },
  { word: "Xanh dương", hex: "#1e4baf" },
  { word: "Xanh navy", hex: "#1a2a4a" },
] as const;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h.padEnd(6, "0").slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Nearest Vietnamese colour word for an arbitrary hex value picked from
 * `<input type="color">`. Uses weighted Euclidean distance (R*2 + G*4 + B*3)
 * which approximates perceived brightness better than plain RGB for the
 * black/white/gray distinction that dominates vehicle paint.
 */
export function matchColorWord(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  let best = COLOR_ANCHORS[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const anchor of COLOR_ANCHORS) {
    const [ar, ag, ab] = hexToRgb(anchor.hex);
    const dr = r - ar;
    const dg = g - ag;
    const db = b - ab;
    const score = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (score < bestScore) {
      bestScore = score;
      best = anchor;
    }
  }
  return best.word;
}

/**
 * Reverse lookup for the swatch preview: show the anchor colour that best
 * matches whatever word the field already holds (case/diacritic-insensitive).
 * Falls back to a neutral mid-grey so the swatch stays visible for unknown
 * free-typed values like "Đen bóng mờ".
 */
export function colorWordToHex(word: string | undefined | null): string {
  if (!word) return "#808080";
  const needle = word.trim().toLowerCase();
  const hit = COLOR_ANCHORS.find((a) => a.word.toLowerCase() === needle);
  return hit?.hex ?? "#808080";
}

/** Exposed so the Quick-pick brand/model chip module can drop COLOR_CHIPS. */
export const COLOR_WORDS: readonly string[] = COLOR_ANCHORS.map((a) => a.word);
