/**
 * Seasonal theme (Tết 2027) — client contract.
 *
 * The server decides who may write the configuration (tests/db covers that). This
 * suite covers the things the browser can get wrong on its own:
 *   1. activation math, including the shop's calendar day rather than the device's;
 *   2. the festive layer writing ONLY `data-seasonal`, never `data-theme`, so the
 *      existing Light/Dark choice survives untouched;
 *   3. the offline contract: cached configuration, no request, no crash;
 *   4. live delivery: the Realtime change invalidates the shared query, and the
 *      app-wide observer is what turns that into an actual refetch;
 *   5. the sign-in re-read (the app never reloads after a login);
 *   6. AUTO re-checks while a tab stays open across the window boundary;
 *   7. the cinematic opener's local-only gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const rpc = vi.hoisted(() => vi.fn());
const channel = vi.hoisted(() => vi.fn());
const removeChannel = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  handlers: [] as ((event: string, session: unknown) => void)[],
  session: { user: { id: "tester" } } as unknown,
}));
vi.mock("@/lib/supabase", () => ({
  isConfigured: true,
  supabase: {
    rpc,
    channel,
    removeChannel,
    auth: {
      getSession: () => Promise.resolve({ data: { session: authState.session } }),
      onAuthStateChange: (handler: (event: string, session: unknown) => void) => {
        authState.handlers.push(handler);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authState.handlers = [];
              },
            },
          },
        };
      },
    },
  },
}));

import {
  applySeasonalTheme,
  cinematicDisabledOnDevice,
  cinematicSeenThisSession,
  cinematicShouldRun,
  fetchSeasonalTheme,
  installSeasonalTheme,
  isSeasonalActive,
  markCinematicSeenThisSession,
  normalizeSeasonalTheme,
  readSeasonalCache,
  seasonalPreview,
  setCinematicDisabledOnDevice,
  setSeasonalPreview,
  SEASONAL_THEME_QUERY_KEY,
  vietnamToday,
  type SeasonalTheme,
} from "@/lib/seasonalTheme";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

const theme = (overrides: Partial<SeasonalTheme> = {}): SeasonalTheme => ({
  mode: "DEFAULT",
  tet_start: null,
  tet_end: null,
  cinematic_enabled: false,
  is_active: false,
  updated_at: null,
  ...overrides,
});

let local: ReturnType<typeof memoryStorage>;
let session: ReturnType<typeof memoryStorage>;
let html: { dataset: Record<string, string> };
let listeners: Record<string, (() => void)[]>;

function stubBrowser(online = true) {
  local = memoryStorage();
  session = memoryStorage();
  html = { dataset: { theme: "dark" } };
  listeners = {};
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("document", { documentElement: html });
  vi.stubGlobal("navigator", { onLine: online });
  vi.stubGlobal("window", {
    addEventListener: (type: string, handler: () => void) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== handler);
    },
    // The AUTO ticker only needs the handles to exist; the stub keeps them inert.
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
}

beforeEach(() => {
  authState.session = { user: { id: "tester" } };
  stubBrowser();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("activation math", () => {
  it("keeps DEFAULT off and TET_2027 on regardless of dates", () => {
    expect(isSeasonalActive(theme(), "2027-02-16")).toBe(false);
    expect(isSeasonalActive(theme({ mode: "TET_2027" }), "2026-01-01")).toBe(true);
  });

  it("opens AUTO only inside the OWNER window, inclusive on both days", () => {
    const auto = theme({ mode: "AUTO", tet_start: "2027-02-01", tet_end: "2027-02-20" });
    expect(isSeasonalActive(auto, "2027-01-31")).toBe(false);
    expect(isSeasonalActive(auto, "2027-02-01")).toBe(true);
    expect(isSeasonalActive(auto, "2027-02-20")).toBe(true);
    expect(isSeasonalActive(auto, "2027-02-21")).toBe(false);
  });

  it("treats an incomplete AUTO window as off instead of guessing dates", () => {
    expect(isSeasonalActive(theme({ mode: "AUTO", tet_start: "2027-02-01" }), "2027-02-10")).toBe(false);
    expect(isSeasonalActive(theme({ mode: "AUTO" }), "2027-02-10")).toBe(false);
  });

  it("uses the shop calendar, not the device date, for the boundary", () => {
    // 17:00 UTC is already the next day in Asia/Ho_Chi_Minh.
    expect(vietnamToday(new Date("2027-02-16T17:00:00Z"))).toBe("2027-02-17");
    expect(vietnamToday(new Date("2027-02-16T16:59:59Z"))).toBe("2027-02-16");
    const closingTonight = theme({ mode: "AUTO", tet_start: "2027-02-10", tet_end: "2027-02-16" });
    expect(isSeasonalActive(closingTonight, vietnamToday(new Date("2027-02-16T17:30:00Z")))).toBe(false);
  });

  it("ignores a stale is_active flag once the window has closed", () => {
    const stale = normalizeSeasonalTheme({
      mode: "AUTO", tet_start: "2027-01-01", tet_end: "2027-01-05", is_active: true,
    });
    expect(stale.is_active).toBe(true);
    expect(isSeasonalActive(stale, "2027-03-01")).toBe(false);
  });

  it("falls back to the ordinary interface on any unexpected shape", () => {
    for (const garbage of [null, undefined, "tet", 42, {}, { mode: "tet" }, { mode: 1 }, { mode: ["TET_2027"] }]) {
      const normalized = normalizeSeasonalTheme(garbage);
      expect(normalized.mode).toBe("DEFAULT");
      expect(isSeasonalActive(normalized)).toBe(false);
    }
    // A usable mode with an unusable date keeps the mode and loses the date.
    const halfBad = normalizeSeasonalTheme({ mode: "TET_2027", tet_start: 20270210 });
    expect(halfBad.mode).toBe("TET_2027");
    expect(halfBad.tet_start).toBeNull();
    expect(normalizeSeasonalTheme({ mode: "AUTO", tet_start: "16/02/2027" }).tet_start).toBeNull();
    expect(normalizeSeasonalTheme({ mode: "TET_2027", cinematic_enabled: "true" }).cinematic_enabled).toBe(false);
  });
});

describe("attribute application", () => {
  it("writes only data-seasonal and leaves the Light/Dark attribute alone", () => {
    expect(applySeasonalTheme(theme({ mode: "TET_2027" }))).toBe("tet");
    expect(html.dataset.seasonal).toBe("tet");
    expect(html.dataset.theme).toBe("dark");
    expect(applySeasonalTheme(theme())).toBe("default");
    expect(html.dataset.seasonal).toBe("default");
    expect(html.dataset.theme).toBe("dark");
  });

  it("caches the pre-paint hints so a refresh keeps the mode", () => {
    applySeasonalTheme(theme({ mode: "AUTO", tet_start: "2020-01-01", tet_end: "2099-01-01", cinematic_enabled: true }));
    expect(local.values.get("xe-seasonal")).toBe("tet");
    expect(local.values.get("xe-seasonal-cine")).toBe("1");
    applySeasonalTheme(theme({ mode: "AUTO", tet_start: "2020-01-01", tet_end: "2099-01-01", cinematic_enabled: true }));
    // A closed window never lets the cinematic layer in either.
    applySeasonalTheme(theme({ mode: "DEFAULT", cinematic_enabled: true }));
    expect(local.values.get("xe-seasonal")).toBe("default");
    expect(local.values.get("xe-seasonal-cine")).toBe("0");
  });

  it("keeps the OWNER preview on this device only, and never past the session", () => {
    setSeasonalPreview("on");
    expect(seasonalPreview()).toBe("on");
    expect(applySeasonalTheme(theme())).toBe("tet");
    setSeasonalPreview("off");
    expect(applySeasonalTheme(theme({ mode: "TET_2027" }))).toBe("default");
    setSeasonalPreview(null);
    expect(seasonalPreview()).toBeNull();
    expect(applySeasonalTheme(theme({ mode: "TET_2027" }))).toBe("tet");
    expect(local.values.has("xe-seasonal-preview")).toBe(false);
  });
});

describe("offline contract", () => {
  it("serves the cached configuration without touching the network", async () => {
    stubBrowser(false);
    local.values.set("xe-seasonal-config", JSON.stringify(theme({ mode: "TET_2027" })));
    const result = await fetchSeasonalTheme();
    expect(rpc).not.toHaveBeenCalled();
    expect(result.mode).toBe("TET_2027");
    expect(applySeasonalTheme(result)).toBe("tet");
  });

  it("skips the read while anonymous: the login page never earns a 401", async () => {
    authState.session = null;
    local.values.set("xe-seasonal-config", JSON.stringify(theme({ mode: "TET_2027" })));
    const result = await fetchSeasonalTheme();
    expect(rpc).not.toHaveBeenCalled();
    expect(result.mode).toBe("TET_2027");
  });

  it("starts clean when nothing was ever cached", async () => {
    stubBrowser(false);
    expect(readSeasonalCache()).toBeNull();
    expect(await fetchSeasonalTheme()).toMatchObject({ mode: "DEFAULT" });
  });

  it("keeps the last known look when the request fails, and drops a corrupt cache", async () => {
    local.values.set("xe-seasonal-config", JSON.stringify(theme({ mode: "AUTO", tet_start: "2027-02-01", tet_end: "2099-01-01" })));
    rpc.mockRejectedValue(new Error("boom"));
    const result = await fetchSeasonalTheme();
    expect(result.mode).toBe("AUTO");
    local.values.set("xe-seasonal-config", "{not json");
    expect(readSeasonalCache()).toBeNull();
    expect(local.values.has("xe-seasonal-config")).toBe(false);
  });

  it("writes the fresh configuration into the cache on success", async () => {
    rpc.mockResolvedValue({ data: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: true, is_active: true }, error: null });
    const result = await fetchSeasonalTheme();
    expect(rpc).toHaveBeenCalledWith("get_seasonal_theme", {});
    expect(result).toMatchObject({ mode: "TET_2027", cinematic_enabled: true });
    expect(JSON.parse(local.values.get("xe-seasonal-config")!).mode).toBe("TET_2027");
  });
});

describe("live delivery", () => {
  function fakeChannel(handlers: ((payload: unknown) => void)[]) {
    const instance = {
      on: (_type: string, _filter: unknown, handler: (payload: unknown) => void) => {
        handlers.push(handler);
        return instance;
      },
      subscribe: () => instance,
    };
    return instance;
  }

  it("subscribes to the config table and refetches when the OWNER saves", async () => {
    rpc.mockResolvedValue({ data: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: false, is_active: true }, error: null });
    const handlers: ((payload: unknown) => void)[] = [];
    channel.mockReturnValue(fakeChannel(handlers));
    const client = new QueryClient();
    const stop = installSeasonalTheme(client);

    expect(channel).toHaveBeenCalled();
    expect(handlers).toHaveLength(1);
    await vi.waitFor(() => expect(html.dataset.seasonal).toBe("tet"));

    const invalidate = vi.spyOn(client, "invalidateQueries");
    handlers[0]({ eventType: "UPDATE", new: { mode: "DEFAULT" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: SEASONAL_THEME_QUERY_KEY });

    stop();
    expect(removeChannel).toHaveBeenCalledTimes(1);
    expect(listeners.online ?? []).toHaveLength(0);
    expect(html.dataset.theme).toBe("dark");
  });

  it("flips an open tab when the AUTO window closes behind it", async () => {
    vi.useFakeTimers();
    // Inside the window: 2020-01-02 23:00 in the shop, which is the closing day.
    vi.setSystemTime(new Date("2020-01-02T16:00:00Z"));
    rpc.mockResolvedValue({
      data: { mode: "AUTO", tet_start: "2020-01-01", tet_end: "2020-01-02", cinematic_enabled: false, is_active: true },
      error: null,
    });
    let tick: () => void = () => {};
    vi.stubGlobal("window", {
      ...globalThis.window,
      setInterval: (fn: () => void) => { tick = fn; return 1; },
      clearInterval: () => undefined,
    });
    const client = new QueryClient();
    await client.fetchQuery({ queryKey: SEASONAL_THEME_QUERY_KEY, queryFn: fetchSeasonalTheme });
    const stop = installSeasonalTheme(client);
    expect(html.dataset.seasonal).toBe("tet");

    // Past midnight, still 2020-01-03 in the shop: the window has closed and the
    // server never sent anything new — the local tick is what re-applies it.
    vi.setSystemTime(new Date("2020-01-02T17:30:00Z"));
    tick();
    expect(html.dataset.seasonal).toBe("default");
    stop();
  });

  it("keeps the query observed so a pushed save really refetches", async () => {
    rpc.mockResolvedValue({ data: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: false, is_active: true }, error: null });
    const handlers: ((payload: unknown) => void)[] = [];
    channel.mockReturnValue(fakeChannel(handlers));
    const client = new QueryClient();
    const stop = installSeasonalTheme(client);
    await vi.waitFor(() => expect(html.dataset.seasonal).toBe("tet"));

    // Invalidating an unobserved query fetches nothing. The app-wide observer is
    // what makes delivery reach a MANAGER's tablet that never opened the card.
    const readsBefore = rpc.mock.calls.length;
    handlers[0]({ eventType: "UPDATE", new: { mode: "DEFAULT" } });
    await vi.waitFor(() => expect(rpc.mock.calls.length).toBe(readsBefore + 1));

    stop();
    expect(rpc.mock.calls.length).toBe(readsBefore + 1); // quiet after teardown
  });

  it("re-reads the shared configuration on sign-in", async () => {
    // Boot is unauthenticated: the read can only answer "ordinary interface".
    rpc.mockResolvedValue({ data: { mode: "DEFAULT", tet_start: null, tet_end: null, cinematic_enabled: false, is_active: false }, error: null });
    const handlers: ((payload: unknown) => void)[] = [];
    channel.mockReturnValue(fakeChannel(handlers));
    const client = new QueryClient();
    const stop = installSeasonalTheme(client);
    expect(authState.handlers).toHaveLength(1);
    // Let the boot read settle: a refetch requested while it is still in flight is
    // deduped into that same request, and this test has to count the next one.
    await vi.waitFor(() =>
      expect(
        client.getQueryCache().find({ queryKey: SEASONAL_THEME_QUERY_KEY })
          ?.state.data,
      ).toBeDefined(),
    );
    expect(html.dataset.seasonal).toBe("default");

    // The app does not reload after a login, so this transition is the re-read.
    rpc.mockResolvedValue({ data: { mode: "TET_2027", tet_start: null, tet_end: null, cinematic_enabled: false, is_active: true }, error: null });
    const beforeAuth = rpc.mock.calls.length;
    authState.handlers[0]("SIGNED_IN", { user: { id: "u" } });
    await vi.waitFor(() => expect(html.dataset.seasonal).toBe("tet"));
    expect(rpc.mock.calls.length).toBeGreaterThan(beforeAuth);

    // A signed-out event carries no session and must not trigger anything.
    const reads = rpc.mock.calls.length;
    authState.handlers[0]("SIGNED_OUT", null);
    expect(rpc.mock.calls.length).toBe(reads);

    stop();
    expect(authState.handlers).toHaveLength(0);
  });
});

describe("cinematic opening gate", () => {
  const tet = theme({ mode: "TET_2027", cinematic_enabled: true, is_active: true });

  it("only wants to play when the OWNER switch is on and the Tet look is showing", () => {
    expect(cinematicShouldRun(tet)).toBe(true);
    // Switch off, or Tet not actually active, means not a single byte of the engine.
    expect(cinematicShouldRun(theme({ mode: "TET_2027", is_active: true }))).toBe(false);
    expect(cinematicShouldRun(theme({ cinematic_enabled: true }))).toBe(false);
    expect(cinematicShouldRun(undefined)).toBe(false);
  });

  it("keeps the per-device opt-out and the once-per-session claim local", () => {
    expect(cinematicDisabledOnDevice()).toBe(false);
    setCinematicDisabledOnDevice(true);
    expect(cinematicShouldRun(tet)).toBe(false);
    setCinematicDisabledOnDevice(false);
    expect(cinematicShouldRun(tet)).toBe(true);

    expect(cinematicSeenThisSession()).toBe(false);
    markCinematicSeenThisSession();
    expect(cinematicSeenThisSession()).toBe(true);
    // The claim must never leak into the pre-paint localStorage hints.
    expect(local.values.has("xe-seasonal-cine-seen")).toBe(false);
  });
});
