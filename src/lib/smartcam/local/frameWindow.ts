import { chooseBestFrameIndex, type FrameAnalysis } from "./regions";

/**
 * Clearest-frame candidates for one scan burst. Keyed by the number of
 * identifier characters a tick read, not by the exact string: a single
 * disagreeing glyph is evidence for the vote, not a reason to throw away the
 * sharp frames that already agreed on the shape of the plate.
 */
export type ScanSample<T> = {
  slots: number;
  analysis: FrameAnalysis | null;
  value: T;
};

/** Enough frames to settle two agreeing reads plus a spare sharper one. */
export const SCAN_WINDOW_SIZE = 5;

/** Never mix evidence from different identifiers, or keep an unbounded video history. */
export function appendScanSample<T>(
  window: readonly ScanSample<T>[],
  sample: ScanSample<T>,
): ScanSample<T>[] {
  const same = window.at(-1)?.slots === sample.slots ? window : [];
  return [...same.slice(-(SCAN_WINDOW_SIZE - 1)), sample];
}

export function bestScanSample<T>(
  window: readonly ScanSample<T>[],
): ScanSample<T> | undefined {
  const index = chooseBestFrameIndex(window.map((sample) => sample.analysis));
  return window[index < 0 ? window.length - 1 : index];
}
