/**
 * Grammar-constrained decoding of an OCR glyph run into identifier
 * hypotheses.
 *
 * The previous pipeline folded confusable glyphs in ONE direction
 * (`S→5`, `B→8`, `L→1`, `O→0`…) and reported the result at full confidence,
 * which is how a correct `S` became a wrong `5` with no warning anywhere.
 * Here every reading is generated as a competing hypothesis, scored against
 * `grammar.ts`, and the gap between first and second place is what decides
 * whether the camera may lock the result or must ask a human.
 *
 * Two deliberate limits keep this cheaper than the OCR pass feeding it:
 * digit slots never speculate digit→digit (a plate's font does not mix 3 and 8
 * the way it mixes S and 5), and the beam is capped, so a plate run of ten
 * glyphs costs well under a millisecond of pure arithmetic per tick.
 */
import { normalizePlate } from "@/lib/plate";
import {
  PLATE_SHAPES,
  WEIGHT_AS_IS,
  gradeFrame,
  provinceWeight,
  slotAlternatives,
  type FrameVerdict,
} from "./grammar";

export type Glyph = { character: string; confidence: number };

export type Hypothesis = {
  /** Canonical display value (`59B1-234.56`) or the compact stamp. */
  value: string;
  /** Alphanumerics only — the space warnings are indexed against this. */
  compact: string;
  confidence: number;
  /** Positions where the reading differs from the observed glyph. */
  disputed: number[];
  /** Lowest per-character confidence actually used for this reading. */
  minGlyphConfidence: number;
  /** Plate shape id / frame grammar note, for diagnostics only. */
  shape: string;
  /**
   * Unnormalized posterior: per-glyph confidence times every substitution
   * cost, the shape prior and the province weight. Ranking and the margin come
   * from this, never from `confidence`, or a folded `I→L` would tie with the
   * far likelier `I→1` and the winner would be decided by table order.
   */
  weight: number;
  autoEligible: boolean;
};

export type Decoded = {
  top: Hypothesis | null;
  /** Ranked readings behind the winner — the CONFIRM strip shows these. */
  alternatives: Hypothesis[];
  /** 0..100 separation between first and second place (100 = no rival). */
  margin: number;
};

/** Multiplicative penalty applied to the reported confidence per fold. */
const FOLD_CONFIDENCE_PENALTY = 0.08;
const MIN_CONFIDENCE_FACTOR = 0.65;
const BEAM_WIDTH = 8;
const MAX_HYPOTHESES = 512;
/**
 * AUTO needs the winner to hold this share of the total decoding weight. A
 * coin flip between two readings is 50, so 63 is the "comfortably ahead, not
 * merely first" bar — the difference between a lock and one extra tap.
 */
export const AUTO_MARGIN = 63;
/** Below this, a locked glyph is not trusted even with a wide margin. */
export const AUTO_GLYPH_CONFIDENCE = 78;

type BeamState = {
  chars: string[];
  folds: number[];
  /** Σ log(prior) — ranking only, never shown to the user. */
  score: number;
  /** Σ per-glyph confidence, so the reported score stays on the 0..100 scale. */
  confidenceSum: number;
  minConfidence: number;
};

const compactOf = (text: string) => text.replace(/[^A-Z0-9]/g, "").toUpperCase();

/** Confidence of the observed glyph at a position, uniform when unknown. */
function confidenceAt(
  index: number,
  glyphs: readonly Glyph[] | undefined,
  start: number,
  fallback: number,
): number {
  const glyph = glyphs?.[start + index];
  return glyph ? Math.max(0, Math.min(100, glyph.confidence)) : fallback;
}

/** Where the compact glyph run sits inside a supplied symbol stream. */
function streamIndexOf(
  observed: string,
  glyphs: readonly Glyph[] | undefined,
): number {
  if (!glyphs?.length) return 0;
  return glyphs.map((glyph) => glyph.character).join("").indexOf(observed);
}

function foldFactor(folds: number): number {
  return folds
    ? Math.max(MIN_CONFIDENCE_FACTOR, 1 - folds * FOLD_CONFIDENCE_PENALTY)
    : 1;
}

function toHypothesis(
  state: BeamState,
  shapeId: string,
  provinceScore: number,
): Hypothesis {
  const compact = state.chars.join("");
  const value = normalizePlate(compact);
  const meanConfidence = state.chars.length
    ? state.confidenceSum / state.chars.length
    : 0;
  return {
    value: value ?? compact,
    compact,
    confidence: meanConfidence * foldFactor(state.folds.length) * provinceScore,
    disputed: state.folds,
    minGlyphConfidence: state.minConfidence,
    shape: shapeId,
    weight: Math.exp(state.score) * provinceScore,
    autoEligible: !!value && state.folds.length === 0,
  };
}

/**
 * Rank every plate-shaped reading of one alphanumeric run, best first.
 * `glyphs` is the Tesseract symbol stream when available so a single unclear
 * character discounts only its own position instead of the whole read.
 */
export function decodePlate(
  observedRaw: string,
  confidence: number,
  glyphs?: readonly Glyph[],
): Hypothesis[] {
  const observed = compactOf(observedRaw);
  if (observed.length < 8 || observed.length > 10) return [];
  // Align to the symbol stream only when the run actually appears in it; a
  // pass whose text differs from the crop must fall back to uniform confidence
  // rather than silently dropping the identifier.
  const start = streamIndexOf(observed, glyphs);
  const stream = start >= 0 ? glyphs : undefined;
  const found = new Map<string, Hypothesis>();
  for (const shape of PLATE_SHAPES) {
    if (shape.slots.length !== observed.length) continue;
    let beam: BeamState[] = [
      {
        chars: [],
        folds: [],
        score: Math.log(shape.prior),
        confidenceSum: 0,
        minConfidence: 100,
      },
    ];
    let exhausted = false;
    for (let index = 0; index < shape.slots.length && !exhausted; index++) {
      const slot = shape.slots[index];
      const glyph = observed[index];
      const glyphConfidence = confidenceAt(index, stream, start, confidence);
      const next: BeamState[] = [];
      for (const state of beam) {
        for (const alt of slotAlternatives(slot, glyph)) {
          // Costs come from the grammar so `I→1` (the classic misread) always
          // outranks `I→L` (a stretch) instead of being decided by table order.
          const asIs = alt.weight === WEIGHT_AS_IS;
          next.push({
            chars: [...state.chars, alt.char],
            folds: asIs ? state.folds : [...state.folds, index],
            score:
              state.score +
              Math.log(Math.max(1e-6, glyphConfidence / 100)) +
              Math.log(alt.weight),
            confidenceSum: state.confidenceSum + glyphConfidence,
            minConfidence: Math.min(state.minConfidence, glyphConfidence),
          });
        }
      }
      if (!next.length) {
        exhausted = true;
        break;
      }
      next.sort((a, b) => b.score - a.score);
      beam = next.slice(0, BEAM_WIDTH);
    }
    if (exhausted) continue;
    for (const state of beam) {
      const provinceScore = provinceWeight(state.chars.slice(0, 2).join(""));
      if (!provinceScore) continue;
      const built = toHypothesis(state, shape.id, provinceScore);
      const previous = found.get(built.compact);
      // The same reading can be reached through two shapes — keep the likelier.
      if (previous && previous.weight >= built.weight) continue;
      found.set(built.compact, built);
      if (found.size >= MAX_HYPOTHESES) break;
    }
  }
  return [...found.values()].sort(
    (a, b) => rankWeight(b) - rankWeight(a) || a.disputed.length - b.disputed.length,
  );
}

/** Ranking uses the posterior, not the rounded number a human reads. */
function rankWeight(hypothesis: Hypothesis): number {
  return hypothesis.weight;
}

/** Share of the total weight the winner holds → the AUTO gate's margin. */
export function marginOf(ranked: readonly Hypothesis[]): number {
  if (!ranked.length) return 0;
  const total = ranked.reduce((sum, item) => sum + rankWeight(item), 0);
  if (!total) return 0;
  return Math.round((rankWeight(ranked[0]) / total) * 100);
}

export function decodePlateRun(
  observed: string,
  confidence: number,
  glyphs?: readonly Glyph[],
): Decoded {
  const ranked = decodePlate(observed, confidence, glyphs);
  const [top, ...rest] = ranked;
  return {
    top: top ?? null,
    alternatives: rest,
    margin: marginOf(ranked),
  };
}

/**
 * The single place that decides whether a decoded identifier may be locked
 * without a human: no folded glyph, the weakest glyph still reads clearly, and
 * the winner is comfortably ahead of the runner-up.
 */
export function autoLockEligible(decoded: Decoded): boolean {
  const top = decoded.top;
  return (
    !!top &&
    top.autoEligible &&
    top.minGlyphConfidence >= AUTO_GLYPH_CONFIDENCE &&
    decoded.margin >= AUTO_MARGIN
  );
}

// ---------------------------------------------------------------------------
// Số khung — the stamped chassis code.
// ---------------------------------------------------------------------------

/** Glyphs an ISO 3779 chassis code cannot contain, and their real reading. */
const VIN_ILLEGAL: Record<string, string> = { I: "1", O: "0", Q: "0" };

export type FrameRead = {
  compact: string;
  disputed: number[];
  verdict: FrameVerdict;
  autoEligible: boolean;
};

/**
 * A chassis stamp uses the full A–Z0–9 alphabet, so there is nothing to rank
 * the way a plate's slot classes allow. The one absolute rule is ISO 3779:
 * `I`, `O` and `Q` never appear in a VIN, so seeing one is proof of a misread
 * and the digit reading is the only legal hypothesis. Positions carrying an
 * already-illegal glyph are always reported as disputed.
 */
export function decodeFrame(observed: string): FrameRead | null {
  const raw = compactOf(observed);
  if (raw.length < 11) return null;
  const disputed: number[] = [];
  const chars = [...raw].map((character, index) => {
    const legal = VIN_ILLEGAL[character];
    if (!legal) return character;
    disputed.push(index);
    return legal;
  });
  const compact = chars.join("");
  const verdict = gradeFrame(compact);
  return {
    compact,
    disputed,
    verdict,
    autoEligible:
      verdict.valid && verdict.weight >= 0.6 && disputed.length === 0,
  };
}
