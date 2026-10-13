import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let network: typeof import("@/lib/networkStatus");
let browser: EventTarget;
let navigatorState: { onLine: boolean };
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  browser = new EventTarget();
  navigatorState = { onLine: true };
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("navigator", navigatorState);
  vi.stubGlobal("fetch", fetchMock);
  network = await import("@/lib/networkStatus");
});

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function install() {
  const stop = network.installNetworkMonitor("https://carem.example/", "anon-key");
  cleanups.push(stop);
  return stop;
}

function setBrowserOnline(online: boolean) {
  navigatorState.onLine = online;
  browser.dispatchEvent(new Event(online ? "online" : "offline"));
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("centralized connection recovery", () => {
  it("uses an authenticated observable HEAD check and shares concurrent retries", async () => {
    const response = deferredResponse();
    fetchMock.mockReturnValue(response.promise);
    install();
    const first = network.retryConnection();
    const second = network.retryConnection();
    expect(network.getNetworkStatus().checking).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://carem.example/auth/v1/health", {
      method: "HEAD",
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      headers: { apikey: "anon-key", Authorization: "Bearer anon-key" },
      signal: expect.any(AbortSignal),
    });
    response.resolve(new Response(null, { status: 200 }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(network.getNetworkStatus().checking).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not announce recovery on the browser event until a server response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const onOffline = vi.fn();
    const onOnline = vi.fn();
    network.setNetworkCallbacks({ onOffline, onOnline });
    install();
    await network.retryConnection();
    setBrowserOnline(false);
    const offlineSince = network.getNetworkStatus().offlineSince;
    const response = deferredResponse();
    fetchMock.mockReturnValue(response.promise);
    setBrowserOnline(true);
    expect(network.isOnline()).toBe(false);
    expect(network.getNetworkStatus().offlineSince).toBe(offlineSince);
    expect(onOnline).not.toHaveBeenCalled();
    response.resolve(new Response(null, { status: 200 }));
    await network.retryConnection();
    expect(network.isOnline()).toBe(true);
    expect(onOffline).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenCalledTimes(1);
    await network.retryConnection();
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it("distinguishes reachable authentication errors from backend outages", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    install();
    await network.retryConnection();
    expect(network.getNetworkStatus()).toMatchObject({
      online: true,
      serverReachable: true,
      serviceStatus: "unauthorized",
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await network.retryConnection()).toBe(false);
    expect(network.getNetworkStatus()).toMatchObject({
      serverReachable: true,
      serviceStatus: "unavailable",
    });
    network.reportNetworkSuccess(200);
    expect(network.isOnline()).toBe(false);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await network.retryConnection()).toBe(true);
  });

  it("ignores isolated application 500s but blocks gateway failures", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    install();
    await network.retryConnection();
    network.reportNetworkSuccess(500);
    expect(network.isOnline()).toBe(true);
    network.reportNetworkSuccess(502);
    expect(network.getNetworkStatus()).toMatchObject({
      online: false,
      serverReachable: true,
      serviceStatus: "unavailable",
    });
  });

  it("falls back to a read only GET when HEAD is unsupported", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    install();
    await network.retryConnection();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
  });

  it("bounds hanging requests and adaptively retries without overlap", async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    install();
    const retry = network.retryConnection();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await retry).toBe(false);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(network.getNetworkStatus().checking).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels old probes so late responses cannot overwrite an offline event", async () => {
    const response = deferredResponse();
    fetchMock.mockReturnValue(response.promise);
    install();
    const pending = network.retryConnection();
    setBrowserOnline(false);
    expect(await pending).toBe(false);
    response.resolve(new Response(null, { status: 200 }));
    await Promise.resolve();
    expect(network.isOnline()).toBe(false);
    expect(network.getNetworkStatus().checking).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires a fresh probe even after an older request succeeds", async () => {
    const oldProbe = deferredResponse();
    fetchMock.mockReturnValue(oldProbe.promise);
    install();
    const pending = network.retryConnection();
    network.reportNetworkFailure();
    network.reportNetworkSuccess(200);
    expect(await pending).toBe(false);
    oldProbe.resolve(new Response(null, { status: 200 }));
    await Promise.resolve();
    expect(network.isOnline()).toBe(false);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await network.retryConnection()).toBe(true);
  });

  it("shares installations and cleans timers, listeners and requests on final cleanup", async () => {
    const response = deferredResponse();
    fetchMock.mockReturnValue(response.promise);
    const firstStop = install();
    const secondStop = install();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    firstStop();
    firstStop();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    secondStop();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    response.resolve(new Response(null, { status: 503 }));
    await Promise.resolve();
    expect(network.isOnline()).toBe(true);
    browser.dispatchEvent(new Event("offline"));
    expect(network.isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never promotes an outage on browser events or old requests without a probe", () => {
    cleanups.push(network.installNetworkMonitor());
    setBrowserOnline(false);
    setBrowserOnline(true);
    network.reportNetworkSuccess(200);
    expect(network.isOnline()).toBe(false);
  });

  it("starts offline without probing and verifies immediately when focused online", async () => {
    navigatorState.onLine = false;
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    install();
    expect(network.getNetworkStatus()).toMatchObject({
      browserOnline: false,
      online: false,
      checking: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    navigatorState.onLine = true;
    browser.dispatchEvent(new Event("focus"));
    expect(network.isOnline()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await network.retryConnection()).toBe(true);
  });

  it("cannot let a disposed lifecycle overwrite a newly installed monitor", async () => {
    const oldResponse = deferredResponse();
    fetchMock.mockReturnValueOnce(oldResponse.promise);
    const stop = install();
    stop();
    const newResponse = deferredResponse();
    fetchMock.mockReturnValueOnce(newResponse.promise);
    install();
    const current = network.retryConnection();
    oldResponse.resolve(new Response(null, { status: 503 }));
    await Promise.resolve();
    expect(network.getNetworkStatus()).toMatchObject({
      online: true,
      checking: true,
      serviceStatus: "checking",
    });
    newResponse.resolve(new Response(null, { status: 200 }));
    expect(await current).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });
});
