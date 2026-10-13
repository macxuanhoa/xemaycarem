/**
 * Main-thread client for the frame-analysis worker. Feature-detects the
 * modern stack (Worker + createImageBitmap + OffscreenCanvas), transfers one
 * bitmap per request and never blocks the tick longer than the timeout —
 * a missing, failed or slow worker simply returns null and the caller runs
 * the same analysis on the main canvas, exactly as before.
 */
import type { FrameAnalysis } from "./regions";
import type { AnalysisReply, AnalysisRequest, WorkerCrop } from "./analysis.worker";

export type OffThreadResult = {
  signature: Float32Array | null;
  analysis: FrameAnalysis | null;
  width: number;
  height: number;
};

let worker: Worker | null = null;
let broken = false;
let sequence = 0;
const pending = new Map<number, (reply: AnalysisReply | null) => void>();

export function analysisOffThreadSupported(): boolean {
  if (broken) return false;
  return (
    typeof Worker !== "undefined" &&
    typeof createImageBitmap !== "undefined" &&
    typeof OffscreenCanvas !== "undefined"
  );
}

function failAllPending(): void {
  for (const settle of pending.values()) settle(null);
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (broken) return null;
  if (!worker) {
    try {
      worker = new Worker(
        new URL("./analysis.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event: MessageEvent<AnalysisReply>) => {
        const settle = pending.get(event.data.id);
        if (settle) {
          pending.delete(event.data.id);
          settle(event.data);
        }
      };
      worker.onerror = () => {
        broken = true;
        failAllPending();
        void worker?.terminate();
        worker = null;
      };
    } catch {
      broken = true;
      return null;
    }
  }
  return worker;
}

/** Analyze one video frame off-thread; null = unavailable or timed out. */
export async function analyzeFrameOffThread(options: {
  bitmap: ImageBitmap;
  crop: WorkerCrop | null;
  maxEdge: number;
  timeoutMs?: number;
}): Promise<OffThreadResult | null> {
  const active = ensureWorker();
  if (!active) return null;
  const id = ++sequence;
  const request: AnalysisRequest = {
    id,
    bitmap: options.bitmap,
    crop: options.crop,
    maxEdge: options.maxEdge,
  };
  return new Promise<OffThreadResult | null>((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      // The bitmap is already transferred — the worker closes it regardless.
      resolve(null);
    }, options.timeoutMs ?? 900);
    pending.set(id, (reply) => {
      window.clearTimeout(timer);
      resolve(
        reply
          ? {
              signature: reply.signature,
              analysis: reply.analysis,
              width: reply.width,
              height: reply.height,
            }
          : null,
      );
    });
    active.postMessage(request, [request.bitmap]);
  });
}

/** Tear the worker down (camera screen closed for good). */
export function releaseAnalysisWorker(): void {
  const active = worker;
  worker = null;
  broken = false;
  sequence = 0;
  failAllPending();
  void active?.terminate();
}
