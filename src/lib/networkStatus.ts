import { useSyncExternalStore } from "react";

/** Connectivity is shared by the banner, API preflight and query scheduling. */
export type NetworkState = {
  browserOnline: boolean;
  /** Any observable HTTP response proves reachability, including auth errors. */
  serverReachable: boolean | null;
  /** False while disconnected or the shared backend is unavailable. */
  online: boolean;
  offlineSince: number;
  consecutiveFailures: number;
  checking: boolean;
  serviceStatus: "checking" | "available" | "unauthorized" | "unavailable";
};

const browserIsOnline = () =>
  typeof navigator === "undefined" || navigator.onLine !== false;
const initiallyOnline = browserIsOnline();
let state: NetworkState = {
  browserOnline: initiallyOnline,
  serverReachable: initiallyOnline ? null : false,
  online: initiallyOnline,
  offlineSince: initiallyOnline ? 0 : Date.now(),
  consecutiveFailures: 0,
  checking: false,
  serviceStatus: "checking",
};

const listeners = new Set<() => void>();
export function subscribeNetworkStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => state;
type Callbacks = {
  onOffline?: () => void;
  /** Refresh reads only. Never replay a failed or paused transaction. */
  onOnline?: () => void;
  toastWarning?: (title: string, opts?: { description?: string }) => void;
  toastSuccess?: (title: string, opts?: { description?: string }) => void;
};
let callbacks: Callbacks = {};
export function setNetworkCallbacks(next: Callbacks) {
  callbacks = next;
}

function updateState(patch: Partial<NetworkState>) {
  const previous = state;
  state = { ...state, ...patch };
  state.online =
    state.browserOnline &&
    state.serverReachable !== false &&
    state.serviceStatus !== "unavailable";
  if (previous.online && !state.online) {
    state.offlineSince = Date.now();
    callbacks.onOffline?.();
    callbacks.toastWarning?.(
      state.serverReachable && state.serviceStatus === "unavailable"
        ? "Máy chủ tạm thời gián đoạn"
        : "Mất kết nối mạng",
      {
        description:
          "Tạm dừng gửi giao dịch. Giữ màn hình đang nhập và kiểm tra kết quả trước khi gửi lại.",
      },
    );
  } else if (!previous.online && state.online) {
    state.offlineSince = 0;
    state.consecutiveFailures = 0;
    callbacks.onOnline?.();
    callbacks.toastSuccess?.("Đã kết nối trở lại", {
      description:
        "Dữ liệu đang được cập nhật. Giao dịch chưa rõ kết quả cần được kiểm tra trước khi gửi lại.",
    });
  }
  for (const listener of listeners) listener();
}

const PROBE_TIMEOUT_MS = 6_000;
const STABLE_INTERVAL_MS = 30_000;
const RECOVERY_INTERVALS_MS = [2_000, 4_000, 8_000, 15_000];
let timer: ReturnType<typeof setTimeout> | null = null;
let heartbeatUrl: string | null = null;
let heartbeatKey: string | undefined;
let monitorUsers = 0;
type Probe = {
  controller: AbortController;
  promise: Promise<boolean>;
  timeout: ReturnType<typeof setTimeout> | null;
};
let activeProbe: Probe | null = null;

function clearScheduledProbe() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function cancelProbe() {
  const probe = activeProbe;
  activeProbe = null;
  if (!probe) return;
  if (probe.timeout !== null) clearTimeout(probe.timeout);
  probe.controller.abort();
}

function scheduleProbe() {
  clearScheduledProbe();
  if (!monitorUsers || !heartbeatUrl || !state.browserOnline || activeProbe)
    return;
  const interval = state.online
    ? STABLE_INTERVAL_MS
    : RECOVERY_INTERVALS_MS[
        Math.min(
          Math.max(state.consecutiveFailures - 1, 0),
          RECOVERY_INTERVALS_MS.length - 1,
        )
      ];
  timer = setTimeout(() => {
    timer = null;
    void heartbeat();
  }, interval);
}

const serviceStatusForResponse = (status: number): NetworkState["serviceStatus"] =>
  status >= 500
    ? "unavailable"
    : status === 401 || status === 403
      ? "unauthorized"
      : "available";

function heartbeat(): Promise<boolean> {
  if (activeProbe) return activeProbe.promise;
  if (!monitorUsers || !heartbeatUrl || !state.browserOnline)
    return Promise.resolve(state.online);
  clearScheduledProbe();
  const probe: Probe = {
    controller: new AbortController(),
    promise: Promise.resolve(false),
    timeout: null,
  };
  activeProbe = probe;
  updateState({ checking: true });
  const url = heartbeatUrl;
  const headers: Record<string, string> = heartbeatKey
    ? { apikey: heartbeatKey, Authorization: `Bearer ${heartbeatKey}` }
    : {};

  probe.promise = (async () => {
    const { signal } = probe.controller;
    let removeAbortListener = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(new DOMException("Connectivity check cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    probe.timeout = setTimeout(() => probe.controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const request = async () => {
        const options: RequestInit = {
          method: "HEAD",
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
          headers,
          signal,
        };
        let response = await fetch(url, options);
        // Some proxies reject HEAD. This fallback never invokes a business RPC.
        if (response.status === 405 || response.status === 501) {
          await response.body?.cancel();
          response = await fetch(url, { ...options, method: "GET" });
          void response.body?.cancel().catch(() => {});
        }
        if (response.type === "opaque" || response.status === 0)
          throw new TypeError("Connectivity response is not observable");
        return response;
      };
      const response = await Promise.race([request(), cancelled]);
      if (activeProbe === probe && monitorUsers && state.browserOnline) {
        const serviceStatus = serviceStatusForResponse(response.status);
        updateState({
          serverReachable: true,
          serviceStatus,
          consecutiveFailures:
            serviceStatus === "unavailable" ? state.consecutiveFailures + 1 : 0,
        });
      }
    } catch {
      // Cancelled old checks cannot overwrite newer evidence or a new lifecycle.
      if (activeProbe === probe && monitorUsers && state.browserOnline) {
        updateState({
          serverReachable: false,
          consecutiveFailures: state.consecutiveFailures + 1,
        });
      }
    } finally {
      removeAbortListener();
      if (probe.timeout !== null) clearTimeout(probe.timeout);
      if (activeProbe === probe) {
        activeProbe = null;
        updateState({ checking: false });
        scheduleProbe();
      }
    }
    return state.online;
  })();
  return probe.promise;
}

/** Call only for a genuine transport failure, never a caller's own abort. */
export function reportNetworkFailure() {
  cancelProbe();
  updateState({
    browserOnline: browserIsOnline(),
    serverReachable: false,
    checking: false,
    consecutiveFailures: state.consecutiveFailures + 1,
  });
  scheduleProbe();
}

/** Any HTTP response establishes transport; gateway outages block new writes. */
export function reportNetworkSuccess(status = 200) {
  if (status < 100) return;
  if ([502, 503, 504].includes(status)) {
    cancelProbe();
    updateState({
      browserOnline: browserIsOnline(),
      serverReachable: true,
      checking: false,
      serviceStatus: "unavailable",
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    scheduleProbe();
    return;
  }
  // In-flight responses from before an outage cannot reopen the write gate.
  // A fresh dedicated probe verifies recovery after every observed failure.
  if (!state.online) return;
  cancelProbe();
  updateState({
    browserOnline: browserIsOnline(),
    serverReachable: true,
    checking: false,
    serviceStatus:
      status === 401 || status === 403 ? "unauthorized" : "available",
    consecutiveFailures: 0,
  });
  scheduleProbe();
}

function onBrowserOffline() {
  clearScheduledProbe();
  cancelProbe();
  updateState({ browserOnline: false, serverReachable: false, checking: false });
}

function onBrowserOnline() {
  updateState({ browserOnline: true });
  // Keep the previous failure until the server actually answers.
  void heartbeat();
}

function onFocus() {
  if (!browserIsOnline()) {
    onBrowserOffline();
    return;
  }
  updateState({ browserOnline: true });
  void heartbeat();
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") onFocus();
}

/** Share installations and cancel all work after the last owner leaves. */
export function installNetworkMonitor(
  supabaseUrl?: string,
  anonKey?: string,
): () => void {
  if (typeof window === "undefined") return () => {};
  monitorUsers += 1;
  if (monitorUsers === 1) {
    // GoTrue health answers any anonymous probe with 200. The old `/rest/v1/` root
    // is not an RLS-protected endpoint, so publishable keys get a hard 401 there —
    // transport proved, but console noise on every load that fails smoke gates.
    heartbeatUrl = supabaseUrl
      ? `${supabaseUrl.trim().replace(/\/+$/, "")}/auth/v1/health`
      : null;
    heartbeatKey = anonKey?.trim() || undefined;
    if (!browserIsOnline()) onBrowserOffline();
    else updateState({ browserOnline: true });
    window.addEventListener("online", onBrowserOnline);
    window.addEventListener("offline", onBrowserOffline);
    window.addEventListener("focus", onFocus);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibilityChange);
    void heartbeat();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    monitorUsers -= 1;
    if (monitorUsers) return;
    window.removeEventListener("online", onBrowserOnline);
    window.removeEventListener("offline", onBrowserOffline);
    window.removeEventListener("focus", onFocus);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibilityChange);
    clearScheduledProbe();
    cancelProbe();
    heartbeatUrl = null;
    heartbeatKey = undefined;
    updateState({ checking: false });
  };
}

export function useNetworkStatus(): NetworkState {
  return useSyncExternalStore(subscribeNetworkStatus, snapshot, snapshot);
}

export function getNetworkStatus(): NetworkState {
  return state;
}

export function isOnline(): boolean {
  return state.online;
}

/** A browser event alone never confirms recovery after an outage. */
export async function retryConnection(): Promise<boolean> {
  if (!browserIsOnline()) {
    onBrowserOffline();
    return false;
  }
  updateState({ browserOnline: true });
  return heartbeat();
}

export function formatOfflineDuration(seconds: number): string {
  const duration = Math.max(0, Math.floor(seconds));
  if (duration < 60) return `${duration} giây`;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  if (mins < 60) {
    return secs > 0 ? `${mins} phút ${secs} giây` : `${mins} phút`;
  }
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs} giờ ${remainMins} phút` : `${hrs} giờ`;
}
