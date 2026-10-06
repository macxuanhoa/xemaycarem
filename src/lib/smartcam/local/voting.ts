/**
 * Pure control logic for the continuous scan loop: how long to wait between
 * frames (adaptive sampling — never overlapping recognizers, backing off on
 * misses to spare battery) and when a read is "stable" (multi-frame voting —
 * one lucky OCR guess is never enough to fire the beep).
 */

export type SamplerInput = {
  /** A recognition pass from the previous tick is still running. */
  busy: boolean;
  /** Ticks since the last readable candidate (reset on every success). */
  missStreak: number;
  /** Frame was sharp enough to try OCR on the previous tick. */
  sharp: boolean;
};

export const SAMPLER_LIMITS = {
  baseMs: 650,
  busyMs: 250,
  maxMs: 2400,
  /** Blurry frames are cheap — re-check fast but not frantically. */
  blurryMs: 500,
};

/** Adaptive next-tick delay: fast while productive, slow while starved. */
export function nextTickMs({ busy, missStreak, sharp }: SamplerInput): number {
  if (busy) return SAMPLER_LIMITS.busyMs;
  if (!sharp) return SAMPLER_LIMITS.blurryMs;
  const backoff = Math.min(SAMPLER_LIMITS.maxMs, SAMPLER_LIMITS.baseMs + missStreak * 300);
  return backoff;
}

export type VoteState = { key: string; count: number; confidenceSum: number } | null;

export type VoteOutcome = {
  state: VoteState;
  /** True exactly when the same candidate repeats `required` frames at avg confidence >= `minConfidence`. */
  settled: boolean;
  confidence: number;
};

/**
 * Fold one OCR observation into the vote. `key` is the normalized identifier
 * (empty = nothing readable this tick, which resets the streak so a wobbly
 * read never accumulates votes across scene changes).
 */
export function pushVote(
  state: VoteState,
  key: string,
  confidence: number,
  required = 2,
  minConfidence = 55,
): VoteOutcome {
  if (!key) return { state: null, settled: false, confidence: 0 };
  const next = state && state.key === key
    ? { key, count: state.count + 1, confidenceSum: state.confidenceSum + confidence }
    : { key, count: 1, confidenceSum: confidence };
  const average = next.confidenceSum / next.count;
  return {
    state: next,
    settled: next.count >= required && average >= minConfidence,
    confidence: average,
  };
}

/**
 * Should this tick also try barcode/QR decoding? ZXing is cheap but not free
 * on a phone — run it on a slower cadence than the sharpness gate.
 */
export function shouldDecodeCodes(tickIndex: number, everyNthTick = 2): boolean {
  return tickIndex % everyNthTick === 0;
}
