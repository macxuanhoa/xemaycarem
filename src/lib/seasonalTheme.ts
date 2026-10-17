import {
  QueryObserver,
  useQuery,
  type QueryClient,
} from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { api } from "./api";
import { setTetAmbient } from "./tetAmbient";
import { supabase } from "./supabase";

/**
 * Seasonal UI theme (Tết 2027) — a presentation layer that lives ON TOP of the
 * existing Light/Dark theme instead of replacing it.
 *
 * The app keeps owning `data-theme` (see `theme.ts`); this module only ever writes
 * the orthogonal `data-seasonal` attribute ("tet" | "default") on <html>, so
 * `src/styles-tet.css` can layer festive tokens without breaking night mode.
 *
 * The configuration itself is shared and server-side: OWNER writes it, every signed
 * in account reads the same value, and Supabase Realtime pushes a change into the
 * sessions that are already open. No rebuild, no redeploy.
 */

export type SeasonalMode = "DEFAULT" | "TET_2027" | "AUTO";

/** The value of the orthogonal `<html data-seasonal>` attribute. */
export type SeasonalAttribute = "tet" | "default";

export type SeasonalTheme = {
  mode: SeasonalMode;
  tet_start: string | null;
  tet_end: string | null;
  cinematic_enabled: boolean;
  is_active: boolean;
  updated_at?: string | null;
};

const MODES: SeasonalMode[] = ["DEFAULT", "TET_2027", "AUTO"];
const TABLE = "seasonal_theme_config";
const ATTRIBUTE = "seasonal";
const ATTRIBUTE_KEY = "xe-seasonal";
const CINEMATIC_KEY = "xe-seasonal-cine";
const CACHE_KEY = "xe-seasonal-config";
const PREVIEW_KEY = "xe-seasonal-preview";
/** AUTO is re-checked locally on this cadence so the window opens at midnight even
 *  in a tab that was already open, and even while the shop's internet is down. */
const AUTO_TICK_MS = 30_000;
/** Only a load this fresh may auto-play the cinematic opening. A session that has
 *  been open longer gets the new look silently instead of losing its screen. */
const OPENING_GRACE_MS = 2 * 60_000;

export const SEASONAL_THEME_QUERY_KEY = ["seasonal-theme"] as const;

export const FALLBACK_SEASONAL_THEME: SeasonalTheme = {
  mode: "DEFAULT",
  tet_start: null,
  tet_end: null,
  cinematic_enabled: false,
  is_active: false,
};

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function item(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function put(key: string, value: string) {
  try {
    store()?.setItem(key, value);
  } catch {
    /* A browser that refuses storage simply keeps the last painted theme. */
  }
}

function drop(key: string) {
  try {
    store()?.removeItem(key);
  } catch {
    /* nothing to clean up */
  }
}

function asDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

/** Never trust a cached or realtime payload: an unknown shape must fall back to the
 *  ordinary interface rather than crash or half-apply the festive layer. */
export function normalizeSeasonalTheme(raw: unknown): SeasonalTheme {
  if (typeof raw !== "object" || raw === null) return FALLBACK_SEASONAL_THEME;
  const value = raw as Record<string, unknown>;
  const mode = MODES.includes(value.mode as SeasonalMode)
    ? (value.mode as SeasonalMode)
    : "DEFAULT";
  const tet_start = asDate(value.tet_start);
  const tet_end = asDate(value.tet_end);
  return {
    mode,
    tet_start,
    tet_end,
    cinematic_enabled: value.cinematic_enabled === true,
    // Kept for display only. Activation is always derived from mode + window by
    // isSeasonalActive(), so a value cached before the window closed can never keep
    // the festive layer on.
    is_active: value.is_active === true,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

/** The shop's calendar day, independent of the device clock or its timezone. */
export function vietnamToday(now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    const shifted = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 10);
  }
}

/** Single source of truth for "is the festive layer on right now". */
export function isSeasonalActive(
  theme: SeasonalTheme,
  today: string = vietnamToday(),
): boolean {
  if (theme.mode === "TET_2027") return true;
  if (theme.mode !== "AUTO") return false;
  if (!theme.tet_start || !theme.tet_end) return false;
  return today >= theme.tet_start && today <= theme.tet_end;
}

/** OWNER-only, this-device-only look at the theme; it never writes to the server and
 *  is kept in sessionStorage so a different account on the same tablet is unaffected. */
export function seasonalPreview(): "on" | "off" | null {
  try {
    const value = sessionStorage.getItem(PREVIEW_KEY);
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param playCinematic Explicit "show me the opening once more" request. It is kept
 *  separate from the look preview so requirement 8 holds: the cinematic has its own
 *  switch and only a deliberate click plays it — previewing the áo Tết alone never
 *  triggers a full-screen story.
 */
export function setSeasonalPreview(mode: "on" | "off" | null, playCinematic = false) {
  try {
    if (mode === null) sessionStorage.removeItem(PREVIEW_KEY);
    else sessionStorage.setItem(PREVIEW_KEY, mode);
    // The cinematic opener listens for this so the OWNER can replay the opening on
    // demand — the once-per-session rule still governs real loads.
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function")
      window.dispatchEvent(
        new CustomEvent("xe-seasonal-preview", {
          detail: { mode, playCinematic },
        }),
      );
  } catch {
    /* private mode: the shared configuration still decides */
  }
}

/** Per-device opt-out, orthogonal to the shared server switch. The OWNER's
 *  "Cho phép màn chào Tết" decides whether the opener EXISTS; this remembers when a
 *  single person on a single machine pressed "Bỏ qua" and never wants it again. */
const CINE_PREF_KEY = "xe-seasonal-cine-off";

export function cinematicDisabledOnDevice(): boolean {
  return item(CINE_PREF_KEY) === "1";
}

export function setCinematicDisabledOnDevice(disabled: boolean) {
  put(CINE_PREF_KEY, disabled ? "1" : "0");
}

/** Once per BROWSER SESSION (not per page view): the opener tells its own story at
 *  the first festive load, then stays out of the way until the next fresh session. */
const CINE_SEEN_KEY = "xe-seasonal-cine-seen";

export function cinematicSeenThisSession(): boolean {
  try {
    return sessionStorage.getItem(CINE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markCinematicSeenThisSession() {
  try {
    sessionStorage.setItem(CINE_SEEN_KEY, "1");
  } catch {
    /* worst case the opener replays next load on a private window */
  }
}

/** Live gate for the cinematic layer: the OWNER's server switch, plus the festive
 *  layer actually being on right now. Per-session and per-device guards are applied
 *  by the opener itself. */
export function cinematicShouldRun(theme: SeasonalTheme | undefined): boolean {
  return (
    (theme?.cinematic_enabled ?? false) &&
    isSeasonalActive(theme ?? FALLBACK_SEASONAL_THEME) &&
    !cinematicDisabledOnDevice()
  );
}

export function readSeasonalCache(): SeasonalTheme | null {
  const raw = item(CACHE_KEY);
  if (!raw) return null;
  try {
    return normalizeSeasonalTheme(JSON.parse(raw));
  } catch {
    drop(CACHE_KEY);
    return null;
  }
}

function writeSeasonalCache(theme: SeasonalTheme) {
  put(CACHE_KEY, JSON.stringify(theme));
}

/** styles-tet.css asks for Playfair Display / Be Vietnam Pro, but index.html only
 *  ships the everyday fonts. Injecting the festive faces is lazy (nothing is down-
 *  loaded while the layer is off) and idempotent. Same non-blocking trick as the
 *  base stylesheet: `media="print"` keeps it out of the render path, `display=swap`
 *  means text never waits on Google. If the network refuses, the fallback stacks in
 *  styles-tet.css already look right. */
const SEASONAL_FONTS_ID = "xe-seasonal-fonts";
const SEASONAL_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,500..800;1,500..700&display=swap";

export function ensureSeasonalFonts() {
  try {
    const doc = globalThis.document;
    if (!doc?.head || doc.getElementById(SEASONAL_FONTS_ID)) return;
    const link = doc.createElement("link");
    link.id = SEASONAL_FONTS_ID;
    link.rel = "stylesheet";
    link.media = "print";
    link.onload = () => {
      link.media = "all";
    };
    link.href = SEASONAL_FONTS_URL;
    doc.head.appendChild(link);
  } catch {
    /* no DOM (tests/SSR) or a hostile browser: fallback fonts are fine */
  }
}

/** Writes the orthogonal attribute. Light/Dark (`data-theme`) is never read or touched. */
export function applySeasonalTheme(theme: SeasonalTheme): SeasonalAttribute {
  const preview = seasonalPreview();
  const active =
    preview === "on" ? true : preview === "off" ? false : isSeasonalActive(theme);
  const attribute: SeasonalAttribute = active ? "tet" : "default";
  document.documentElement.dataset[ATTRIBUTE] = attribute;
  // The pre-paint bootstrap in index.html reads these two keys on the next load, so
  // a refresh or a cold start on a broken connection keeps the last known look.
  put(ATTRIBUTE_KEY, attribute);
  put(CINEMATIC_KEY, theme.cinematic_enabled && active ? "1" : "0");
  if (attribute === "tet") ensureSeasonalFonts();
  // The drifting-petal ambient layer belongs to the festive look, so it is
  // synced here — every write of data-seasonal (load, tick, preview, realtime)
  // brings the decoration along with the theme, never ahead of it.
  setTetAmbient(attribute === "tet");
  return attribute;
}

/**
 * Session probe for the read gate below. Only a definite "no session" blocks the
 * call: a stubbed client without `getSession` (tests) or a probe that throws must
 * never strand a signed-in user on the fallback look.
 */
async function hasAuthSession(): Promise<boolean> {
  try {
    const result = await supabase?.auth?.getSession?.();
    if (!result) return true;
    return Boolean((result as { data?: { session?: unknown } }).data?.session);
  } catch {
    return true;
  }
}

/**
 * Offline-safe read. `api.call` refuses to send anything without a connection, and a
 * theme is exactly the kind of thing that must still look right when it happens.
 */
export async function fetchSeasonalTheme(): Promise<SeasonalTheme> {
  if (!supabase || !navigator.onLine) {
    return readSeasonalCache() ?? FALLBACK_SEASONAL_THEME;
  }
  // The configuration read is granted to signed-in accounts only, so an anonymous
  // visitor (the login page) would take a guaranteed 401 on every load. It keeps the
  // cached/fallback look instead until SIGNED_IN triggers the re-read in install().
  if (!(await hasAuthSession())) {
    return readSeasonalCache() ?? FALLBACK_SEASONAL_THEME;
  }
  try {
    const theme = normalizeSeasonalTheme(
      await api.call<unknown>("get_seasonal_theme"),
    );
    writeSeasonalCache(theme);
    return theme;
  } catch {
    return readSeasonalCache() ?? FALLBACK_SEASONAL_THEME;
  }
}

/** Shared by the app shell and the OWNER settings card — one query, one cache. */
export function useSeasonalTheme() {
  return useQuery({
    queryKey: SEASONAL_THEME_QUERY_KEY,
    queryFn: fetchSeasonalTheme,
    staleTime: 60_000,
    // AUTO needs a server touch now and then; the other modes only change when the
    // OWNER saves, and Realtime already covers that.
    refetchInterval: (query) =>
      query.state.data?.mode === "AUTO" ? 5 * 60_000 : false,
  });
}

/**
 * Wires the seasonal layer into a running app: initial read, live delivery for the
 * sessions that are already open, a reconnect resync, the AUTO midnight tick and the
 * cinematic opening. Returns the teardown for `import.meta.hot.dispose`.
 */
export function installSeasonalTheme(client: QueryClient): () => void {
  const current = () =>
    client.getQueryData<SeasonalTheme>(SEASONAL_THEME_QUERY_KEY) ??
    readSeasonalCache() ??
    FALLBACK_SEASONAL_THEME;

  const refresh = () =>
    void client.invalidateQueries({ queryKey: SEASONAL_THEME_QUERY_KEY });

  // The cinematic greeting is orchestrated here, not from a screen component, so it
  // really belongs to "opening the app" — including the moment right after login —
  // and the engine stays a lazy chunk until the OWNER's switch is on.
  let openedAt = Date.now();
  // A change pushed into a session that is already working is NOT an app opening:
  // nobody gets a full-screen story dropped on top of the form they are filling in.
  let openingClosed = false;
  // The engine hands back a handle, not a bare function.
  let stopOpening: { stop: () => void } | null = null;
  let playToken = 0;

  const playOpening = () => {
    // Claim the session before the engine is even downloaded: two triggers racing
    // (a late config read and a preview click) must never queue a second story.
    markCinematicSeenThisSession();
    const mine = ++playToken;
    void (async () => {
      const { playCinematicOpening } = await import("@/lib/tetCinematic");
      await import("@/styles-tet-cinematic.css");
      if (mine !== playToken) return;
      if (typeof document === "undefined" || !document.body) return;
      stopOpening = playCinematicOpening(document.body, {
        src: new URL("/tet-de-lai.png", window.location.origin).href,
        caption: "Dê Lái chở xuân về nhà — Cà Rem Tết 2027",
        onReveal: () => {
          document.documentElement.dataset[ATTRIBUTE] = "tet";
        },
        onNever: () => setCinematicDisabledOnDevice(true),
      });
    })().catch(() => {
      /* decoration must never break the app; the Tet look still applies */
    });
  };

  const maybePlay = () => {
    try {
      if (typeof document === "undefined" || !document.body) return;
      // Only a genuine "opening of the app" may auto-play: a session that has been
      // running, or one into which the OWNER's save was pushed, takes the new look
      // silently instead of losing its screen.
      if (openingClosed || Date.now() - openedAt > OPENING_GRACE_MS) return;
      // The OWNER's "Giao diện thường" preview also keeps the story off this device.
      if (seasonalPreview() === "off") return;
      if (!cinematicShouldRun(current())) return;
      if (cinematicSeenThisSession() || cinematicDisabledOnDevice()) return;
      playOpening();
    } catch {
      /* never let decoration break the business screens */
    }
  };

  // Explicit replay from the OWNER's settings card. Previewing the áo Tết alone
  // never summons the story: only this deliberate request does (requirement 8).
  const onPreview = (event: Event) => {
    const detail = (
      event as CustomEvent<{ mode: "on" | "off" | null; playCinematic?: boolean }>
    ).detail;
    if (detail?.mode !== "on" || !detail.playCinematic) return;
    if (!current().cinematic_enabled) return;
    // A click is fresh intent: it clears this device's earlier "Không chiếu nữa",
    // which still governs ordinary loads.
    setCinematicDisabledOnDevice(false);
    stopOpening?.stop();
    stopOpening = null;
    playOpening();
  };
  window.addEventListener("xe-seasonal-preview", onPreview);

  // TanStack only refetches an invalidated query while something observes it, and a
  // MANAGER's tablet may never open the settings card — so this app-wide observer is
  // what actually delivers the OWNER's save into the sessions that are already open.
  const observer = new QueryObserver(client, {
    queryKey: SEASONAL_THEME_QUERY_KEY,
    queryFn: fetchSeasonalTheme,
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.data?.mode === "AUTO" ? 5 * 60_000 : false,
  });
  const release = observer.subscribe((state) => {
    if (!state.data) return;
    applySeasonalTheme(state.data);
    maybePlay();
  });

  // Cached look first: a refresh or a cold start on a broken connection must not
  // flash the ordinary interface while the read is still in flight.
  applySeasonalTheme(current());
  maybePlay();

  let channel: RealtimeChannel | null = null;
  // A pushed configuration change closes the opening phase for this session: the
  // look updates, the story does not hijack whoever is mid-task at that moment.
  const onConfigChange = () => {
    openingClosed = true;
    refresh();
  };
  if (supabase) {
    channel = supabase
      .channel(`seasonal-theme:${TABLE}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: TABLE },
        onConfigChange,
      )
      .subscribe();
  }

  // install() runs before anyone has signed in and the app never reloads after a
  // login, so SIGNED_IN is both the first moment the read can succeed and the real
  // "the app just opened" instant for the greeting. A token refresh mid-shift only
  // re-reads the configuration — it must never re-open the greeting window.
  const authListener = supabase?.auth?.onAuthStateChange?.((event, session) => {
    if (!session) return;
    if (event === "SIGNED_IN") {
      openedAt = Date.now();
      openingClosed = false;
    }
    refresh();
  });

  const onOnline = () => refresh();
  window.addEventListener("online", onOnline);
  window.addEventListener("focus", onOnline);

  // A tab that stayed open across midnight must flip with the shop's calendar, and
  // it has to do that even when the connection is gone.
  const tick = window.setInterval(() => {
    if (current().mode === "AUTO") applySeasonalTheme(current());
  }, AUTO_TICK_MS);

  return () => {
    window.clearInterval(tick);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("focus", onOnline);
    window.removeEventListener("xe-seasonal-preview", onPreview);
    authListener?.data.subscription.unsubscribe();
    release();
    ++playToken;
    stopOpening?.stop();
    if (channel && supabase) void supabase.removeChannel(channel);
  };
}
