/**
 * tetAmbient.ts — the drifting-petal layer that keeps the whole app feeling
 * alive while the Tết theme is on (DECISION: festive motion lives in the
 * seasonal layer only, never in Light/Dark business chrome).
 *
 * Design rules followed (carem-ui-craft):
 *  - transform/opacity only, GPU-composited, no canvas loop for a layer that
 *    stays on all shift: 12 CSS keyframe petals cost less than one LED blink;
 *  - decorative only: fixed, pointer-events:none, low z-index, small and
 *    translucent so nothing is ever covered or blocked;
 *  - respects prefers-reduced-motion and the <=1000px "no big overlays" rule;
 *  - idempotent: applySeasonalTheme() may run on every AUTO tick.
 */

const AMBIENT_ID = "tet-ambient";
const PETAL_COUNT = 12;

function spawn(doc: Document) {
  if (doc.getElementById(AMBIENT_ID)) return;
  const layer = doc.createElement("div");
  layer.id = AMBIENT_ID;
  layer.className = "tet-ambient";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < PETAL_COUNT; i++) {
    // Outer span falls top→bottom; inner span sways — two composed transforms
    // read as a real petal on the wind instead of a dead straight drop.
    const fall = doc.createElement("span");
    fall.className = "tet-petal-fall";
    fall.style.setProperty("--dur", `${(11 + Math.random() * 9).toFixed(2)}s`);
    // Negative delay starts every petal mid-flight, so the scene is already
    // drifting the moment the theme turns on.
    fall.style.setProperty("--delay", `${(-Math.random() * 20).toFixed(2)}s`);
    fall.style.setProperty("--sway", `${(4 + Math.random() * 8).toFixed(2)}vw`);
    const petal = doc.createElement("span");
    petal.className = `tet-petal ${
      Math.random() < 0.55 ? "tet-petal--mai" : "tet-petal--dao"
    }`;
    petal.style.setProperty("--s", `${(0.55 + Math.random() * 0.75).toFixed(2)}`);
    petal.style.left = `${(3 + Math.random() * 94).toFixed(2)}vw`;
    fall.appendChild(petal);
    layer.appendChild(fall);
  }
  doc.body.appendChild(layer);
}

/** Called by seasonalTheme on every attribute write — syncs the layer to the look. */
export function setTetAmbient(on: boolean) {
  try {
    const doc = globalThis.document;
    if (!doc?.body) return;
    const existing = doc.getElementById(AMBIENT_ID);
    if (!on) {
      existing?.remove();
      return;
    }
    if (existing) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if ((globalThis.innerWidth ?? 1280) <= 1000) return;
    spawn(doc);
  } catch {
    /* decoration must never break the app */
  }
}
