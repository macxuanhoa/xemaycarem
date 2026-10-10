import { chooseBestFrameIndex, type FrameAnalysis } from "./regions";

export type ScanSample<T> = {
  key: string;
  analysis: FrameAnalysis | null;
  value: T;
};

/** Never mix evidence from different identifiers, or keep an unbounded video history. */
export function appendScanSample<T>(
  window: readonly ScanSample<T>[],
  sample: ScanSample<T>,
): ScanSample<T>[] {
  const same = window.at(-1)?.key === sample.key ? window : [];
  return [...same.slice(-2), sample];
}

export function bestScanSample<T>(
  window: readonly ScanSample<T>[],
): ScanSample<T> | undefined {
  const index = chooseBestFrameIndex(window.map((sample) => sample.analysis));
  return window[index < 0 ? window.length - 1 : index];
}
