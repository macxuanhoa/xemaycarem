/**
 * Theme switching (light "nắng" / dark "đêm") for the workspace shell.
 * The choice is persisted per-device and applied to <html data-theme="...">.
 * index.html bootstraps the attribute before first paint to avoid a flash.
 */
export type Theme = "light" | "dark";
const STORAGE_KEY = "xe-theme";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = next;
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable (private mode or SSR) — keep the in-memory switch */
  }
  // Keep the mobile browser chrome in sync with the shell surface.
  const meta =
    typeof document === "undefined"
      ? null
      : document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", next === "dark" ? "#0b0c10" : "#12090c");
  return next;
}
