/**
 * Vietnamese motorbike identifier grammar.
 *
 * Tesseract reads pixels; it has no idea that a motorbike plate is
 * `province + series + serial` drawn from closed sets, or that an ISO 3779
 * chassis stamp can never contain the letters I, O or Q. This module holds
 * only that domain knowledge — pure tables and predicates, no canvas, no
 * worker — so `decoder.ts` can rank hypotheses against it and unit tests can
 * exercise the rules without a browser.
 *
 * Rules come from Thông tư 79/2024/TT-BCA (plate layout, the 20-letter series
 * pool, effective 01/01/2025), Thông tư 51/2025/TT-BCA (the 34-province code
 * table from 01/07/2025, legacy codes still in circulation) and ISO 3779/3780
 * (VIN character set and the model-year position). Display strings stay owned
 * by `@/lib/plate` — this module never invents a second formatter.
 */

/** Which character class a plate slot accepts. */
export type SlotClass = "province" | "letter" | "digit";

export type PlateShape = {
  id: string;
  slots: readonly SlotClass[];
  /** Shape prior: how common this layout is on a bike at the shop. */
  prior: number;
  note: string;
};

// P = province digit, L = series letter, D = serial digit.
const shape = (id: string, spec: string, prior: number, note: string): PlateShape => ({
  id,
  prior,
  note,
  slots: [...spec].map((c) =>
    c === "P" ? "province" : c === "L" ? "letter" : "digit",
  ),
});

/**
 * The four shapes a Vietnamese motorbike plate compresses to (separators
 * removed): `59XA-123.45` (two-letter series, issued from 15/08/2023),
 * `59B1-234.56`, and the legacy 4- and 6-digit serials `29A1-1234` /
 * `92D1-728282`. Ordered most specific first so an equal-scoring modern read
 * wins over the legacy reading of the same glyph run.
 */
export const PLATE_SHAPES: readonly PlateShape[] = [
  shape("modern", "PPLLDDDDD", 1, "59XA-123.45"),
  shape("series", "PPLDDDDDD", 1, "59B1-234.56"),
  shape("legacy4", "PPLDDDDD", 0.94, "29A1-1234"),
  shape("legacy6", "PPLDDDDDDD", 0.92, "92D1-728282"),
];

/**
 * Province codes still legal on a two-wheel plate: the merged 34-province
 * table of Thông tư 51/2025/TT-BCA unioned with the legacy codes that keep
 * circulating on existing bikes. Closed on purpose — `13`, `42`, `44`, `45`
 * and `46` were never issued for motorbikes, so a read landing there is a
 * misread, not a rare province.
 */
export const PROVINCE_CODES: ReadonlySet<string> = new Set([
  "11", "12", "14", "15", "16", "17", "18", "19", "20", "21",
  "22", "23", "24", "25", "26", "27", "28", "29", "30", "31",
  "32", "33", "34", "35", "36", "37", "38", "39", "40", "41",
  "43", "47", "48", "49", "50", "51", "52", "53", "54", "55",
  "56", "57", "58", "59", "60", "61", "62", "63", "64", "65",
  "66", "67", "68", "69", "70", "71", "72", "73", "74", "75",
  "76", "77", "78", "79", "81", "82", "83", "84", "85", "86",
  "88", "89", "90", "92", "93", "94", "95", "97", "98", "99",
]);

/**
 * Ministry/agency and transitional codes that exist on real bikes but must
 * never auto-lock: accepted as a lead with a reduced prior.
 */
export const SPECIAL_PROVINCE_CODES: ReadonlySet<string> = new Set([
  "80", "87", "91", "96",
]);

/**
 * The series letter pool a plate may draw from, verified against the official
 * list: A B C D E F G H K L M N P S T U V X Y Z. `I`, `O`, `Q`, `R`, `W` and
 * `J` are absent by regulation, which is the single strongest veto the decoder
 * has — an OCR `O` in a series slot is definitionally a misread.
 */
export const PLATE_SERIES_LETTERS: ReadonlySet<string> = new Set(
  "ABCDEFGHKLMNPSTUVXYZ",
);

/** Officially-issued special groups outside the private-plate series pool. */
export const SPECIAL_PLATE_SERIES: ReadonlySet<string> = new Set([
  "LA", "LB", "LD", "DA", "MD", "MĐ", "TD", "TĐ", "MK", "CT", "CD", "R",
]);

/** Province-slot weight: closed set, lead-only set, or impossible. */
export function provinceWeight(code: string): number {
  if (PROVINCE_CODES.has(code)) return 1;
  if (SPECIAL_PROVINCE_CODES.has(code)) return 0.62;
  return 0;
}

export function isSeriesLetter(character: string): boolean {
  return PLATE_SERIES_LETTERS.has(character);
}

/**
 * Letters a digit is mistaken for on a stamped/reflective plate. Deliberately
 * short: every entry here costs the hypothesis that takes it, so an
 * over-eager table would manufacture plausible-but-wrong plates.
 */
const LETTER_OF_DIGIT: Record<string, readonly string[]> = {
  "0": ["D"],
  "1": ["L", "T"],
  "2": ["Z"],
  "4": ["A"],
  "5": ["S"],
  "6": ["G"],
  "7": ["T"],
  "8": ["B"],
};

/** Digits a letter is mistaken for — the classic engraving confusions. */
const DIGIT_OF_LETTER: Record<string, string> = {
  O: "0",
  Q: "0",
  D: "0",
  I: "1",
  L: "1",
  T: "1",
  Z: "2",
  R: "2",
  S: "5",
  G: "6",
  B: "8",
};

/**
 * Substitution plausibility, calibrated to how this font actually fails.
 * The costs must be well separated or `I→1` (the classic misread) ties with
 * `I→L` (a stretch) and the winner is decided by table order — which is how a
 * plate silently changes identity. A digit read as a *letter* is rarer still,
 * so it sits lowest: that gap is what keeps a clean read comfortably clear of
 * the auto-lock threshold instead of landing exactly on it.
 */
export const WEIGHT_AS_IS = 1;
export const WEIGHT_LETTER_TO_DIGIT = 0.62;
export const WEIGHT_DIGIT_TO_LETTER = 0.2;
export const WEIGHT_ILLEGAL_TO_LEGAL = 0.22;

/**
 * Characters that may legitimately appear where a digit is expected. The
 * lexical window finder in `candidates.ts` builds its pattern from this so the
 * two lists cannot drift apart and silently cost recall on `T`/`G`/`D`/`R`.
 * Digits are listed one by one: the string is pasted straight into a `[...]`
 * class, where a `0-9` shortcut would read as a range instead of a set.
 */
export const DIGIT_LIKE_GLYPHS =
  "0123456789" + Object.keys(DIGIT_OF_LETTER).sort().join("");

/** Illegal letters and the legal letters they are most often a slip of. */
const NEAR_LETTER_OF_ILLEGAL: Record<string, readonly string[]> = {
  I: ["L", "T"],
  O: ["D"],
  J: ["L"],
  W: ["V"],
  R: ["P"],
};

export type SlotAlternative = {
  /** The character a slot may legally hold. */
  char: string;
  /** Relative plausibility of this reading, 0..1 (1 = read as printed). */
  weight: number;
};

/**
 * Every reading a slot accepts for the observed glyph, most likely first.
 * The observed character is kept whenever the slot accepts it — that is the
 * whole point of this module: the old pipeline folded `S→5`, `B→8` and `L→1`
 * in one direction and never re-tested the letter reading.
 */
export function slotAlternatives(
  slot: SlotClass,
  observed: string,
): SlotAlternative[] {
  const glyph = observed.toUpperCase();
  if (!/[A-Z0-9]/.test(glyph)) return [];
  const numeric = /^[0-9]$/.test(glyph);
  if (slot === "province" || slot === "digit") {
    if (numeric) return [{ char: glyph, weight: WEIGHT_AS_IS }];
    const digit = DIGIT_OF_LETTER[glyph];
    return digit
      ? [{ char: digit, weight: WEIGHT_LETTER_TO_DIGIT }]
      : [];
  }
  if (isSeriesLetter(glyph)) return [{ char: glyph, weight: WEIGHT_AS_IS }];
  if (numeric)
    return (LETTER_OF_DIGIT[glyph] ?? [])
      .filter(isSeriesLetter)
      .map((char) => ({ char, weight: WEIGHT_DIGIT_TO_LETTER }));
  return (NEAR_LETTER_OF_ILLEGAL[glyph] ?? [])
    .filter(isSeriesLetter)
    .map((char) => ({ char, weight: WEIGHT_ILLEGAL_TO_LEGAL }));
}

/**
 * Whether two glyphs are the same physical mark read two ways. Used to decide
 * if an inventory record differing at exactly one position is a *correction
 * candidate* rather than a different vehicle that happens to look similar.
 */
export function glyphsConfusable(a: string, b: string): boolean {
  if (a === b) return true;
  if (DIGIT_OF_LETTER[a] === b || DIGIT_OF_LETTER[b] === a) return true;
  if ((LETTER_OF_DIGIT[a] ?? []).includes(b)) return true;
  return (LETTER_OF_DIGIT[b] ?? []).includes(a);
}

// ---------------------------------------------------------------------------
// Số khung — the stamped chassis code.
// ---------------------------------------------------------------------------

/** ISO 3779/3780 forbids I, O and Q in a VIN at any position. */
export const VIN_FORBIDDEN = /[IOQ]/;

/**
 * Motorcycle WMI prefixes seen on bikes at a Vietnamese shop. The original
 * list plus the assembly/import prefixes that also reach the counter.
 */
export const FRAME_WMI =
  /^(?:RL[ACHMST]|JH[23]|JYA|JKA|JS1|KM4|MLH|ME1|LC2|LBB|LAL|ZD4|MH[0-9]|LJH|LYC|9BM|VF[0-9]|HH[0-9])/;

/**
 * Honda/Yamaha/Suzuki domestic short stamps: a model code plus a serial,
 * e.g. `JA29E1234567`. The server only ever requires 11-100 compact
 * characters with at least one letter and one digit, so these patterns carry
 * the domain weight the storage rules deliberately do not.
 */
export const SHORT_FRAME_STAMP =
  /^(?:[A-Z]{2}\d{2}[A-Z]\d{6,7}|[A-Z0-9]{2,3}\d{6,7})$/;

/** VIN position 10 model-year glyph: no I, O, Q, U and no zero. */
export const VIN_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

export type FrameVerdict = {
  valid: boolean;
  /** Grammar prior 0..1 — multiplied into the read's confidence. */
  weight: number;
  knownWmi: boolean;
  shortStamp: boolean;
  /** VIN position-10 check; null when the token is not 17 characters. */
  yearPositionValid: boolean | null;
  /** Last five characters are digits — the server's duplicate signature. */
  digitTail: boolean;
};

/**
 * Grade a compact chassis code. `labelled` means the OCR text carried a
 * "SỐ KHUNG / CHASSIS / VIN" label right before the token, which is the same
 * context signal `parseFrameCandidates` already uses to join stamp spacing.
 */
export function gradeFrame(compact: string, labelled = false): FrameVerdict {
  const value = compact.toUpperCase();
  const base: FrameVerdict = {
    valid: false,
    weight: 0,
    knownWmi: FRAME_WMI.test(value),
    shortStamp: SHORT_FRAME_STAMP.test(value),
    yearPositionValid: null,
    digitTail: /\d{5}$/.test(value),
  };
  // Storage contract from lookup_vehicle_identifiers, mirrored exactly.
  if (
    value.length < 11 ||
    value.length > 100 ||
    !/[A-Z]/.test(value) ||
    !/\d/.test(value) ||
    value.startsWith("GEN")
  )
    return base;
  if (VIN_FORBIDDEN.test(value)) return base;
  const fullVin = value.length === 17;
  if (fullVin) {
    base.yearPositionValid = VIN_YEAR_CODES.includes(value[9]);
    if (!base.knownWmi || base.yearPositionValid === false) return base;
  } else if (!base.knownWmi && !base.shortStamp && !labelled) return base;
  let weight = 0.5;
  if (base.knownWmi) weight += 0.3;
  if (base.shortStamp) weight += 0.12;
  if (base.digitTail) weight += 0.08;
  if (labelled) weight += 0.1;
  if (fullVin) weight += 0.05;
  base.valid = true;
  base.weight = Math.min(1, weight);
  return base;
}
