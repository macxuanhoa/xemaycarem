/**
 * Pure control logic for the continuous scan loop: how long to wait between
 * frames (adaptive sampling — never overlapping recognizers, backing off on
 * misses to spare battery) and when a read has enough evidence to fire.
 *
 * The sampling limits are frozen: the shop owner is happy with the current
 * speed and nothing in this file may make a tick slower or faster. Accuracy
 * comes from *what a tick is allowed to count*, not from waiting longer.
 *
 * Voting used to key on the whole joined identifier string, so one wobbly
 * character reset the streak to zero — the read flickered on screen and a
 * dirty stamp took longer to settle than a clean one. Evidence now accumulates
 * per reading, so a single disagreeing glyph becomes a data point instead of a
 * reset, and a position two frames genuinely disagree over stays disputed
 * rather than being decided by whichever frame happened to arrive first.
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
  baseMs: 160,
  busyMs: 80,
  maxMs: 1200,
  /** Blurry frames are cheap — re-check fast but not frantically. */
  blurryMs: 180,
};

/** Adaptive next-tick delay: fast while productive, slow while starved. */
export function nextTickMs({ busy, missStreak, sharp }: SamplerInput): number {
  if (busy) return SAMPLER_LIMITS.busyMs;
  if (!sharp) return SAMPLER_LIMITS.blurryMs;
  const backoff = Math.min(SAMPLER_LIMITS.maxMs, SAMPLER_LIMITS.baseMs + missStreak * 60);
  return backoff;
}

/** One identifier a tick could read, in the compact display-independent form. */
export type Reading = {
  /** Canonical text the draft will carry (`59B1-234.56`). */
  value: string;
  /**
   * Alphanumerics only. Frames align on this, and warning positions are
   * counted against it — the same space the cloud OCR contract uses.
   */
  compact: string;
  confidence: number;
  /** Compact positions the decoder had to substitute to make the read legal. */
  disputed?: number[];
  /** Grammar + margin said this reading needs no human check. */
  autoEligible?: boolean;
};

type Tally = {
  value: string;
  compact: string;
  count: number;
  confidenceSum: number;
  /** Frames that ever marked this position substituted. */
  disputed: Set<number>;
  /** Frames that carried this reading with a clean auto-lock. */
  autoFrames: number;
};

export type FieldEvidence = {
  tallies: Tally[];
  frames: number;
};

export const EVIDENCE_LIMITS = {
  /** A single lucky frame never fires, however confident it claims to be. */
  requiredFrames: 2,
  /**
   * Share of frames the winning reading must hold to be believed. Two of three
   * agreeing frames is the intent, so the bar sits just under 2/3 rather than
   * just above it — a float comparison must not turn a majority into a miss.
   */
  minAgreement: 0.66,
  /** Share needed before the camera may lock without asking. */
  autoAgreement: 0.8,
  /** A rival holding this share of frames makes a position disputed. */
  contestedShare: 0.5,
  maxTallies: 6,
};

const average = (tally: Tally) => tally.confidenceSum / tally.count;

/** Most-believed reading first: agreement, then mean confidence, then cleanest. */
function ranked(tallies: readonly Tally[]): Tally[] {
  return [...tallies].sort(
    (a, b) =>
      b.count - a.count ||
      average(b) - average(a) ||
      a.disputed.size - b.disputed.size ||
      a.compact.localeCompare(b.compact),
  );
}

/**
 * Fold one observation into a field's evidence. `null` (or an empty value)
 * means nothing was readable this tick — the scene moved on, so the evidence
 * is dropped rather than allowed to accumulate across vehicles.
 */
export function pushEvidence(
  state: FieldEvidence | null,
  reading: Reading | null,
): FieldEvidence | null {
  if (!reading?.value) return null;
  const tallies = state?.tallies ?? [];
  const existing = tallies.find((tally) => tally.compact === reading.compact);
  if (existing) {
    existing.count++;
    existing.confidenceSum += reading.confidence;
    existing.autoFrames += reading.autoEligible ? 1 : 0;
    for (const index of reading.disputed ?? []) existing.disputed.add(index);
  } else {
    tallies.push({
      value: reading.value,
      compact: reading.compact,
      count: 1,
      confidenceSum: reading.confidence,
      disputed: new Set(reading.disputed ?? []),
      autoFrames: reading.autoEligible ? 1 : 0,
    });
  }
  return {
    // Bounded: a long session on one bike must not grow without limit.
    tallies: ranked(tallies).slice(0, EVIDENCE_LIMITS.maxTallies),
    frames: (state?.frames ?? 0) + 1,
  };
}

export type FieldOutcome = {
  value: string;
  confidence: number;
  /** Winning reading's share of frames, 0..1. */
  agreement: number;
  /** Positions the winner substituted, plus any a rival contests. */
  disputed: number[];
  /** Runner-up readings, best first — what the CONFIRM strip offers. */
  alternatives: string[];
  /** Enough agreement to stop scanning this field. */
  settled: boolean;
  /** Enough evidence to lock without asking a human. */
  autoEligible: boolean;
};

const NO_OUTCOME: FieldOutcome = {
  value: "",
  confidence: 0,
  agreement: 0,
  disputed: [],
  alternatives: [],
  settled: false,
  autoEligible: false,
};

/** Read a field's evidence without mutating it — the settle/tier decision. */
export function readEvidence(
  state: FieldEvidence | null,
  options: { required?: number; minAgreement?: number; minConfidence?: number } = {},
): FieldOutcome {
  const required = options.required ?? EVIDENCE_LIMITS.requiredFrames;
  const minAgreement = options.minAgreement ?? EVIDENCE_LIMITS.minAgreement;
  const minConfidence = options.minConfidence ?? 55;
  if (!state?.tallies.length) return NO_OUTCOME;
  const [top, ...rest] = ranked(state.tallies);
  const agreement = top.count / state.frames;
  // A rival that keeps showing up is evidence against the winner's glyph, not
  // evidence for a coin flip: mark exactly the positions they disagree on.
  const contested = new Set(top.disputed);
  for (const rival of rest) {
    if (rival.count / state.frames < EVIDENCE_LIMITS.contestedShare) continue;
    if (rival.compact.length !== top.compact.length) continue;
    for (let index = 0; index < top.compact.length; index++)
      if (rival.compact[index] !== top.compact[index]) contested.add(index);
  }
  const disputed = [...contested].sort((a, b) => a - b);
  const confidence = average(top);
  return {
    value: top.value,
    confidence,
    agreement,
    disputed,
    alternatives: rest.map((tally) => tally.value),
    settled: agreement >= minAgreement && state.frames >= required && confidence >= minConfidence,
    autoEligible:
      agreement >= EVIDENCE_LIMITS.autoAgreement &&
      state.frames >= required &&
      disputed.length === 0 &&
      top.autoFrames >= required &&
      confidence >= minConfidence,
  };
}

/**
 * Should this tick also try barcode/QR decoding? ZXing is cheap but not free
 * on a phone — run it on a slower cadence than the sharpness gate.
 */
export function shouldDecodeCodes(tickIndex: number, everyNthTick = 2): boolean {
  return tickIndex % everyNthTick === 0;
}
