import { AppError } from "./errors";
import {
  getNetworkStatus,
  isOnline,
  reportNetworkFailure,
  reportNetworkSuccess,
  subscribeNetworkStatus,
} from "./networkStatus";

/** Fail immediately instead of leaving a write queued for reconnection. */
export function ensureNetworkOnline(): void {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new AppError(
      "Đang mất kết nối. Giao dịch chưa được gửi. Hãy kết nối mạng để tiếp tục.",
    );
  }
  if (!isOnline()) {
    throw new AppError(
      "Chưa kết nối được máy chủ. Yêu cầu chưa được gửi. Giữ trang này mở và thử lại khi kết nối được khôi phục.",
    );
  }
}

export class NetworkRequestError extends TypeError {
  constructor(timedOut: boolean) {
    super(
      timedOut
        ? "Kết nối phản hồi quá lâu. Kết quả thao tác chưa được xác nhận; hãy kiểm tra lại danh sách trước khi thử lại."
        : "Mất kết nối khi đang gửi yêu cầu. Kết quả thao tác chưa được xác nhận; hãy kiểm tra lại danh sách trước khi thử lại.",
    );
    this.name = "NetworkRequestError";
  }
}

/** Shared by RPC, auth, uploads and Edge Functions. Never retries a request. */
export const networkFetch: typeof fetch = async (input, init) => {
  ensureNetworkOnline();
  const controller = new AbortController();
  const callerSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timedOut = false;
  let connectionLost = false;
  const url = input instanceof Request ? input.url : String(input);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, url.includes("/storage/v1/object/") ? 60_000 : 30_000);
  const unsubscribe = subscribeNetworkStatus(() => {
    if (!getNetworkStatus().browserOnline) {
      connectionLost = true;
      controller.abort();
    }
  });

  // A deadline must also bound the response body, including transports that
  // ignore AbortSignal. Headers alone do not confirm a transaction outcome.
  let removeAbortListener = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      controller.signal.removeEventListener("abort", onAbort);
  });
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    response = await Promise.race([
      globalThis.fetch(input, { ...init, signal: controller.signal }),
      cancelled,
    ]);
    // Supabase endpoints in this app return finite JSON bodies. Drain a clone
    // while the deadline is live, keeping the original Response and its
    // metadata intact for the SDK to parse from the buffered body.
    reader = response.clone().body?.getReader();
    if (reader) {
      while (!(await Promise.race([reader.read(), cancelled])).done) {
        // The original branch retains the bytes for the SDK.
      }
      reader.releaseLock();
      reader = undefined;
    }
    reportNetworkSuccess(response.status);
    return response;
  } catch (error) {
    void reader?.cancel().catch(() => {});
    void response?.body?.cancel().catch(() => {});
    // Navigation/query cancellation is intentional and says nothing about WiFi.
    if (callerSignal?.aborted && !timedOut && !connectionLost) throw error;
    reportNetworkFailure();
    throw new NetworkRequestError(timedOut);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    removeAbortListener();
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
};
