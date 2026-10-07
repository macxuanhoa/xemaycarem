// Run against an isolated local server. `before` must use the retained checkpoint.
// Example: node scripts/capture-uiux.mjs before chromium http://127.0.0.1:4198
import { chromium, webkit } from "@playwright/test";
import fs from "node:fs/promises";
import {
  installUiuxMock,
  vehicleId,
  saleId,
} from "../tests/helpers/uiux-fixtures.mjs";
const phase = process.argv[2] ?? "after",
  engine = process.argv[3] ?? "chromium";
const base = process.argv[4] ?? "http://127.0.0.1:4197";
if (!["127.0.0.1", "localhost"].includes(new URL(base).hostname))
  throw new Error("Capture requires loopback URL");
const out = `backups/uiux-evidence/${phase}-${engine}`;
await fs.mkdir(out, { recursive: true });
const browser = await (engine === "webkit" ? webkit : chromium).launch();
const rows = [];
const routes = [
  "/",
  "/vehicles",
  `/vehicles/${vehicleId}`,
  `/vehicles/${vehicleId}/sell`,
  `/sales/${saleId}`,
  "/sell",
  "/acquisitions",
  "/acquisitions/new",
  "/intake",
  "/copilot",
  "/sales",
  "/receivables",
  "/customers",
  "/expenses",
  "/users",
  "/audit",
  "/settings",
  "/docs",
  "/capture",
  "/assist",
  "/showroom",
];
const changed = [
  `/vehicles/${vehicleId}`,
  `/vehicles/${vehicleId}/sell`,
  "/acquisitions",
  "/acquisitions/new",
  "/intake",
  "/copilot",
];
async function setup(width, options = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    hasTouch: width < 768,
    serviceWorkers: "block",
  });
  const page = await context.newPage(),
    errors = [];
  const fixture = await installUiuxMock(page, options);
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, context, errors, ...fixture };
}
async function open(page, path) {
  await page.goto(`${base}${path}`);
  await page.getByRole("heading").first().waitFor({ timeout: 12000 });
  if (path === "/copilot") {
    await page
      .getByLabel("Bạn muốn hỏi gì về cửa hàng?")
      .fill("Tồn kho bao nhiêu?");
    await page.getByRole("button", { name: "Hỏi Cà Rem", exact: true }).click();
    await page.locator(".copilot-answer-card").waitFor();
  }
  if (path === "/intake") {
    await page
      .getByLabel("Ghi chú tốc ký danh sách xe cần thu")
      .fill("sh den 29b1 123.45 21 gia 18tr5");
    await page
      .getByRole("button", { name: "Tách thành danh sách", exact: true })
      .click();
    await page.locator(".intake-entry").waitFor();
  }
  await page.waitForTimeout(150);
}
async function capture(state, name, fullPage = true) {
  const { page } = state;
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => ({
    viewport: innerWidth,
    viewportHeight: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    activeNav: [
      ...document.querySelectorAll(
        '.bottom-nav a[aria-current]:not([aria-current="false"])',
      ),
    ].map((x) => x.textContent.trim()),
    unlabeledInputs: [
      ...document.querySelectorAll(
        'input:not([type="hidden"]):not([aria-hidden="true"]),textarea,select',
      ),
    ]
      .filter(
        (x) =>
          x.getClientRects().length &&
          !x.labels?.length &&
          !x.getAttribute("aria-label") &&
          !x.getAttribute("aria-labelledby"),
      )
      .map((x) => x.name || x.className),
    visibleViewport: window.visualViewport
      ? { top: visualViewport.offsetTop, height: visualViewport.height }
      : null,
  }));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage });
  rows.push({
    name,
    ...metrics,
    errors: [...state.errors],
    writes: [...state.writes],
  });
}
try {
  for (const width of [320, 360, 375, 390, 430, 1440]) {
    const state = await setup(width);
    for (const path of routes) {
      state.errors.length = 0;
      await open(state.page, path);
      await capture(
        state,
        `${width}-${path.replaceAll("/", "_") || "dashboard"}`,
      );
    }
    await open(state.page, "/vehicles");
    const opener = state.page.getByRole("button", {
      name: "Tìm xe toàn hệ thống",
      exact: true,
    });
    if (await opener.isVisible().catch(() => false)) await opener.click();
    await state.page
      .locator('input[aria-label="Tìm xe toàn hệ thống"]:visible')
      .fill("Vision");
    await state.page.waitForTimeout(350);
    await capture(state, `${width}-search`, false);
    if (width === 390) {
      await state.page.setViewportSize({ width, height: 450 });
      await capture(state, "390-search-short-viewport-simulation", false);
    }
    await state.context.close();
    const login = await setup(width, { anonymous: true });
    await open(login.page, "/login");
    await capture(login, `${width}-login`);
    await login.context.close();
  }
  for (const [label, options] of [
    ["long", { long: true }],
    ["dark", { theme: "dark", long: true }],
    ["empty", { empty: true }],
  ]) {
    const state = await setup(390, options);
    for (const path of changed) {
      await open(state.page, path);
      await capture(state, `390-${label}-${path.replaceAll("/", "_")}`);
    }
    await state.context.close();
  }
} finally {
  await browser.close();
}
await fs.writeFile(`${out}/measurements.json`, JSON.stringify(rows, null, 2));
console.log(
  JSON.stringify(
    {
      captures: rows.length,
      overflow: rows.filter((x) => x.scrollWidth > x.viewport),
      errors: rows.filter((x) => x.errors.length),
      writes: rows.filter((x) => x.writes.length),
      unlabeled: rows.filter((x) => x.unlabeledInputs.length),
    },
    null,
    2,
  ),
);
